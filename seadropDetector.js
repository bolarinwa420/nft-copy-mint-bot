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

const MAX_SMART_ALERTS  = 3;  // max smart-money alerts per contract
const VELOCITY_THRESHOLD = 10; // unique wallets in window to trigger trending alert
const VELOCITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TREND_ALERTS  = 1;  // fire trending alert only once per contract

// velocity tracker: contract → { wallets: Set, firstMintAt }
const velocity = new Map();
// contracts that already fired a trending alert
const trendAlerted = new Set();

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

function trackVelocity(contract, minter) {
  const now = Date.now();
  if (!velocity.has(contract)) {
    velocity.set(contract, { wallets: new Set(), firstMintAt: now });
  }
  const entry = velocity.get(contract);
  if (now - entry.firstMintAt > VELOCITY_WINDOW_MS) {
    entry.wallets = new Set();
    entry.firstMintAt = now;
  }
  entry.wallets.add(minter.toLowerCase());
  return entry.wallets.size;
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

        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "uint256", "uint256", "uint256", "uint256"],
          log.data
        );
        const unitMintPrice = decoded[2];
        const priceStr = unitMintPrice === 0n
          ? "FREE"
          : `${Number(ethers.formatEther(unitMintPrice)).toFixed(4)} ETH`;

        // ── Smart money signal ───────────────────────────────────────────────
        const tracked   = getTracked();
        const whaleLabel = getWhaleLabel(minterLow);
        const isWhale   = tracked.includes(minterLow);

        if (isWhale) {
          const alertCount = getSeadropAlertCount(`smart_${ca}`);
          if (alertCount < MAX_SMART_ALERTS) {
            await incrementSeadropAlertCount(`smart_${ca}`);
            const name = (await getCollectionName(nftContract)) || "Unknown Collection";
            console.log(`[SeadropDetector] 🚨 Smart money: ${minterLow} minted ${name}`);

            await storedNotifyFn(
              `🚨 *Smart Money SeaDrop!*\n\n` +
              (whaleLabel ? `${whaleLabel}\n` : ``) +
              `*${name}*\n` +
              `\`${nftContract}\`\n\n` +
              `Whale: \`${minter.slice(0,6)}...${minter.slice(-4)}\`\n` +
              `Price: *${priceStr}*\n` +
              `Status: 🟢 Live Now\n\n` +
              `[OpenSea](https://opensea.io/assets/ethereum/${nftContract}) | [Etherscan](https://etherscan.io/address/${nftContract})`,
              null,
              "Markdown"
            );
          }
        }

        // ── Velocity / trending signal ───────────────────────────────────────
        const uniqueCount = trackVelocity(ca, minterLow);

        if (uniqueCount >= VELOCITY_THRESHOLD && !trendAlerted.has(ca)) {
          trendAlerted.add(ca);
          const name = (await getCollectionName(nftContract)) || "Unknown Collection";
          console.log(`[SeadropDetector] 📊 Trending: ${name} — ${uniqueCount} unique minters in 10min`);

          await storedNotifyFn(
            `📊 *Trending SeaDrop!*\n\n` +
            `*${name}*\n` +
            `\`${nftContract}\`\n\n` +
            `${uniqueCount}+ unique wallets minted in the last 10 min\n` +
            `Price: *${priceStr}*\n` +
            `Status: 🟢 Live Now\n\n` +
            `[OpenSea](https://opensea.io/assets/ethereum/${nftContract}) | [Etherscan](https://etherscan.io/address/${nftContract})`,
            null,
            "Markdown"
          );
        }

      } catch (e) {
        console.error("[SeadropDetector] Error:", e.message);
      }
    }
  );

  console.log("[SeadropDetector] Listening — smart money + velocity filters active");
}

export function initSeadropDetector(notifyFn) {
  storedNotifyFn = notifyFn;

  tmaEvents.on("wsRestarted", () => {
    console.log("[SeadropDetector] WebSocket restarted — re-registering listener");
    startSeadropDetection();
  });

  startSeadropDetection();
}
