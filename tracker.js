import { Alchemy, Network, AlchemySubscription } from "alchemy-sdk";
import { EventEmitter } from "events";
import { getTracked } from "./storage.js";

// Known mint function selectors
const MINT_SELECTORS = new Set([
  "0xa0712d68", // mint(uint256)
  "0x1249c58b", // mint()
  "0x6a627842", // mintTo(address)
  "0x40c10f19", // mint(address,uint256)
  "0x26092b83", // SeaDrop mintPublic
  "0x9dbb844d", // Zora mint
  "0xefef39a1", // mintEdition(uint256)
  "0xd85d3d27", // safeMint
  "0xa22cb465", // some manifold mints
  "0x84bb1e42", // mintPublic (various)
]);

export const mintEvents = new EventEmitter();

let alchemy;
let activeSubscription = null;

export function initTracker(apiKey) {
  alchemy = new Alchemy({
    apiKey,
    network: Network.ETH_MAINNET,
  });
  console.log("[Tracker] Alchemy SDK initialized");
}

function isMintTx(tx) {
  if (!tx.input || tx.input === "0x") return false;
  const selector = tx.input.slice(0, 10).toLowerCase();
  return MINT_SELECTORS.has(selector);
}

export async function startTracking() {
  const tracked = getTracked();
  if (tracked.length === 0) {
    console.log("[Tracker] No addresses to track");
    return;
  }

  // Cancel existing subscription
  if (activeSubscription) {
    alchemy.ws.removeAllListeners();
    activeSubscription = null;
  }

  console.log(`[Tracker] Watching ${tracked.length} whale wallet(s)...`);

  // Subscribe to mined transactions FROM tracked addresses
  alchemy.ws.on(
    {
      method: AlchemySubscription.MINED_TRANSACTIONS,
      addresses: tracked.map(a => ({ from: a })),
      includeRemoved: false,
      hashesOnly: false,
    },
    (tx) => {
      const transaction = tx.transaction;
      if (!transaction) return;

      const from = transaction.from?.toLowerCase();
      if (!tracked.includes(from)) return;
      if (!transaction.to) return; // contract deploy, skip

      if (isMintTx(transaction)) {
        console.log(`[Tracker] Whale mint detected from ${from} → ${transaction.to}`);
        mintEvents.emit("mintDetected", {
          whale: from,
          contract: transaction.to,
          tx: transaction,
        });
      }
    }
  );

  activeSubscription = true;
}

export function getAlchemy() {
  return alchemy;
}

export async function restartTracking() {
  if (activeSubscription) {
    alchemy.ws.removeAllListeners();
    activeSubscription = null;
  }
  await startTracking();
}
