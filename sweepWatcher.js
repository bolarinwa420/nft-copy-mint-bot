import { ethers } from "ethers";
import { getSweepWatchers, updateSweepWatcher } from "./storage.js";

const POLL_INTERVAL   = 2 * 60 * 1000;  // 2 min
const SWEEP_WINDOW    = 5 * 60 * 1000;  // rolling 5-min window
const COOLDOWN        = 30 * 60 * 1000; // re-alert max once per 30 min per (wallet+collection)

// Standard Transfer topics — no Alchemy needed
const ERC721_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC1155_SINGLE  = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://ethereum.publicnode.com");

function padAddress(addr) {
  return "0x" + addr.replace("0x", "").toLowerCase().padStart(64, "0");
}

// windowData: Map<walletAddr, Map<nftContract, [{txHash, timestamp}]>>
const windowData = new Map();
// cooldowns: Map<"wallet:nftContract", lastFiredAt>
const cooldowns = new Map();

let notifyFn;

export function initSweepWatcher(notify) {
  notifyFn = notify;
  poll().catch(console.error);
  setInterval(() => poll().catch(console.error), POLL_INTERVAL);
  console.log("[SweepWatcher] Polling started (eth_getLogs, 2 min interval)");
}

// publicnode (and most public RPCs) cap eth_getLogs at 50000 blocks per query.
const MAX_BLOCK_RANGE = 45000;

async function getTransfersSince(wallet, fromBlock, toBlock) {
  const paddedTo = padAddress(wallet);

  const [erc721Logs, erc1155Logs] = await Promise.all([
    provider.getLogs({
      topics: [ERC721_TRANSFER, null, paddedTo],
      fromBlock,
      toBlock,
    }),
    provider.getLogs({
      topics: [ERC1155_SINGLE, null, null, paddedTo],
      fromBlock,
      toBlock,
    }),
  ]);

  return [...erc721Logs, ...erc1155Logs].map(log => ({
    hash: log.transactionHash,
    blockNumber: log.blockNumber,
    contract: log.address.toLowerCase(),
    timestamp: Date.now(), // block was recent — good enough for 5-min window
  }));
}

async function poll() {
  const watchers = getSweepWatchers();
  if (!watchers.length) return;

  const now = Date.now();

  let latest;
  try {
    latest = await provider.getBlockNumber();
  } catch (err) {
    console.error(`[SweepWatcher] Could not get latest block: ${err.message}`);
    return;
  }

  for (const watcher of watchers) {
    const wallet    = watcher.wallet.toLowerCase();
    const threshold = watcher.threshold || 3;

    try {
      // Start from the stored cursor, but never request more than MAX_BLOCK_RANGE
      // (a stale/old cursor would otherwise blow past the RPC's getLogs limit and
      // fail forever, never advancing). Default to a recent window on first run.
      let fromBlock = watcher.lastBlock ? parseInt(watcher.lastBlock, 16) : latest - MAX_BLOCK_RANGE;
      if (fromBlock > latest) fromBlock = latest;
      if (latest - fromBlock > MAX_BLOCK_RANGE) fromBlock = latest - MAX_BLOCK_RANGE;

      const transfers = await getTransfersSince(wallet, fromBlock, latest);

      // Always advance the cursor to the block we just scanned through — even
      // when there were no transfers — so the range can never grow unbounded.
      await updateSweepWatcher(watcher.id, { lastBlock: "0x" + (latest + 1).toString(16) });

      if (!transfers.length) continue;

      // Add new transfers into rolling window
      if (!windowData.has(wallet)) windowData.set(wallet, new Map());
      const walletWindow = windowData.get(wallet);

      for (const tx of transfers) {
        if (!walletWindow.has(tx.contract)) walletWindow.set(tx.contract, []);
        walletWindow.get(tx.contract).push({ txHash: tx.hash, timestamp: tx.timestamp });
      }

      // Check each collection in the window
      for (const [nftContract, entries] of walletWindow.entries()) {
        const fresh = entries.filter(e => now - e.timestamp < SWEEP_WINDOW);
        if (!fresh.length) { walletWindow.delete(nftContract); continue; }
        walletWindow.set(nftContract, fresh);

        if (fresh.length >= threshold) {
          const cooldownKey = `${wallet}:${nftContract}`;
          const lastFired   = cooldowns.get(cooldownKey) || 0;
          if (now - lastFired >= COOLDOWN) {
            cooldowns.set(cooldownKey, now);
            await fireAlert(watcher, nftContract, fresh.length, fresh[fresh.length - 1].txHash);
            walletWindow.delete(nftContract);
          }
        }
      }
    } catch (err) {
      console.error(`[SweepWatcher] Error polling ${wallet}: ${err.message}`);
    }
  }
}

async function fireAlert(watcher, nftContract, count, txHash) {
  const name = watcher.name || watcher.wallet;
  await notifyFn(
    `🐋 *SWEEP ALERT — ${name}*\n\n` +
    `Collection: \`${nftContract}\`\n` +
    `NFTs swept: *${count}* in last 5 min\n\n` +
    `[Collection on OpenSea](https://opensea.io/assets/ethereum/${nftContract})\n` +
    `[${name} on OpenSea](https://opensea.io/${watcher.wallet})`,
    txHash,
    "Markdown"
  );
}
