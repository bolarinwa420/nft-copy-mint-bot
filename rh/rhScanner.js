// HTTP polling block scanner for Robinhood Chain.
// RH exposes HTTP RPC only (no public wss), so unlike the mainnet blockScanner
// (which uses a WebSocket subscription) this polls getBlockNumber and walks new
// blocks. On a match it calls the RH executor DIRECTLY — it never touches the
// shared mintEvents emitter, so the mainnet copymint handler can't see RH txs.
import { ethers } from "ethers";
import { RH_RPC_URL, RH_CHAIN_ID, RH_POLL_MS, isRhMintTx } from "./rhConfig.js";
import { getRhTracked, getRhSettings } from "./rhStore.js";
import { executeRhCopyMint } from "./rhCopymint.js";

let provider = null;
let lastBlock = 0;
let running = false;
let timer = null;
let scannedBlocks = 0;
let seenMints = 0;

// Cap how far back we walk on a single tick so a stall can't trigger a huge
// backfill that stampedes the RPC. Fresh boot starts from the current head.
const MAX_CATCHUP = 25;

export function getRhProvider() { return provider; }

export function rhScannerStatus() {
  return { lastBlock, scannedBlocks, seenMints, tracked: getRhTracked().length };
}

function normalize(tx) {
  return {
    hash:  tx.hash,
    from:  tx.from?.toLowerCase(),
    to:    tx.to?.toLowerCase(),
    value: tx.value?.toString() || "0",
    input: tx.data || "0x",
    data:  tx.data || "0x",
  };
}

async function processBlock(n, notify) {
  const block = await provider.getBlock(n, true);
  if (!block) return;
  const txs = block.prefetchedTransactions || [];
  scannedBlocks++;

  const tracked = new Set(getRhTracked().map(a => a.toLowerCase()));
  const catchAll = false; // RH intentionally has no catch-all; copy tracked whales only

  for (const tx of txs) {
    if (!tx?.from || !tx?.to) continue;
    const from = tx.from.toLowerCase();
    if (!tracked.has(from)) continue;
    if (!catchAll && !isRhMintTx(tx.data)) continue;

    seenMints++;
    const norm = normalize(tx);
    console.log(`[RH] Whale mint: ${from} → ${norm.to} (${norm.hash?.slice(0, 10)})`);
    // fire-and-forget so one slow mint doesn't stall block scanning
    executeRhCopyMint(norm, provider, notify).catch(e =>
      console.warn("[RH] executor error:", e.message)
    );
  }
}

async function tick(notify) {
  if (running) return;
  running = true;
  try {
    const head = await provider.getBlockNumber();
    if (!lastBlock) { lastBlock = head; return; }        // first tick: baseline only
    if (head <= lastBlock) return;

    let from = lastBlock + 1;
    if (head - from > MAX_CATCHUP) from = head - MAX_CATCHUP; // skip stale backlog
    for (let n = from; n <= head; n++) {
      try { await processBlock(n, notify); }
      catch (e) { console.warn(`[RH] block ${n} scan error:`, e.message); }
    }
    lastBlock = head;
  } catch (e) {
    console.warn("[RH] tick error:", e.message);
  } finally {
    running = false;
  }
}

export async function initRhScanner(notify) {
  provider = new ethers.JsonRpcProvider(
    RH_RPC_URL,
    ethers.Network.from(RH_CHAIN_ID),
    { staticNetwork: true } // stop eth_chainId polling against the single public RPC
  );
  const head = await provider.getBlockNumber();
  lastBlock = head;
  console.log(`[RH] Scanner live on chain ${RH_CHAIN_ID} @ block ${head} | ${getRhTracked().length} tracked | poll ${RH_POLL_MS}ms`);
  console.log(`[RH] Auto-mint ${getRhSettings().enabled ? "ENABLED" : "disabled"} | dryRun=${getRhSettings().dryRun}`);
  timer = setInterval(() => tick(notify), RH_POLL_MS);
  return provider;
}

export function stopRhScanner() { if (timer) clearInterval(timer); timer = null; }
