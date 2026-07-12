// Self-contained Robinhood Chain copy-mint executor.
// Replays a tracked whale's mint calldata from the shared 100 sub-wallets, but on
// the RH provider. Does NOT touch mainnet copymint.js: no Flashbots, no SeaDrop
// rewriting, no Infura sim. Uncopyable signature/voucher selectors are already
// filtered out upstream in rhConfig.isRhMintTx.
import { ethers } from "ethers";
import { getAllSigners } from "../wallets.js";
import { getRhSettings, logRhMint } from "./rhStore.js";
import { RH_EXPLORER_TX, RH_EXPLORER_ADDR } from "./rhConfig.js";
import { rhAdjustQuantity, decodeRhRevert } from "./rhQty.js";

// Batch sends so we don't hammer the RH RPC (which is a single public endpoint).
const BATCH = 10;

async function computeRhGas(provider, ceilingGwei) {
  let fee;
  try { fee = await provider.getFeeData(); } catch { fee = {}; }
  const ceiling = ethers.parseUnits(String(ceilingGwei), "gwei");
  // EIP-1559 if available, else legacy gasPrice. Clamp everything to the ceiling.
  if (fee.maxFeePerGas) {
    const tip = fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas < ceiling
      ? fee.maxPriorityFeePerGas : ethers.parseUnits("1", "gwei");
    const maxFee = fee.maxFeePerGas < ceiling ? fee.maxFeePerGas : ceiling;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip < maxFee ? tip : maxFee };
  }
  const gp = fee.gasPrice && fee.gasPrice < ceiling ? fee.gasPrice : ceiling;
  return { gasPrice: gp };
}

// The single entry point. `whaleTx` is the normalized tx from rhScanner.
export async function executeRhCopyMint(whaleTx, provider, notify) {
  const s = getRhSettings();
  if (!s.enabled) return;

  const to = whaleTx.to;
  const rawData = whaleTx.input || whaleTx.data;
  const rawValue = BigInt(whaleTx.value || "0");

  if (!s.allowFreeMints && rawValue === 0n) return;

  // ── Apply the USD-per-NFT quantity ladder (free→max, tiers, skip >$2) ──
  const adj = await rhAdjustQuantity(rawData, rawValue, provider);
  if (adj.skip) {
    await notify(
      `⏭️ *RH mint skipped — ${adj.reason}*\nWhale: \`${whaleTx.from}\`\nContract: \`${to}\`\n[whale tx](${RH_EXPLORER_TX}${whaleTx.hash})`,
      null
    );
    return;
  }
  const data = adj.data;
  const value = adj.value;           // adjusted per-wallet native value

  // Absolute per-wallet spend backstop (native token), independent of the ladder.
  const cap = ethers.parseEther(String(s.maxMintNative || "0"));
  if (cap > 0n && value > cap) {
    await notify(
      `⚠️ *RH mint skipped — over hard cap*\nPer-wallet ${ethers.formatEther(value)} > cap ${s.maxMintNative}\nContract: \`${to}\`\n[whale tx](${RH_EXPLORER_TX}${whaleTx.hash})`,
      null
    );
    return;
  }

  // Firing pool = [main wallet?] + 100 sub-wallets. walletCount slices from the top,
  // so with useMainWallet=true and walletCount=1 the ONLY wallet fired is main.
  let pool = getAllSigners(provider);
  if (s.useMainWallet && process.env.MAIN_PRIVATE_KEY) {
    try { pool = [new ethers.Wallet(process.env.MAIN_PRIVATE_KEY, provider), ...pool]; }
    catch (e) { console.warn("[RH] main wallet signer build failed:", e.message); }
  }
  const signers = pool.slice(0, Math.max(1, Math.min(s.walletCount || 100, pool.length)));
  if (!signers.length) {
    await notify("⚠️ *RH mint detected but no wallets loaded.* Import keys or enable main wallet.", null);
    return;
  }

  const gas = await computeRhGas(provider, s.gasCeilingGwei);
  // Free-ness is decided by the CURRENT on-chain drop price, not by what the whale paid.
  const isFree = adj.isFree ?? rawValue === 0n;

  // ── Calibrate the quantity ONCE against the first wallet ──
  // A revert at the target qty usually means a per-wallet/stage cap we couldn't
  // read, not a dead drop — so step down instead of throwing the mint away.
  // Bonus: one calibration beats 100 identical sims, so we fire sooner too.
  const probe = signers[0];
  const probeFrom = await probe.getAddress();
  const candidates = qtyLadder(adj);
  let fireData = data, fireValue = value, fireQty = adj.newQty, lastRevert = null, calibrated = false;

  for (const qty of candidates) {
    const built = adj.reencode ? adj.reencode(qty) : { data, value };
    if (perWalletCapExceeded(built.value, s)) { lastRevert = `over hard cap at qty ${qty}`; continue; }
    try {
      await provider.call({ to, data: built.data, value: built.value, from: probeFrom, ...gas });
      fireData = built.data; fireValue = built.value; fireQty = qty; calibrated = true;
      break;
    } catch (e) {
      lastRevert = decodeRhRevert(e);
    }
  }

  if (!calibrated && candidates.length) {
    // Every quantity reverts → the drop itself is unmintable for us (sold out,
    // not started, allowlist-only…). Say WHY instead of a silent skip.
    await notify(
      `🔴 *RH mint skipped — every qty reverts*\n` +
      `Whale: \`${whaleTx.from}\`\n` +
      `Contract: \`${to}\`\n` +
      `Tried: ${candidates.join(", ")}\n` +
      `Reason: \`${lastRevert}\`\n` +
      `[whale tx](${RH_EXPLORER_TX}${whaleTx.hash}) · [contract](${RH_EXPLORER_ADDR}${to})`,
      null
    );
    return;
  }

  const pricePerNft = fireQty ? fireValue / BigInt(fireQty) : fireValue;
  const src = adj.priceSource === "onchain" ? " ⛓" : "";
  const priceStr = isFree
    ? `FREE${src}${rawValue > 0n ? " — whale paid, drop is free NOW" : ""}`
    : `$${(adj.priceUsd || 0).toFixed(3)}/NFT (${(+ethers.formatEther(pricePerNft)).toFixed(5)} native)${src}`;
  const qtyStr = fireQty != null
    ? `${fireQty}/wallet${adj.originalQty && adj.originalQty !== fireQty ? ` (whale did ${adj.originalQty})` : ""}` +
      (fireQty !== adj.newQty ? ` — backed off from ${adj.newQty}: \`${lastRevert}\`` : "")
    : `whale's qty (unparsed)`;

  // Fire-and-forget the alert: awaiting Telegram here put ~300ms of network
  // latency between detection and broadcast, and speed is the whole game on RH.
  notify(
    `🟣 *RH WHALE MINT DETECTED*\n` +
    `Whale: \`${whaleTx.from}\`\n` +
    `Contract: \`${to}\`\n` +
    `Price: ${priceStr}\n` +
    `Minting: *${qtyStr}*\n` +
    `Firing from ${signers.length} wallet(s)${s.dryRun ? " — 🧪 DRY RUN (sim only)" : ""}\n` +
    `[whale tx](${RH_EXPLORER_TX}${whaleTx.hash}) · [contract](${RH_EXPLORER_ADDR}${to})`,
    null
  ).catch(() => {});

  if (s.dryRun) {
    await notify(
      `🧪 *RH DRY RUN complete*\n✅ would-succeed at qty ${fireQty} (calibrated on \`${probeFrom}\`)\n` +
      `Contract: \`${to}\``,
      null
    );
    return;
  }

  let reverted = 0, failed = 0, sent = 0;
  let firstHash = null;
  const revertReasons = new Map();

  for (let i = 0; i < signers.length; i += BATCH) {
    const chunk = signers.slice(i, i + BATCH);
    await Promise.allSettled(chunk.map(async (signer) => {
      const from = await signer.getAddress();
      const txReq = { to, data: fireData, value: fireValue, ...gas };

      // Per-wallet sim still runs — the calibrated qty proves the DROP is mintable,
      // but each wallet has its own balance and its own minted-count on the contract.
      try {
        await provider.call({ ...txReq, from });
      } catch (e) {
        reverted++;
        const r = decodeRhRevert(e);
        revertReasons.set(r, (revertReasons.get(r) || 0) + 1);
        return;
      }

      try {
        const resp = await signer.sendTransaction(txReq);
        sent++;
        if (!firstHash) firstHash = resp.hash;
        await logRhMint({ contract: to, wallet: from, txHash: resp.hash, valueNative: fireValue.toString() });
      } catch (e) {
        failed++;
        const r = decodeRhRevert(e);
        revertReasons.set(r, (revertReasons.get(r) || 0) + 1);
      }
    }));
  }

  const why = [...revertReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([r, n]) => `• \`${r}\` ×${n}`)
    .join("\n");

  const summary =
    `🟣 *RH copy-mint complete*\n` +
    `✅ sent: ${sent} (${fireQty}/wallet)\n` +
    `🔴 reverted (skipped): ${reverted}\n` +
    `⚠️ send-fail: ${failed}` +
    (why ? `\n\n*Why they failed:*\n${why}` : "") +
    (firstHash ? `\n\n[first tx](${RH_EXPLORER_TX}${firstHash})` : "");
  await notify(summary + `\nContract: \`${to}\``, null);
}

// Descending quantities to try, target first. Whale's own qty is a strong signal
// (they presumably know the cap), so it sits right behind our target.
function qtyLadder(adj) {
  if (adj.newQty == null || !adj.reencode) return [];
  const target = adj.newQty;
  const steps = [target, adj.originalQty, 5, 3, 2, 1]
    .filter((q) => Number.isInteger(q) && q >= 1 && q <= target);
  return [...new Set(steps)].sort((a, b) => b - a);
}

function perWalletCapExceeded(value, s) {
  const cap = ethers.parseEther(String(s.maxMintNative || "0"));
  return cap > 0n && value > cap;
}
