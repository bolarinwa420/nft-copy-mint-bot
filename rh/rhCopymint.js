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
import { diagnoseAndReplicate } from "./rhReplicate.js";

// Batch sends so we don't hammer the RH RPC (which is a single public endpoint).
const BATCH = 10;

// NEVER put a gas-price field in an RH eth_call without also pinning gasLimit.
// The RH node then fails the call with an EMPTY revert ("missing revert data"),
// even for a call that succeeds cleanly with no gas fields at all. That poisoned
// our own sim gate and made us skip Robinhood Kong (0xd2d378c5…), a mint the
// probe wallet could have taken. A simulation doesn't need a gas price anyway —
// so don't send one.
function simulate(provider, { to, data, value, from }) {
  return provider.call({ to, data, value, from });
}

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
  // For SeaDrop, `to` is the router — the real collection is decoded from calldata.
  // Log + report the collection, never the router.
  const nftAddr = adj.nft || to;

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
  let gasLimit = null;

  // Sim the whole ladder at once and take the highest quantity that passes — a
  // free mint now starts from the ceiling, and walking 8 steps one by one would
  // cost seconds on a 1-per-wallet drop.
  const probes = await Promise.all(candidates.map(async (qty) => {
    const built = adj.reencode ? adj.reencode(qty) : { data, value };
    if (perWalletCapExceeded(built.value, s)) return { qty, ok: false, why: `over hard cap at qty ${qty}` };
    try {
      await simulate(provider, { to, data: built.data, value: built.value, from: probeFrom });
      return { qty, ok: true, built };
    } catch (e) {
      return { qty, ok: false, why: decodeRhRevert(e) };
    }
  }));
  const best = probes.find((p) => p.ok);   // candidates are sorted high → low
  if (best) {
    fireData = best.built.data; fireValue = best.built.value; fireQty = best.qty; calibrated = true;
    lastRevert = probes.find((p) => !p.ok && p.qty > best.qty)?.why ?? null;
  } else {
    lastRevert = probes[probes.length - 1]?.why ?? null;
  }

  // Estimate the limit ONCE off the calibrated call. Sends must carry an explicit
  // gasLimit — see simulate() for why letting the node infer it is a trap here.
  if (calibrated) {
    try {
      const est = await provider.estimateGas({ to, data: fireData, value: fireValue, from: probeFrom });
      gasLimit = (est * 130n) / 100n;
    } catch { gasLimit = 500000n; }
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
    // The whale got through and we can't — find out what they did differently,
    // and whether the main wallet could repeat it.
    diagnoseAndReplicate({ whaleTx, nft: nftAddr, revert: lastRevert }, provider, notify, s.prereqCapUsd);
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
  // Name lookup is an extra RPC round trip — resolve it OFF the hot path and let
  // the alert catch up. Broadcasting must never wait on Telegram cosmetics.
  getCollectionName(provider, nftAddr).then((detectedName) =>
    notify(
      `🟣 *RH WHALE MINT DETECTED*\n` +
      (detectedName ? `🎨 *${detectedName}*\n` : "") +
      `Whale: \`${whaleTx.from}\`\n` +
      `Contract: \`${nftAddr}\`\n` +
      `Price: ${priceStr}\n` +
      `Minting: *${qtyStr}*\n` +
      `Firing from ${signers.length} wallet(s)${s.dryRun ? " — 🧪 DRY RUN (sim only)" : ""}\n` +
      `[whale tx](${RH_EXPLORER_TX}${whaleTx.hash}) · [contract](${RH_EXPLORER_ADDR}${nftAddr})`,
      null
    )
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
  const pending = [];

  for (let i = 0; i < signers.length; i += BATCH) {
    const chunk = signers.slice(i, i + BATCH);
    await Promise.allSettled(chunk.map(async (signer) => {
      const from = await signer.getAddress();
      const txReq = { to, data: fireData, value: fireValue, ...gas, ...(gasLimit ? { gasLimit } : {}) };

      // Per-wallet sim still runs — the calibrated qty proves the DROP is mintable,
      // but each wallet has its own balance and its own minted-count on the contract.
      try {
        await simulate(provider, { to, data: fireData, value: fireValue, from });
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
        pending.push({ from, resp });
        await logRhMint({ contract: nftAddr, wallet: from, txHash: resp.hash, valueNative: fireValue.toString() });
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

  if (!sent) {
    await notify(
      `🟣 *RH copy-mint — nothing sent*\n` +
      `🔴 reverted (skipped): ${reverted}\n⚠️ send-fail: ${failed}` +
      (why ? `\n\n*Why:*\n${why}` : "") +
      `\nContract: \`${nftAddr}\``,
      null
    );
    // Every wallet reverting in simulation is the same question as above. A pure
    // send failure (no gas, RPC error) is not — the whale did nothing special.
    if (reverted && !failed) {
      const top = [...revertReasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      diagnoseAndReplicate({ whaleTx, nft: nftAddr, revert: top }, provider, notify, s.prereqCapUsd);
    }
    return;
  }

  // "sent" only means broadcast. Wait for receipts so the alert reports what was
  // actually MINTED, and count the tokens we really received from the mint logs.
  const name = await getCollectionName(provider, nftAddr);
  const label = name ? `*${name}*` : `\`${nftAddr}\``;
  let confirmed = 0, onchainFail = 0, tokens = 0;

  const settled = await Promise.allSettled(
    pending.map(async ({ from, resp }) => {
      const rcpt = await withTimeout(resp.wait(1), RECEIPT_TIMEOUT_MS);
      return { from, rcpt };
    })
  );
  for (const r of settled) {
    if (r.status !== "fulfilled" || !r.value.rcpt) continue;
    const { from, rcpt } = r.value;
    if (rcpt.status === 1) { confirmed++; tokens += countMinted(rcpt, from); }
    else onchainFail++;
  }

  const summary =
    (confirmed
      ? `✅ *${name || "Mint"} ×${tokens || confirmed * (fireQty || 1)} minted successfully*\n\n`
      : `🟣 *RH copy-mint complete*\n\n`) +
    `🎨 Collection: ${label}\n` +
    `📦 Minted: *${tokens || "?"}* NFTs across ${confirmed} wallet(s) (${fireQty}/wallet)\n` +
    `🚀 broadcast: ${sent}` +
    (onchainFail ? `\n💥 failed on-chain: ${onchainFail}` : "") +
    (reverted ? `\n🔴 reverted (skipped): ${reverted}` : "") +
    (failed ? `\n⚠️ send-fail: ${failed}` : "") +
    (why ? `\n\n*Why they failed:*\n${why}` : "") +
    `\n\nContract: \`${nftAddr}\`` +
    (firstHash ? `\n[first tx](${RH_EXPLORER_TX}${firstHash}) · ` : "\n") +
    `[contract](${RH_EXPLORER_ADDR}${nftAddr})`;
  await notify(summary, null);
}

const RECEIPT_TIMEOUT_MS = 45_000;
const ERC721_TRANSFER = ethers.id("Transfer(address,address,uint256)");
const ERC1155_SINGLE = ethers.id("TransferSingle(address,address,address,uint256,uint256)");

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((res) => setTimeout(() => res(null), ms))]);
}

// Count tokens the wallet actually received in this tx — mint logs are transfers
// FROM the zero address TO us. Beats trusting the qty we asked for.
function countMinted(rcpt, to) {
  const me = to.toLowerCase();
  const zero = "0x" + "0".repeat(64);
  const pad = (a) => "0x" + a.toLowerCase().replace("0x", "").padStart(64, "0");
  let n = 0;
  for (const log of rcpt.logs || []) {
    if (log.topics[0] === ERC721_TRANSFER && log.topics.length === 4) {
      if (log.topics[1] === zero && log.topics[2] === pad(me)) n++;
    } else if (log.topics[0] === ERC1155_SINGLE && log.topics.length === 4) {
      if (log.topics[2] === zero && log.topics[3] === pad(me)) {
        try { n += Number(ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], log.data)[1]); } catch { n++; }
      }
    }
  }
  return n;
}

const nameCache = new Map();
async function getCollectionName(provider, addr) {
  const k = addr.toLowerCase();
  if (nameCache.has(k)) return nameCache.get(k);
  let name = null;
  try {
    const c = new ethers.Contract(addr, ["function name() view returns (string)"], provider);
    name = await c.name();
  } catch {}
  nameCache.set(k, name);
  return name;
}

// Descending quantities to try, target first. Whale's own qty is a strong signal
// (they presumably know the cap), so it sits right behind our target.
function qtyLadder(adj) {
  if (adj.newQty == null || !adj.reencode) return [];
  const target = adj.newQty;
  const steps = [target, adj.originalQty, 20, 10, 5, 3, 2, 1]
    .filter((q) => Number.isInteger(q) && q >= 1 && q <= target);
  return [...new Set(steps)].sort((a, b) => b - a);
}

function perWalletCapExceeded(value, s) {
  const cap = ethers.parseEther(String(s.maxMintNative || "0"));
  return cap > 0n && value > cap;
}
