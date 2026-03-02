import { ethers } from "ethers";
import { getWatches, deactivateWatch } from "./storage.js";
import { executeManualMint } from "./copymint.js";

const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
const POLL_INTERVAL = 30_000; // 30 seconds

const SEADROP_ABI = [
  "function getPublicDrop(address nftContract) external view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
];

let provider;
let notifyFn;
let seadropContract;

export function initWatcher(ethProvider, notify) {
  provider = ethProvider;
  notifyFn = notify;
  seadropContract = new ethers.Contract(SEADROP_ADDRESS, SEADROP_ABI, provider);
  console.log("[Watcher] Drop watcher initialized");
}

export function startWatcher() {
  setInterval(checkWatches, POLL_INTERVAL);
  console.log("[Watcher] Polling every 30s for live drops...");
}

export function buildMintPublicCalldata(nftContract) {
  const iface = new ethers.Interface([
    "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)",
  ]);
  return iface.encodeFunctionData("mintPublic", [
    nftContract,
    OPENSEA_FEE_RECIPIENT,
    ethers.ZeroAddress,
    1,
  ]);
}

async function checkWatches() {
  const watches = getWatches().filter((w) => w.active);
  if (watches.length === 0) return;

  for (const watch of watches) {
    try {
      const drop = await seadropContract.getPublicDrop(watch.nftContract);
      const now = Math.floor(Date.now() / 1000);
      const startTime = Number(drop.startTime);
      const endTime = Number(drop.endTime);
      const maxMintable = Number(drop.maxTotalMintableByWallet);

      console.log(
        `[Watcher] ${watch.nftContract} — startTime=${startTime} endTime=${endTime} maxMintable=${maxMintable} now=${now}`
      );

      if (startTime > 0 && startTime <= now && now <= endTime && maxMintable > 0) {
        const priceEth = ethers.formatEther(drop.mintPrice);
        const target = watch.group ? `group *${watch.group}*` : "all wallets";

        await notifyFn(
          `🚨 *Drop is LIVE — Auto-minting now!*\n\n` +
          `Contract: \`${watch.nftContract}\`\n` +
          `Price: ${priceEth} ETH\n` +
          `Wallets: ${target}\n\n` +
          `_Firing transactions..._`
        );

        // Mark inactive before firing to prevent double-fire
        await deactivateWatch(watch.id);

        const calldata = watch.calldata || buildMintPublicCalldata(watch.nftContract);

        const { succeeded, failed, skipped } = await executeManualMint(
          SEADROP_ADDRESS,
          calldata,
          "0",
          watch.group || null
        );

        await notifyFn(
          `✅ *Auto-Mint Complete!*\n\n` +
          `✅ Succeeded: ${succeeded}\n` +
          `❌ Failed: ${failed}\n` +
          `⏭️ Skipped (low balance): ${skipped}`
        );
      }
    } catch (err) {
      console.error(`[Watcher] Error checking ${watch.nftContract}:`, err.message);
    }
  }
}
