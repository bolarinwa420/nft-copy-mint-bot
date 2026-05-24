import { ethers } from "ethers";
import { tmaEvents } from "./tracker.js";
import { getSeadropAlertCount, incrementSeadropAlertCount, getTracked } from "./storage.js";
import { getWhaleLabel } from "./whale-meta.js";

const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const SEADROP_MINT_TOPIC = ethers.id(
  "SeaDropMint(address,address,address,address,uint256,uint256,uint256,uint256)"
);

const WS_URL = "wss://ethereum.publicnode.com";
const STALE_MS = 10 * 60 * 1000; // reconnect if silent for 10 min
const MAX_SMART_ALERTS = 3;

let storedNotifyFn;
let wsProvider = null;
let lastLogAt = Date.now();
let watchdogTimer = null;

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

function attachListener(provider) {
  const filter = { address: SEADROP_ADDRESS, topics: [SEADROP_MINT_TOPIC] };
  provider.on(filter, async (log) => {
    lastLogAt = Date.now();
    try {
      const nftContract = ethers.getAddress("0x" + log.topics[1].slice(26));
      const minter      = ethers.getAddress("0x" + log.topics[2].slice(26));
      const ca          = nftContract.toLowerCase();
      const minterLow   = minter.toLowerCase();

      const tracked = getTracked();
      if (!tracked.includes(minterLow)) return;

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
      console.log(`[SeadropDetector] Signal wallet: ${minterLow} minted ${name}`);

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
  });
}

async function connect() {
  if (wsProvider) {
    try { wsProvider.removeAllListeners(); wsProvider.destroy(); } catch (_) {}
    wsProvider = null;
  }

  wsProvider = new ethers.WebSocketProvider(WS_URL);

  wsProvider.websocket.on("error", (err) => {
    console.warn("[SeadropDetector] WS error:", err.message);
    reconnect();
  });

  wsProvider.websocket.on("close", (code) => {
    console.warn(`[SeadropDetector] WS closed (${code}) — reconnecting`);
    reconnect();
  });

  attachListener(wsProvider);
  lastLogAt = Date.now();
  console.log("[SeadropDetector] Listening — signal wallets only (publicnode.com WS)");
}

let reconnecting = false;
function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  setTimeout(async () => {
    try { await connect(); } catch (e) {
      console.error("[SeadropDetector] Reconnect failed:", e.message);
    }
    reconnecting = false;
  }, 5000);
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    const staleSec = Math.floor((Date.now() - lastLogAt) / 1000);
    if (Date.now() - lastLogAt > STALE_MS) {
      console.warn(`[SeadropDetector] Watchdog: no events in ${staleSec}s — reconnecting`);
      reconnect();
    } else {
      console.log(`[SeadropDetector] Watchdog OK — last event ${staleSec}s ago`);
    }
  }, 5 * 60 * 1000); // check every 5 min
}

export async function initSeadropDetector(notifyFn) {
  storedNotifyFn = notifyFn;

  // If Alchemy tracker fires wsRestarted, just log — our own WS is independent
  tmaEvents.on("wsRestarted", () => {
    console.log("[SeadropDetector] Alchemy wsRestarted event (own WS unaffected)");
  });

  await connect();
  startWatchdog();
}
