import { ethers } from "ethers";
import { mintEvents, tmaEvents } from "./tracker.js";
import { getTracked, getSettings } from "./storage.js";

const WS_URL = "wss://ethereum.publicnode.com";
const STALE_MS = 5 * 60 * 1000;

const TMA_WALLET = "0xdbd47f66aa2f00b3db03397f260ce9728298c495";

const MARKETPLACE_CONTRACTS = new Map([
  ["0x00000000000000adc04c56bf30ac9d3c0aaf14dc", "OpenSea (Seaport 1.5)"],
  ["0x00000000000001ad428e4906ae43d8f9852d0dd6", "OpenSea (Seaport 1.4)"],
  ["0x0000000000000068f116a894984e2db1123eb395", "OpenSea (Seaport 1.6)"],
  ["0x000000000000ad05ccc4f10045630fb830b95127", "Blur"],
  ["0x0000000000a39bb272e79075ade125fd351887ac", "Blur Bid Pool"],
  ["0x0000000000e655fae4d56241588680f86e3b2377", "LooksRare v2"],
  ["0x74312363e45dcaba76c59ec49a13aa35017c8c9", "X2Y2"],
  ["0x9757f2d2b135150bbeb65308d4a91804107cd8d6", "Reservoir Router"],
]);

const MINT_SELECTORS = new Set([
  "0xa0712d68", "0x1249c58b", "0x6a627842", "0x40c10f19",
  "0x2db11544", "0x84bb1e42", "0xd96a094a", "0xd0def521",
  "0xe7572e43", "0x5eca0752", "0x488a7b25", "0x81012e40",
  "0x0c143a93", "0x4b5f1bd2", "0x8b83209b", "0xf3aaf5b7",
  "0x161ac21f", "0x4b61cd6f", "0x9dbb844d", "0xefef39a1",
  "0xd85d3d27", "0xfa7b9a7b", "0x57bc3d78",
]);

function isMintTx(input) {
  if (!input || input === "0x") return false;
  const settings = getSettings();
  if (settings.catchAll) return true;
  return MINT_SELECTORS.has(input.slice(0, 10).toLowerCase());
}

let wsProvider = null;
let lastBlockAt = Date.now();
let watchdogTimer = null;
let reconnecting = false;
let txsScanned = 0;
let blocksScanned = 0;

function processBlock(block) {
  if (!block) return;

  // ethers v6: block.transactions is an array of HASH STRINGS. The full tx
  // objects (with .from/.to/.data) live on block.prefetchedTransactions when
  // the block was fetched with prefetch=true. Iterating block.transactions
  // gives strings → tx.from is undefined → every mint silently skipped.
  let txs = [];
  try {
    txs = block.prefetchedTransactions || [];
  } catch (_) {
    txs = [];
  }
  // Fallback: some providers return full objects directly on .transactions
  if (!txs.length && Array.isArray(block.transactions) && typeof block.transactions[0] === "object") {
    txs = block.transactions;
  }
  if (!txs.length) return;

  const tracked = new Set(getTracked().map(a => a.toLowerCase()));
  lastBlockAt = Date.now();
  blocksScanned++;
  txsScanned += txs.length;

  for (const tx of txs) {
    if (!tx?.from || !tx?.to) continue;
    const from = tx.from.toLowerCase();
    const to   = tx.to.toLowerCase();

    const normalized = {
      hash:     tx.hash,
      from,
      to,
      value:    tx.value?.toString() || "0",
      input:    tx.data || "0x",
      data:     tx.data || "0x",
      gas:      tx.gasLimit?.toString(),
      gasPrice: tx.gasPrice?.toString(),
    };

    // TMA wallet — secondary market buy alerts
    if (from === TMA_WALLET) {
      const marketplace = MARKETPLACE_CONTRACTS.get(to);
      if (marketplace) {
        console.log(`[BlockScanner] TMA buy on ${marketplace} → ${tx.hash}`);
        tmaEvents.emit("tmaBuyDetected", { tx: normalized, marketplace });
      }
      continue;
    }

    if (!tracked.has(from)) continue;
    if (!isMintTx(tx.data)) continue;

    console.log(`[BlockScanner] Whale mint: ${from} → ${tx.to} (${tx.hash?.slice(0, 10)})`);
    mintEvents.emit("mintDetected", {
      whale:    from,
      contract: tx.to,
      tx:       normalized,
    });
  }
}

async function connect() {
  if (wsProvider) {
    try { wsProvider.removeAllListeners(); wsProvider.destroy(); } catch (_) {}
    wsProvider = null;
  }

  wsProvider = new ethers.WebSocketProvider(WS_URL);

  wsProvider.websocket.on("error", (err) => {
    console.warn("[BlockScanner] WS error:", err.message);
    scheduleReconnect();
  });

  wsProvider.websocket.on("close", (code) => {
    console.warn(`[BlockScanner] WS closed (${code}) — reconnecting`);
    scheduleReconnect();
  });

  // Subscribe to new block headers, then fetch each block with full txs
  wsProvider.on("block", async (blockNumber) => {
    try {
      const block = await wsProvider.getBlock(blockNumber, true);
      processBlock(block);
    } catch (e) {
      console.warn(`[BlockScanner] Block fetch error #${blockNumber}:`, e.message);
    }
  });

  lastBlockAt = Date.now();
  console.log("[BlockScanner] Listening for new blocks (publicnode.com WS)");
}

function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  setTimeout(async () => {
    try { await connect(); } catch (e) {
      console.error("[BlockScanner] Reconnect failed:", e.message);
    }
    reconnecting = false;
  }, 5000);
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    const staleSec = Math.floor((Date.now() - lastBlockAt) / 1000);
    if (Date.now() - lastBlockAt > STALE_MS) {
      console.warn(`[BlockScanner] Watchdog: no blocks in ${staleSec}s — reconnecting`);
      scheduleReconnect();
    } else {
      console.log(`[BlockScanner] Watchdog OK — last block ${staleSec}s ago, scanned ${blocksScanned} blocks / ${txsScanned} txs (tracking ${getTracked().length} whales)`);
    }
  }, 3 * 60 * 1000);
}

export async function initBlockScanner() {
  await connect();
  startWatchdog();
}
