import { Alchemy, Network, AlchemySubscription } from "alchemy-sdk";
import { ethers } from "ethers";
import { EventEmitter } from "events";
import { getTracked, getSettings } from "./storage.js";

// TMA wallet — notify on every secondary NFT buy (no copy-mint)
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

export const tmaEvents = new EventEmitter();

// Known mint function selectors
const MINT_SELECTORS = new Set([
  // ── Public mints ──────────────────────────────────────────────
  "0xa0712d68", // mint(uint256)
  "0x1249c58b", // mint()
  "0x6a627842", // mintTo(address)
  "0x40c10f19", // mint(address,uint256)
  "0x2db11544", // publicMint(uint256) — ERC721A style
  "0x84bb1e42", // mintPublic (various)
  "0xd96a094a", // purchase / buy
  "0xd0def521", // issue(address,uint256) — Manifold ERC1155
  // ── Allowlist / whitelist mints ───────────────────────────────
  "0xe7572e43", // allowlistMint (common custom contracts)
  "0x5eca0752", // whitelistMint
  "0x488a7b25", // mintWhitelist
  "0x81012e40", // mintAllowList
  "0x0c143a93", // allowlistMint variant
  "0x4b5f1bd2", // presaleMint
  "0x8b83209b", // presaleMint variant
  "0xf3aaf5b7", // mintPresale
  // ── Platform-specific ─────────────────────────────────────────
  "0x161ac21f", // SeaDrop mintPublic(address,address,address,uint256)
  "0x4b61cd6f", // SeaDrop mintSigned (guaranteed / server-signed drops)
  "0x9dbb844d", // Zora mint
  "0xefef39a1", // mintEdition(uint256)
  "0xd85d3d27", // safeMint
  "0xfa7b9a7b", // Manifold claim
  "0x57bc3d78", // Manifold claimTo
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
  startTMATracking();
}

function startTMATracking() {
  alchemy.ws.on(
    {
      method: AlchemySubscription.MINED_TRANSACTIONS,
      addresses: [{ from: TMA_WALLET }],
      includeRemoved: false,
      hashesOnly: false,
    },
    (tx) => {
      const transaction = tx.transaction;
      if (!transaction || !transaction.to) return;

      const toAddr = transaction.to.toLowerCase();
      const marketplace = MARKETPLACE_CONTRACTS.get(toAddr);

      if (marketplace) {
        console.log(`[TMA] Buy detected on ${marketplace} → ${transaction.hash}`);
        tmaEvents.emit("tmaBuyDetected", { tx: transaction, marketplace });
      } else if (isLikelyTMAMint(transaction)) {
        console.log(`[TMA] Direct mint detected → ${transaction.to} | ${transaction.hash}`);
        tmaEvents.emit("tmaBuyDetected", { tx: transaction, marketplace: `Direct Mint (${transaction.to.slice(0, 8)}...)` });
      }
    }
  );
  console.log(`[TMA] Watching ${TMA_WALLET} for secondary market buys`);
}

function isMintTx(tx) {
  if (!tx.input || tx.input === "0x") return false;
  const settings = getSettings();
  // Catch-all: fire on any contract call from the whale
  if (settings.catchAll) return true;
  const selector = tx.input.slice(0, 10).toLowerCase();
  return MINT_SELECTORS.has(selector);
}

// For TMA specifically: fire on any non-marketplace contract call that
// looks like a mint — known selector, has ETH value, or has calldata at all.
// We'd rather have a false positive than miss a TMA buy.
const SKIP_SELECTORS = new Set([
  "0xa22cb465", // setApprovalForAll
  "0x095ea7b3", // ERC20 approve
  "0x23b872dd", // transferFrom
  "0xa9059cbb", // ERC20 transfer
]);

function isLikelyTMAMint(tx) {
  if (!tx.input || tx.input === "0x") return false;
  const selector = tx.input.slice(0, 10).toLowerCase();
  if (SKIP_SELECTORS.has(selector)) return false;
  return true; // any other contract call from TMA = alert (better false positive than miss)
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
