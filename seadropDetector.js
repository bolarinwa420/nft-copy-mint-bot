import { ethers } from "ethers";
import { getAlchemy, tmaEvents } from "./tracker.js";
import { getSeadropAlertCount, incrementSeadropAlertCount, getTracked } from "./storage.js";
import { getWhaleLabel } from "./whale-meta.js";

const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const SEADROP_MINT_TOPIC = ethers.id(
  "SeaDropMint(address,address,address,address,uint256,uint256,uint256,uint256)"
);

// SeaDropMint event:
// topics[1] = nftContract (indexed)
// topics[2] = minter (indexed)
// topics[3] = feeRecipient (indexed)
// data      = payer, quantityMinted, unitMintPrice, feeBps, dropStageIndex

const MAX_SMART_ALERTS = 3; // max alerts per contract per whale

let storedNotifyFn;

const NAME_IFACE = new ethers.Interface(["function name() view returns (string)"]);
const freeProvider = new ethers.JsonRpcProvider("https://eth.llamarpc.com");

async function getCollectionName(contract) {
  try {
    const raw = await freeProvider.call({ to: contract, data: NAME_IFACE.encodeFunctionData("name") });
    return NAME_IFACE.decodeFunctionResult("name", raw)[0] || null;
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
        const nftContract = ethers.getAddress("0x" + log.topics[1].slice(26));
        const minter      = ethers.getAddress("0x" + log.topics[2].slice(26));
        const ca          = nftContract.toLowerCase();
        const minterLow   = minter.toLowerCase();

        const tracked  = getTracked();
        const isWhale  = tracked.includes(minterLow);
        if (!isWhale) return; // silence everything except tracked signal wallets

        const alertCount = getSeadropAlertCount(`smart_${ca}`);
        if (alertCount >= MAX_SMART_ALERTS) return;

        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "uint256", "uint256", "uint256", "uint256"],
          log.data
        );
        const unitMintPrice = decoded[2];
        const priceStr = unitMintPrice === 0n
          ? "FREE"
          : `${Number(ethers.formatEther(unitMintPrice)).toFixed(4)} ETH`;

        await incrementSeadropAlertCount(`smart_${ca}`);
        const whaleLabel = getWhaleLabel(minterLow);
        const name = (await getCollectionName(nftContract)) || "Unknown Collection";
        console.log(`[SeadropDetector] 🚨 Signal wallet: ${minterLow} minted ${name}`);

        await storedNotifyFn(
          `🚨 *Signal Wallet SeaDrop!*\n\n` +
          (whaleLabel ? `${whaleLabel}\n` : ``) +
          `*${name}*\n` +
          `\`${nftContract}\`\n\n` +
          `Wallet: \`${minter}\`\n` +
          `Price: *${priceStr}*\n` +
          `Status: 🟢 Live Now\n\n` +
          `[OpenSea](https://opensea.io/assets/ethereum/${nftContract}) | [Etherscan](https://etherscan.io/address/${nftContract})`,
          null,
          "Markdown"
        );

      } catch (e) {
        console.error("[SeadropDetector] Error:", e.message);
      }
    }
  );

  console.log("[SeadropDetector] Listening — signal wallets only (no velocity noise)");
}

export function initSeadropDetector(notifyFn) {
  storedNotifyFn = notifyFn;

  tmaEvents.on("wsRestarted", () => {
    console.log("[SeadropDetector] WebSocket restarted — re-registering listener");
    startSeadropDetection();
  });

  startSeadropDetection();
}
