// Self-contained Robinhood Chain copy-mint executor.
// Replays a tracked whale's mint calldata from the shared 100 sub-wallets, but on
// the RH provider. Does NOT touch mainnet copymint.js: no Flashbots, no SeaDrop
// rewriting, no Infura sim. Uncopyable signature/voucher selectors are already
// filtered out upstream in rhConfig.isRhMintTx.
import { ethers } from "ethers";
import { getAllSigners } from "../wallets.js";
import { getRhSettings, logRhMint } from "./rhStore.js";
import { RH_EXPLORER_TX, RH_EXPLORER_ADDR } from "./rhConfig.js";

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
  const data = whaleTx.input || whaleTx.data;
  const value = BigInt(whaleTx.value || "0");

  // Spend guardrail
  if (!s.allowFreeMints && value === 0n) return;
  const cap = ethers.parseEther(String(s.maxMintNative || "0"));
  if (cap > 0n && value > cap) {
    await notify(
      `⚠️ *RH mint skipped — over cap*\nWhale: \`${whaleTx.from}\`\nValue ${ethers.formatEther(value)} > cap ${s.maxMintNative}\n[whale tx](${RH_EXPLORER_TX}${whaleTx.hash})`,
      null
    );
    return;
  }

  const allSigners = getAllSigners(provider);
  const signers = allSigners.slice(0, Math.max(1, Math.min(s.walletCount || 100, allSigners.length)));
  if (!signers.length) {
    await notify("⚠️ *RH mint detected but no sub-wallets loaded.* Import keys first.", null);
    return;
  }

  const gas = await computeRhGas(provider, s.gasCeilingGwei);
  const priceStr = value === 0n ? "FREE" : `${ethers.formatEther(value)} native`;

  await notify(
    `🟣 *RH WHALE MINT DETECTED*\n` +
    `Whale: \`${whaleTx.from}\`\n` +
    `Contract: \`${to}\`\n` +
    `Price/wallet: ${priceStr}\n` +
    `Firing from ${signers.length} wallet(s)${s.dryRun ? " — 🧪 DRY RUN (sim only)" : ""}\n` +
    `[whale tx](${RH_EXPLORER_TX}${whaleTx.hash}) · [contract](${RH_EXPLORER_ADDR}${to})`,
    null
  );

  let ok = 0, reverted = 0, failed = 0, sent = 0;

  let firstHash = null;
  for (let i = 0; i < signers.length; i += BATCH) {
    const chunk = signers.slice(i, i + BATCH);
    await Promise.allSettled(chunk.map(async (signer) => {
      const from = await signer.getAddress();
      const txReq = { to, data, value, ...gas };

      // Simulation gate — zero-cost revert catch (proxy value=0, cap hit, closed sale…)
      try {
        await provider.call({ ...txReq, from });
      } catch {
        reverted++;
        return;
      }

      if (s.dryRun) { ok++; return; }

      try {
        const resp = await signer.sendTransaction(txReq);
        sent++;
        if (!firstHash) firstHash = resp.hash;
        await logRhMint({ contract: to, wallet: from, txHash: resp.hash, valueNative: value.toString() });
      } catch {
        failed++;
      }
    }));
  }

  const summary = s.dryRun
    ? `🧪 *RH DRY RUN complete*\n✅ would-succeed: ${ok}\n🔴 would-revert: ${reverted}`
    : `🟣 *RH copy-mint complete*\n✅ sent: ${sent}\n🔴 reverted (skipped): ${reverted}\n⚠️ send-fail: ${failed}` +
      (firstHash ? `\n[first tx](${RH_EXPLORER_TX}${firstHash})` : "");
  await notify(summary + `\nContract: \`${to}\``, null);
}
