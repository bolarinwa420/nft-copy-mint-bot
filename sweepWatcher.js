import { AssetTransfersCategory } from "alchemy-sdk";
import { getAlchemy } from "./tracker.js";
import { getSweepWatchers, updateSweepWatcher } from "./storage.js";

const POLL_INTERVAL = 30 * 1000;      // poll every 30 seconds
const SWEEP_WINDOW  = 5 * 60 * 1000;  // rolling 5-minute window
const COOLDOWN      = 30 * 60 * 1000; // re-alert max once per 30 min per (wallet+collection)

// windowData: Map<walletAddr, Map<nftContract, [{txHash, timestamp}]>>
const windowData = new Map();
// cooldowns: Map<"walletAddr:nftContract", lastFiredAt>
const cooldowns = new Map();

let notifyFn;

export function initSweepWatcher(notify) {
  notifyFn = notify;
  poll().catch(console.error);
  setInterval(() => poll().catch(console.error), POLL_INTERVAL);
  console.log("[SweepWatcher] Polling started (30s interval)");
}

async function poll() {
  const watchers = getSweepWatchers();
  if (watchers.length === 0) return;

  const alchemy = getAlchemy();
  const now = Date.now();

  for (const watcher of watchers) {
    const wallet    = watcher.wallet.toLowerCase();
    const threshold = watcher.threshold || 3;

    try {
      const result = await alchemy.core.getAssetTransfers({
        toAddress: wallet,
        category: [AssetTransfersCategory.ERC721, AssetTransfersCategory.ERC1155],
        fromBlock: watcher.lastBlock || "latest",
        withMetadata: true,
        maxCount: 100,
        order: "asc",
      });

      const transfers = result.transfers || [];
      if (transfers.length === 0) continue;

      // Advance the cursor to avoid re-processing
      const lastTx   = transfers[transfers.length - 1];
      const nextBlock = "0x" + (parseInt(lastTx.blockNum, 16) + 1).toString(16);
      await updateSweepWatcher(watcher.id, { lastBlock: nextBlock });

      // Add new transfers into rolling window
      if (!windowData.has(wallet)) windowData.set(wallet, new Map());
      const walletWindow = windowData.get(wallet);

      for (const tx of transfers) {
        const nftContract = tx.rawContract?.address?.toLowerCase();
        if (!nftContract) continue;

        const timestamp = tx.metadata?.blockTimestamp
          ? new Date(tx.metadata.blockTimestamp).getTime()
          : now;

        if (!walletWindow.has(nftContract)) walletWindow.set(nftContract, []);
        walletWindow.get(nftContract).push({ txHash: tx.hash, timestamp });
      }

      // Check each collection in the window
      for (const [nftContract, entries] of walletWindow.entries()) {
        // Drop entries older than sweep window
        const fresh = entries.filter(e => now - e.timestamp < SWEEP_WINDOW);
        if (fresh.length === 0) { walletWindow.delete(nftContract); continue; }
        walletWindow.set(nftContract, fresh);

        if (fresh.length >= threshold) {
          const cooldownKey = `${wallet}:${nftContract}`;
          const lastFired   = cooldowns.get(cooldownKey) || 0;

          if (now - lastFired >= COOLDOWN) {
            cooldowns.set(cooldownKey, now);
            // Most recent txHash for the etherscan button
            const latestTxHash = fresh[fresh.length - 1].txHash;
            await fireAlert(watcher, nftContract, fresh.length, latestTxHash);
            // Clear so it doesn't keep re-firing on same burst
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
  const name = watcher.name || shortAddr(watcher.wallet);
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

function shortAddr(addr) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}
