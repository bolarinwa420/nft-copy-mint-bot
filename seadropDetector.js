import { ethers } from "ethers";
import { getAlchemy, tmaEvents } from "./tracker.js";

const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const SEADROP_MINT_TOPIC = ethers.id(
  "SeaDropMint(address,address,address,address,uint256,uint256,uint256,uint256)"
);
const COOLDOWN = 60 * 60 * 1000; // alert once per hour per contract

// In-memory: contract -> timestamp last alerted
const lastAlerted = new Map();

let storedNotifyFn;

async function getCollectionName(contract) {
  try {
    const alchemy = getAlchemy();
    const meta = await alchemy.nft.getContractMetadata(contract);
    return meta?.name || null;
  } catch {
    return null;
  }
}

function startSeadropDetection() {
  const alchemy = getAlchemy();
  if (!alchemy) {
    console.error("[SeadropDetector] Alchemy not ready");
    return;
  }

  alchemy.ws.on(
    { address: SEADROP_ADDRESS, topics: [SEADROP_MINT_TOPIC] },
    async (log) => {
      try {
        // topics[1] = nftContract (indexed, padded to 32 bytes)
        const nftContract = ethers.getAddress("0x" + log.topics[1].slice(26));
        const ca = nftContract.toLowerCase();

        const now = Date.now();
        if (now - (lastAlerted.get(ca) || 0) < COOLDOWN) return;
        lastAlerted.set(ca, now);

        // data = abi.encode(address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "uint256", "uint256", "uint256", "uint256"],
          log.data
        );
        const unitMintPrice = decoded[2];
        const priceStr =
          unitMintPrice === 0n
            ? "FREE"
            : `${Number(ethers.formatEther(unitMintPrice)).toFixed(4)} ETH`;

        const name = (await getCollectionName(nftContract)) || "Unknown Collection";

        console.log(`[SeadropDetector] New drop: ${name} (${nftContract}) — ${priceStr}`);

        await storedNotifyFn(
          `🎯 *SeaDrop Drop Detected!*\n\n` +
            `*${name}*\n` +
            `\`${nftContract}\`\n\n` +
            `Price: *${priceStr}*\n` +
            `Status: 🟢 Live Now\n\n` +
            `[View on OpenSea](https://opensea.io/assets/ethereum/${nftContract}) | [Etherscan](https://etherscan.io/address/${nftContract})`,
          null,
          "Markdown"
        );
      } catch (e) {
        console.error("[SeadropDetector] Error:", e.message);
      }
    }
  );

  console.log("[SeadropDetector] Listening for SeaDrop mints...");
}

export function initSeadropDetector(notifyFn) {
  storedNotifyFn = notifyFn;

  // Re-register listener whenever tracker restarts WebSocket
  tmaEvents.on("wsRestarted", () => {
    console.log("[SeadropDetector] WebSocket restarted — re-registering listener");
    startSeadropDetection();
  });

  startSeadropDetection();
}
