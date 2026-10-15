// HTTP polling block scanner for Ink.
// Ink exposes HTTP RPC only (no public wss), so unlike the mainnet blockScanner
// (which uses a WebSocket subscription) this polls getBlockNumber and walks new
// blocks. On a match it calls the Ink executor DIRECTLY — it never touches the
// shared mintEvents emitter, so the mainnet copymint handler can't see Ink txs.
import { ethers } from "ethers";
import { INK_RPC_URL, INK_CHAIN_ID, INK_POLL_MS, isInkMintTx } from "./inkConfig.js";
import { getInkTracked, getInkSettings } from "./inkStore.js";
import { executeInkCopyMint } from "./inkCopymint.js";

let provider = null;
let lastBlock = 0;
let running = false;
let timer = null;
let scannedBlocks = 0;
let seenMints = 0;

// Cap how far back we walk on a single tick so a stall can't trigger a huge
// backfill that stampedes the RPC. Fresh boot starts from the current head.
const MAX_CATCHUP = 25;

export function getInkProvider() { return provider; }

export function inkScannerStatus() {
  return { lastBlock, scannedBlocks, seenMints, tracked: getInkTracked().length };
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

  const tracked = new Set(getInkTracked().map(a => a.toLowerCase()));
  const catchAll = false; // Ink intentionally has no catch-all; copy tracked whales only

  for (const tx of txs) {
    if (!tx?.from || !tx?.to) continue;
    const from = tx.from.toLowerCase();
    if (!tracked.has(from)) continue;
    if (!catchAll && !isInkMintTx(tx.data)) continue;

    seenMints++;
    const norm = normalize(tx);
    console.log(`[INK] Whale mint: ${from} → ${norm.to} (${norm.hash?.slice(0, 10)})`);
    // fire-and-forget so one slow mint doesn't stall block scanning
    executeInkCopyMint(norm, provider, notify).catch(e =>
      console.warn("[INK] executor error:", e.message)
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
      catch (e) { console.warn(`[INK] block ${n} scan error:`, e.message); }
    }
    lastBlock = head;
  } catch (e) {
    console.warn("[INK] tick error:", e.message);
  } finally {
    running = false;
  }
}

export async function initInkScanner(notify) {
  provider = new ethers.JsonRpcProvider(
    INK_RPC_URL,
    ethers.Network.from(INK_CHAIN_ID),
    { staticNetwork: true } // stop eth_chainId polling against the single public RPC
  );
  const head = await provider.getBlockNumber();
  lastBlock = head;
  console.log(`[INK] Scanner live on chain ${INK_CHAIN_ID} @ block ${head} | ${getInkTracked().length} tracked | poll ${INK_POLL_MS}ms`);
  console.log(`[INK] Auto-mint ${getInkSettings().enabled ? "ENABLED" : "disabled"} | dryRun=${getInkSettings().dryRun}`);
  timer = setInterval(() => tick(notify), INK_POLL_MS);
  return provider;
}

export function stopInkScanner() { if (timer) clearInterval(timer); timer = null; }
