import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { getSettings, logMint } from "./storage.js";
import { mintEvents, tmaEvents } from "./tracker.js";
import { getAllSigners, getGroupSigners } from "./wallets.js";
import { scanAvailableIds } from "./idScanner.js";
import { getWhaleLabel } from "./whale-meta.js";

const SEADROP_ADDRESS = "0x00005ea00ac477b1030ce78506496e8c2de24bf5";
const SEADROP_MINT_PUBLIC_SELECTOR = "0x161ac21f";
const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
const SEADROP_IFACE = new ethers.Interface([
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)",
]);

// Fix SeaDrop calldata so our wallet is both payer AND minter (avoids PayerNotAllowed)
function fixSeaDropCalldata(to, calldata) {
  if (
    to?.toLowerCase() === SEADROP_ADDRESS &&
    calldata?.slice(0, 10).toLowerCase() === SEADROP_MINT_PUBLIC_SELECTOR
  ) {
    try {
      const decoded = SEADROP_IFACE.decodeFunctionData("mintPublic", calldata);
      return SEADROP_IFACE.encodeFunctionData("mintPublic", [
        decoded.nftContract,
        decoded.feeRecipient || OPENSEA_FEE_RECIPIENT,
        ethers.ZeroAddress, // minterIfNotPayer = 0 → msg.sender is the minter
        decoded.quantity,
      ]);
    } catch (e) {
      console.warn("[CopyMint] SeaDrop calldata decode failed, using original:", e.message);
    }
  }
  return calldata;
}

let provider;
let mainSigner;
let flashbotsProvider;
let telegramNotify;
let telegramAskApproval;

const FLASHBOTS_RELAY = "https://relay.flashbots.net";
const MAX_BLOCKS_TO_TRY = 3;
const DEFAULT_SKIP_ABOVE_USD = 0.51;
const APPROVAL_TIMEOUT_MS = 120000;

const pendingApprovals = new Map();
const pendingIdSelections = new Map();
const processedTxHashes = new Set();

let telegramAskIdSelection = null;

export function setIdSelectionFn(fn) {
  telegramAskIdSelection = fn;
}

export function resolveIdSelection(mintId, tokenId) {
  const pending = pendingIdSelections.get(mintId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingIdSelections.delete(mintId);
  pending.resolve(tokenId);
  return true;
}

function waitForIdSelection(mintId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingIdSelections.delete(mintId);
      reject(new Error("timeout"));
    }, 120000);
    pendingIdSelections.set(mintId, { resolve, reject, timer });
  });
}

let cachedEthPrice = null;
let priceLastFetched = 0;

async function getEthUsdPrice() {
  const now = Date.now();
  if (cachedEthPrice && now - priceLastFetched < 60000) return cachedEthPrice;
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
    );
    const data = await res.json();
    cachedEthPrice = data.ethereum.usd;
    priceLastFetched = now;
    return cachedEthPrice;
  } catch {
    return cachedEthPrice || 2000;
  }
}

// For SeaDrop mints the actual NFT contract is in the calldata, not tx.to
function getNftContract(to, data) {
  if (to?.toLowerCase() === SEADROP_ADDRESS) {
    try {
      const decoded = SEADROP_IFACE.decodeFunctionData("mintPublic", data);
      return decoded.nftContract;
    } catch {}
  }
  return to;
}

const ERC721_ID  = "0x80ac58cd";
const ERC1155_ID = "0xd9b67a26";
const SUPPORTS_IFACE = new ethers.Interface([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
]);
const nftCheckCache = new Map();

async function isLikelyNFTContract(address) {
  const addr = address.toLowerCase();
  if (nftCheckCache.has(addr)) return nftCheckCache.get(addr);
  try {
    const code = await provider.getCode(address);
    if (!code || code === "0x") { nftCheckCache.set(addr, false); return false; }
    for (const id of [ERC721_ID, ERC1155_ID]) {
      try {
        const raw = await provider.call({
          to: address,
          data: SUPPORTS_IFACE.encodeFunctionData("supportsInterface", [id]),
        });
        if (raw && raw !== "0x") {
          const [ok] = SUPPORTS_IFACE.decodeFunctionResult("supportsInterface", raw);
          if (ok) { nftCheckCache.set(addr, true); return true; }
        }
      } catch {}
    }
  } catch {}
  nftCheckCache.set(addr, false);
  return false;
}

const collectionNameCache = new Map();
async function getCollectionName(contractAddress) {
  if (!contractAddress) return null;
  const addr = contractAddress.toLowerCase();
  if (collectionNameCache.has(addr)) return collectionNameCache.get(addr);
  try {
    const iface = new ethers.Interface(["function name() view returns (string)"]);
    const result = await provider.call({ to: contractAddress, data: iface.encodeFunctionData("name", []) });
    const [name] = iface.decodeFunctionResult("name", result);
    const trimmed = name?.trim() || null;
    collectionNameCache.set(addr, trimmed);
    return trimmed;
  } catch {
    collectionNameCache.set(addr, null);
    return null;
  }
}

// USD tiers: price per NFT → how many we mint
// < $0.15 → 3  |  $0.15–$0.29 → 2  |  $0.30–$0.51 → 1  |  > $0.51 → skip
function getTargetQty(priceUsdPerNft) {
  if (priceUsdPerNft < 0.15) return 3;
  if (priceUsdPerNft <= 0.29) return 2;
  return 1;
}

// Totally-free mints (0 ETH): take the MAX the contract will give a wallet. A
// readable cap is used directly; an unreadable one is found by simulating down a
// ladder from this ceiling (some caps are uint16-max = "unlimited", so there has
// to be one). Simulation, not guessing, is what keeps this from reverting.
const FREE_MINT_MAX = 50;
const FREE_QTY_LADDER = [20, 10, 5, 3, 2, 1];

// Check if the contract enforces a per-wallet limit. Runs all probes in parallel; cached.
const walletLimitCache = new Map();
async function checkMaxPerWallet(contractAddress) {
  const addr = contractAddress.toLowerCase();
  if (walletLimitCache.has(addr)) return walletLimitCache.get(addr);

  const names = [
    "maxPerWallet", "maxMintPerWallet", "maxPerAddress", "maxMintPerAddress",
    "walletLimit", "limitPerWallet", "MAX_PER_WALLET", "maxTokensPerWallet",
    "maxMintsPerWallet",
  ];

  const results = await Promise.allSettled(
    names.map(async (name) => {
      const iface = new ethers.Interface([`function ${name}() view returns (uint256)`]);
      const raw = await provider.call({
        to: contractAddress,
        data: iface.encodeFunctionData(name, []),
      });
      const [max] = iface.decodeFunctionResult(name, raw);
      if (max > 0n && max <= 20n) return Number(max);
      throw new Error("out of range");
    })
  );

  const hit = results.find((r) => r.status === "fulfilled");
  const limit = hit ? hit.value : null;
  walletLimitCache.set(addr, limit);
  return limit;
}

// SeaDrop stores the per-wallet cap on the ROUTER, not the NFT contract — so the
// getter probes above can never see it. getPublicDrop(nft).maxTotalMintableByWallet
// is the real cap. Returns null if not a SeaDrop drop / no public drop configured.
const SEADROP_DROP_IFACE = new ethers.Interface([
  "function getPublicDrop(address nftContract) view returns (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)",
]);
const seadropCapCache = new Map();
async function getSeadropWalletCap(nftContract) {
  const addr = nftContract.toLowerCase();
  if (seadropCapCache.has(addr)) return seadropCapCache.get(addr);
  let cap = null;
  try {
    const raw = await provider.call({
      to: SEADROP_ADDRESS,
      data: SEADROP_DROP_IFACE.encodeFunctionData("getPublicDrop", [nftContract]),
    });
    const d = SEADROP_DROP_IFACE.decodeFunctionResult("getPublicDrop", raw);
    const max = Number(d.maxTotalMintableByWallet);
    if (max > 0 && max <= 100000) cap = max;
  } catch {}
  seadropCapCache.set(addr, cap);
  return cap;
}

// ── Token-ID Collision Handling ───────────────────────────────────────────

const TOKEN_COLLISION_PATTERNS = [
  /already.?minted/i,
  /token.?already.?minted/i,
  /token.?exists/i,
  /already.?claimed/i,
  /already.?taken/i,
  /alreadyminted/i,
  /tokenalreadyminted/i,
  /tokenexists/i,
  /alreadyclaimed/i,
];

function isTokenCollisionRevert(msg) {
  if (!msg) return false;
  return TOKEN_COLLISION_PATTERNS.some((p) => p.test(msg));
}

// Decode first uint256 arg from calldata (after 4-byte selector)
function decodeTokenIdFromCalldata(data) {
  if (!data || data.length < 74) return null;
  try {
    return BigInt("0x" + data.slice(10, 74));
  } catch { return null; }
}

// Replace first uint256 param in calldata with newId
function reencodeWithTokenId(data, newId) {
  if (!data || data.length < 74) return data;
  return data.slice(0, 10) + newId.toString(16).padStart(64, "0") + data.slice(74);
}

const OWNER_OF_IFACE = new ethers.Interface([
  "function ownerOf(uint256 tokenId) view returns (address)",
]);

// ownerOf revert = unclaimed token (ERC721 standard)
async function isTokenFree(contractAddress, tokenId) {
  try {
    await provider.call({
      to: contractAddress,
      data: OWNER_OF_IFACE.encodeFunctionData("ownerOf", [tokenId]),
    });
    return false; // success = token is owned
  } catch {
    return true; // revert = doesn't exist = free
  }
}

// Scan in batches of 10 to find `count` unclaimed token IDs starting from startId
async function findFreeTokenIds(contractAddress, startId, count = 1, maxScan = 300) {
  const freeIds = [];
  const BATCH = 10;
  let cursor = startId;
  const limit = startId + BigInt(maxScan);

  while (freeIds.length < count && cursor < limit) {
    const batchIds = [];
    for (let i = 0; i < BATCH && cursor + BigInt(i) < limit; i++) {
      batchIds.push(cursor + BigInt(i));
    }
    cursor += BigInt(batchIds.length);

    const checks = await Promise.all(batchIds.map((id) => isTokenFree(contractAddress, id)));
    for (let i = 0; i < batchIds.length; i++) {
      if (checks[i]) {
        freeIds.push(batchIds[i]);
        if (freeIds.length >= count) break;
      }
    }
  }

  return freeIds;
}

// Gas limit for a copy: the whale's limit +20% covers anything up to their qty.
// Minting MORE than they did needs more gas — use the estimate taken at the
// calibrated qty, else scale the whale's limit by the qty ratio.
function pickGasLimit(whaleTx, adj) {
  const base = whaleTx.gas ? BigInt(Math.floor(Number(BigInt(whaleTx.gas)) * 1.2)) : 300000n;
  if (!adj?.originalQty || !adj?.newQty || adj.newQty <= adj.originalQty) return base;
  if (adj.gasEstimate) return (adj.gasEstimate * 130n) / 100n;
  return (base * BigInt(adj.newQty)) / BigInt(adj.originalQty);
}

// simFrom = the wallet to calibrate a free mint against (its own minted-count
// matters). Without it a free mint with an unreadable cap copies the whale's qty.
async function adjustMintQuantity(rawData, txValue, isFree, contractAddress = null, simFrom = null) {
  const data = rawData || "0x";
  const value = BigInt(txValue || 0);

  // ── Detect quantity + the real NFT contract from calldata ──
  let originalQty = null;
  let isSeaDrop = false;
  let seadropNft = null;

  if (data.slice(0, 10).toLowerCase() === SEADROP_MINT_PUBLIC_SELECTOR) {
    try {
      const decoded = SEADROP_IFACE.decodeFunctionData("mintPublic", data);
      originalQty = Number(decoded.quantity);
      seadropNft = decoded.nftContract;
      isSeaDrop = true;
    } catch {}
  }

  if (originalQty === null && data.length === 74) {
    const qty = parseInt(data.slice(10), 16);
    if (qty > 0 && qty <= 10000) originalQty = qty;
  }

  if (originalQty === null && data.length > 74 && (data.length - 10) % 64 === 0) {
    const lastWord = parseInt(data.slice(-64), 16);
    if (lastWord > 0 && lastWord <= 10000) originalQty = lastWord;
  }

  const effectiveQty = originalQty || 1;
  const pricePerNft = isFree ? 0n : value / BigInt(effectiveQty);

  // ── Resolve the per-wallet cap FIRST (this is the hard ceiling in every case) ──
  // SeaDrop keeps the cap on the router (getPublicDrop), keyed by the real NFT
  // contract — not whaleTx.to. Non-SeaDrop drops expose it via getter on the contract.
  let walletCap = null;
  if (isSeaDrop && seadropNft) walletCap = await getSeadropWalletCap(seadropNft);
  if (walletCap === null && contractAddress && !isSeaDrop) {
    walletCap = await checkMaxPerWallet(contractAddress);
  }

  // Calldata for an arbitrary quantity (only meaningful when originalQty was found).
  const encodeQty = (qty) => {
    if (qty === originalQty) return data;
    if (isSeaDrop) {
      try {
        const decoded = SEADROP_IFACE.decodeFunctionData("mintPublic", data);
        return SEADROP_IFACE.encodeFunctionData("mintPublic", [
          decoded.nftContract,
          decoded.feeRecipient || OPENSEA_FEE_RECIPIENT,
          ethers.ZeroAddress,
          qty,
        ]);
      } catch { return data; }
    }
    if (data.length === 74) return data.slice(0, 10) + qty.toString(16).padStart(64, "0");
    return data.slice(0, -64) + qty.toString(16).padStart(64, "0");
  };

  // ── Decide target quantity ──
  let newQty;
  let gasEstimate = null;
  if (isFree) {
    // Totally free (0 ETH): take the most this wallet can get. Start from the cap
    // (or the ceiling when the cap is unreadable) and step down until a quantity
    // simulates clean — so a per-wallet/per-tx limit we couldn't read costs a sim,
    // not a revert (PLOP: whale's qty 7 vs cap 1).
    const top = walletCap !== null ? Math.min(walletCap, FREE_MINT_MAX) : FREE_MINT_MAX;
    newQty = walletCap !== null ? top : (originalQty || 1);
    if (simFrom && contractAddress && originalQty !== null) {
      const ladder = [...new Set([top, originalQty, ...FREE_QTY_LADDER])]
        .filter((q) => q >= 1 && q <= top)
        .sort((a, b) => b - a);
      for (const q of ladder) {
        const call = { to: contractAddress, data: fixSeaDropCalldata(contractAddress, encodeQty(q)), value: 0n, from: simFrom };
        try {
          await provider.call(call);
          newQty = q;
          if (q > originalQty) {
            try { gasEstimate = await provider.estimateGas(call); } catch {}
          }
          break;
        } catch {}
      }
    }
  } else {
    // Paid: enforce USD ceiling, then my preset tier qty.
    const ethUsd = await getEthUsdPrice();
    const priceUsdPerNft = parseFloat(ethers.formatEther(pricePerNft)) * ethUsd;
    const skipAbove = parseFloat(getSettings().maxMintUsd) || DEFAULT_SKIP_ABOVE_USD;
    if (priceUsdPerNft > skipAbove) {
      return { data, value, skip: true, originalQty, newQty: 0, pricePerNft };
    }
    newQty = getTargetQty(priceUsdPerNft);
  }

  // Per-wallet cap is the hard ceiling — max 1 means mint exactly 1.
  if (walletCap !== null && walletCap < newQty) newQty = walletCap;
  if (newQty < 1) newQty = 1;

  // Can't locate qty in calldata to re-encode. If the cap is 1 and the calldata is a
  // bare single-uint mint, force it to 1; otherwise send as-is (best effort).
  if (originalQty === null) {
    return {
      data: walletCap === 1 ? buildSingleMintData(data) : data,
      value,
      skip: false,
      originalQty: null,
      newQty: walletCap === 1 ? 1 : null,
    };
  }

  // Nothing to change.
  if (newQty === originalQty) {
    return { data, value, skip: false, originalQty, newQty };
  }

  // Re-encode calldata with adjusted quantity
  const newData = encodeQty(newQty);
  const newValue = pricePerNft * BigInt(newQty);
  return { data: newData, value: newValue, skip: false, originalQty, newQty, gasEstimate };
}

export async function initCopyMint(ethProvider, signer, notifyFn, askApprovalFn) {
  provider = ethProvider;
  mainSigner = signer;
  telegramNotify = notifyFn;
  telegramAskApproval = askApprovalFn;

  const authSigner = ethers.Wallet.createRandom();
  try {
    flashbotsProvider = await FlashbotsBundleProvider.create(
      provider,
      authSigner,
      FLASHBOTS_RELAY
    );
    console.log("[CopyMint] Flashbots provider ready");
  } catch (err) {
    console.warn("[CopyMint] Flashbots init failed:", err.message);
  }

  mintEvents.on("mintDetected", handleMintDetected);
  tmaEvents.on("tmaBuyDetected", handleTMABuy);
  console.log("[CopyMint] Listening for whale mints...");
}

async function handleTMABuy({ tx, marketplace }) {
  const txValue = tx.value ? BigInt(tx.value) : 0n;
  const ethAmount = parseFloat(ethers.formatEther(txValue));
  const ethPrice = await getEthUsdPrice();
  const usdCost = (ethAmount * ethPrice).toFixed(2);

  await telegramNotify(
    `🛒 *TMA Buy Alert!*\n\n` +
    `Marketplace: ${marketplace}\n` +
    `Paid: ${ethAmount.toFixed(4)} ETH ($${usdCost})\n` +
    `TX: [${tx.hash?.slice(0, 10)}...](https://etherscan.io/tx/${tx.hash})`
  );
}

async function handleMintDetected({ whale, contract, tx }) {
  const txHash = tx.hash;
  if (txHash && processedTxHashes.has(txHash)) return;
  if (txHash) {
    processedTxHashes.add(txHash);
    setTimeout(() => processedTxHashes.delete(txHash), 10 * 60 * 1000);
  }

  const settings = getSettings();
  const contractLower = contract.toLowerCase();
  const whitelist = settings.whitelist || [];
  const blacklist = settings.blacklist || [];

  // ── Filters ──────────────────────────────────────────────────────────────
  if (blacklist.includes(contractLower)) {
    console.log(`[Filter] Blacklisted — skipping ${contract}`);
    return;
  }
  if (whitelist.length > 0 && !whitelist.includes(contractLower)) {
    console.log(`[Filter] Not in whitelist — skipping ${contract}`);
    return;
  }

  const txValue = tx.value ? BigInt(tx.value) : 0n;

  // Free mint toggle
  if (txValue === 0n && settings.allowFreeMints === false) {
    console.log(`[Filter] Free mints disabled — skipping ${contract}`);
    return;
  }

  const ethAmount = parseFloat(ethers.formatEther(txValue));
  const ethPrice = await getEthUsdPrice();
  const usdCost = ethAmount * ethPrice;

  const whaleLabel = getWhaleLabel(whale);

  // Resolve the REAL NFT contract (for SeaDrop, `contract` is the router) so the
  // OpenSea link unfurls the actual collection card, not the router address.
  const rawData = tx.input || tx.data || "0x";
  const nftAddr = getNftContract(contractLower, rawData);
  const collectionName = await getCollectionName(nftAddr);

  const alertMsg =
    `🐋 *Whale Mint Detected!*\n\n` +
    (whaleLabel ? `${whaleLabel}\n` : ``) +
    (collectionName ? `*${collectionName}*\n` : ``) +
    `Whale: \`${whale}\`\n` +
    `Contract: \`${nftAddr}\`\n` +
    `Whale paid: ${ethAmount.toFixed(6)} ETH ($${usdCost.toFixed(2)})\n` +
    `Chain: Ethereum\n` +
    `Auto-Mint: ${settings.autoMint ? "✅ Checking..." : "❌ Off"}\n\n` +
    `[OpenSea](https://opensea.io/assets/ethereum/${nftAddr}) | [Etherscan](https://etherscan.io/address/${nftAddr})`;

  await telegramNotify(alertMsg);
  if (!settings.autoMint) return;

  // mintSigned = signature locked to whale's wallet — skip entirely, sub-wallets included
  if (rawData.slice(0, 10).toLowerCase() === SEADROP_MINT_SIGNED_SELECTOR) {
    await telegramNotify(
      `🔒 *Signed Mint — Skipped*\n\n` +
      `Guaranteed/allowlist drop. The signature is tied to the whale's wallet and cannot be copied.`
    );
    return;
  }

  // Backend-voucher mints (custom contracts, e.g. Pillas mint(...,bytes sig)).
  // The signature is bound to the minter's address — uncopyable. Alert the user
  // so they can mint manually with their own eligible wallets, instead of the
  // bot eating a guaranteed BadSignature() revert.
  if (looksLikeSignedMint(rawData)) {
    await telegramNotify(
      `🔏 *Voucher Mint — Manual Only*\n\n` +
      (collectionName ? `*${collectionName}*\n` : ``) +
      `This drop authorizes each mint with an off-chain signature bound to the minter's wallet, so it can't be copied — the voucher won't validate from your wallets.\n\n` +
      `Whale paid: ${ethAmount.toFixed(6)} ETH ($${usdCost.toFixed(2)}) this mint.\n` +
      `👉 Mint it yourself on the project's site with your own wallets.\n\n` +
      `Contract: \`${nftAddr}\`\n` +
      `[OpenSea](https://opensea.io/assets/ethereum/${nftAddr}) | [Etherscan](https://etherscan.io/address/${nftAddr})`
    );
    return;
  }

  // Drainer check — verify the NFT contract is a real ERC721/ERC1155.
  // Whitelisted contracts bypass this (user has explicitly trusted them).
  // (nftAddr already resolved above for the alert link.)
  const isWhitelisted = whitelist.length > 0 && whitelist.includes(contractLower);
  if (!isWhitelisted) {
    const safe = await isLikelyNFTContract(nftAddr);
    if (!safe) {
      console.warn(`[Safety] ${nftAddr} failed ERC721/ERC1155 check — possible drainer, skipped`);
      await telegramNotify(
        `⛔ *Safety Skip*\n\n` +
        `\`${nftAddr}\` is not a verified ERC721/ERC1155 contract.\n` +
        `Possible drainer — skipped.\n\n` +
        `To override: /whitelist \`${nftAddr}\``,
        null, "Markdown"
      );
      return;
    }
  }

  // Whale mints → main wallet copies the whale → sub-wallets copy the main wallet.
  // The sub-wallets replay the main wallet's own tx and only start once it has
  // CONFIRMED on-chain; if the main wallet doesn't mint, neither do they.
  let subs = null;
  await executeCopyMint(tx, settings.mevShield, (mainTx) => {
    subs = mainMintConfirmed(mainTx.hash)
      .then((ok) => ok
        ? executeSubWalletMints(mainTx)
        : telegramNotify(`⏸ *Sub-Wallets — Held Back*

The main wallet's mint did not confirm, so the sub-wallets did not copy it.`))
      .catch((e) => console.error("[CopyMint] Sub-wallets failed:", e.message));
  });
  await subs;
}

// True once the main wallet's mint is mined and succeeded. A revert, or no
// receipt within the wait, is false.
const MAIN_CONFIRM_TIMEOUT_MS = 180000;
async function mainMintConfirmed(txHash) {
  try {
    const rcpt = await provider.waitForTransaction(txHash, 1, MAIN_CONFIRM_TIMEOUT_MS);
    return rcpt?.status === 1;
  } catch {
    return false;
  }
}

function waitForApproval(mintId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(mintId);
      reject(new Error("timeout"));
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(mintId, { resolve, reject, timer });
  });
}

export function resolveApproval(mintId, approved) {
  const pending = pendingApprovals.get(mintId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingApprovals.delete(mintId);
  pending.resolve(approved);
  return true;
}

const SEADROP_MINT_SIGNED_SELECTOR = "0x4b61cd6f";

// Detects backend-voucher / signature-gated mints (e.g. Pillas
// mint(uint256,uint256,uint256,bytes), selector 0x4a9eee69). The contract
// recovers an ECDSA signer over (msg.sender, qty, nonce, deadline) — the sig is
// bound to the MINTER's wallet, so replaying a whale's calldata from our wallets
// fails BadSignature(). Uncopyable, same class as SeaDrop mintSigned. We alert
// "manual only" instead of burning a doomed copy attempt.
// Heuristic: calldata carries a trailing dynamic `bytes` of length 65 ending in
// a valid ECDSA v byte (27/28/0/1) — the shape of an EIP-712 voucher signature.
function looksLikeSignedMint(data) {
  const body = (data || "0x").slice(10);
  for (let i = 0; i + 64 <= body.length; i += 64) {
    let word;
    try { word = BigInt("0x" + body.slice(i, i + 64)); } catch { continue; }
    if (word !== 65n) continue;              // bytes length == 65
    const sig = body.slice(i + 64, i + 64 + 130);
    if (sig.length !== 130) continue;
    const v = parseInt(sig.slice(128, 130), 16);
    if (v === 27 || v === 28 || v === 0 || v === 1) return true;
  }
  return false;
}

// `onMainSent(mainTx)` fires as soon as the main wallet's mint is out, with that
// mint in the same shape as a whale tx so the sub-wallets can copy it.
export async function executeCopyMint(whaleTx, useMevShield = true, onMainSent = null) {
  const rawData = whaleTx.input || whaleTx.data || "0x";
  const rawTxValue = whaleTx.value ? BigInt(whaleTx.value) : 0n;
  const adj = await adjustMintQuantity(
    rawData, rawTxValue, rawTxValue === 0n, whaleTx.to, await mainSigner.getAddress()
  );
  const { data: adjData, value: adjValue, skip, originalQty, newQty } = adj;

  if (skip) {
    await telegramNotify(
      `⛔ *Main Wallet — Skipped*\n\nPer-unit price exceeds max — not minting.`
    );
    return;
  }

  if (newQty !== null && newQty !== originalQty) {
    await telegramNotify(
      `⚠️ *Quantity Adjusted (Main Wallet)*\n\nWhale minted ×${originalQty} → minting ×${newQty}`
    );
  }

  const mintTx = {
    to: whaleTx.to,
    data: fixSeaDropCalldata(whaleTx.to, adjData),
    value: adjValue,
    gasLimit: pickGasLimit(whaleTx, adj),
  };

  // Simulate before sending — catches IncorrectPayment, reverts, etc. at zero cost
  try {
    await provider.call({ ...mintTx, from: await mainSigner.getAddress() });
  } catch (simErr) {
    const reason = simErr.reason || simErr.message?.slice(0, 120) || "unknown revert";

    // Token ID collision? Let user pick from available IDs
    if (isTokenCollisionRevert(reason)) {
      const nftAddr = getNftContract(mintTx.to, mintTx.data);
      const collidedId = decodeTokenIdFromCalldata(mintTx.data);
      if (collidedId !== null) {
        if (telegramAskIdSelection) {
          await telegramNotify(`🔍 Token ID *#${collidedId}* taken — scanning available IDs...`);
          const scanResult = await scanAvailableIds(nftAddr, provider);
          if (scanResult.allAvailable === 0) {
            await telegramNotify(`⚠️ *Fully minted out* — no IDs available. Skipping.`);
            return;
          }
          const mintId = uuidv4().slice(0, 8);
          await telegramAskIdSelection({ mintId, nftAddr, ...scanResult });
          let chosenId;
          try {
            chosenId = await waitForIdSelection(mintId);
          } catch {
            await telegramNotify(`⏰ *ID selection timed out* — main wallet skipped.`);
            return;
          }
          mintTx.data = reencodeWithTokenId(mintTx.data, chosenId);
          try {
            await provider.call({ ...mintTx, from: await mainSigner.getAddress() });
          } catch (retryErr) {
            const r = retryErr.reason || retryErr.message?.slice(0, 100) || "unknown";
            await telegramNotify(`⚠️ *ID #${chosenId} also reverts:* \`${r}\``);
            return;
          }
        } else {
          // Fallback: silent auto-scan
          await telegramNotify(`🔍 *Token ID #${collidedId} already minted*\nScanning for a free slot...`);
          const [freeId] = await findFreeTokenIds(nftAddr, collidedId + 1n, 1);
          if (freeId !== undefined) {
            mintTx.data = reencodeWithTokenId(mintTx.data, freeId);
            try {
              await provider.call({ ...mintTx, from: await mainSigner.getAddress() });
              await telegramNotify(`✅ Free token ID #${freeId} found — minting...`);
            } catch (retryErr) {
              const retryReason = retryErr.reason || retryErr.message?.slice(0, 120) || "unknown revert";
              await telegramNotify(`⚠️ *Simulation Failed After ID Scan*\n\nReason: \`${retryReason}\``);
              return;
            }
          } else {
            await telegramNotify(`⚠️ *No Free Token IDs Found* — could not locate an unclaimed slot. Skipping.`);
            return;
          }
        }
      } else {
        await telegramNotify(
          `⚠️ *Mint Simulation Failed — Skipped*\n\nThe tx would revert on-chain. Reason:\n\`${reason}\``
        );
        return;
      }
    } else {
      await telegramNotify(
        `⚠️ *Mint Simulation Failed — Skipped*\n\nThe tx would revert on-chain. Reason:\n\`${reason}\``
      );
      return;
    }
  }

  try {
    let txHash;
    if (useMevShield && flashbotsProvider) {
      txHash = await sendViaFlashbots(mintTx);
    } else {
      const sentTx = await mainSigner.sendTransaction(mintTx);
      txHash = sentTx.hash;
    }

    const mainAddr = await mainSigner.getAddress();
    onMainSent?.({
      hash: txHash, from: mainAddr, to: mintTx.to,
      input: mintTx.data, value: mintTx.value.toString(), gas: mintTx.gasLimit.toString(),
    });
    const nftContract = getNftContract(mintTx.to, mintTx.data);
    const collectionName = await getCollectionName(nftContract);
    await logMint({
      contract: nftContract.toLowerCase(),
      wallet: mainAddr.toLowerCase(),
      txHash,
      ethSpent: parseFloat(ethers.formatEther(mintTx.value)),
      timestamp: Date.now(),
    });

    await telegramNotify(
      `✅ *Copy Mint Successful!*\n\n` +
      (collectionName ? `🎨 *${collectionName}*\n` : ``) +
      `📄 Contract: \`${nftContract}\`\n` +
      `⛓️ Chain: Ethereum\n` +
      `💎 Minted to: \`${mainAddr}\``,
      txHash
    );
    return txHash;
  } catch (err) {
    console.error("[CopyMint] Failed:", err.message);
    // Plain text (no Markdown) — error messages contain tx hex/underscores that break Telegram entity parsing.
    // Do NOT re-throw: this runs inside an un-awaited Promise.all in the whale handler, so a throw here
    // becomes an unhandled rejection and crashes the process on Railway.
    await telegramNotify(`❌ Copy Mint Failed\n\nError: ${err.message}`, null, null);
    return;
  }
}

function buildSingleMintData(originalData) {
  const data = originalData || "0x";
  if (data.length <= 10) return data;
  if (data.length === 74) {
    const selector = data.slice(0, 10);
    const encodedOne = "0000000000000000000000000000000000000000000000000000000000000001";
    return selector + encodedOne;
  }
  return data;
}

// All wallet balances in ONE eth_call via Multicall3. The old per-wallet
// getBalance fan-out 429'd on the free-tier sim RPC, and every failed lookup was
// counted as "unfunded" — 70/100 wallets dropped that way on Dumb Wojapes.
// Returns Map(lowercased address → balance | null if the lookup failed).
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_IFACE = new ethers.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
  "function getEthBalance(address addr) view returns (uint256)",
]);

async function getBalances(addresses) {
  const out = new Map();
  if (addresses.length === 0) return out;
  try {
    const calls = addresses.map((a) => ({
      target: MULTICALL3,
      allowFailure: true,
      callData: MULTICALL3_IFACE.encodeFunctionData("getEthBalance", [a]),
    }));
    const raw = await provider.call({
      to: MULTICALL3,
      data: MULTICALL3_IFACE.encodeFunctionData("aggregate3", [calls]),
    });
    const [res] = MULTICALL3_IFACE.decodeFunctionResult("aggregate3", raw);
    addresses.forEach((a, i) => {
      out.set(a.toLowerCase(), res[i].success ? BigInt(res[i].returnData) : null);
    });
    return out;
  } catch (e) {
    console.warn("[Balances] multicall failed, falling back to per-wallet:", e.shortMessage || e.message);
  }
  // Fallback: one at a time with retries — slow, but never mistakes a 429 for an empty wallet.
  for (const a of addresses) {
    let bal = null;
    for (let attempt = 0; attempt < 3 && bal === null; attempt++) {
      try { bal = await provider.getBalance(a); }
      catch { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); }
    }
    out.set(a.toLowerCase(), bal);
  }
  return out;
}

async function executeSubWalletMints(whaleTx, groupName = null) {
  const signers = groupName
    ? getGroupSigners(groupName, provider)
    : getAllSigners(provider);
  if (signers.length === 0) return;

  const rawTxValue = whaleTx.value ? BigInt(whaleTx.value) : 0n;
  // Free mints are calibrated against the first sub-wallet — they all start from
  // the same minted-count on a fresh drop.
  const subAdj = await adjustMintQuantity(
    whaleTx.input || whaleTx.data || "0x",
    rawTxValue,
    rawTxValue === 0n,
    whaleTx.to,
    signers[0].address
  );
  const { data: adjSubData, value: txValue, skip: subSkip, originalQty: subOrigQty, newQty: subNewQty } = subAdj;

  if (subSkip) {
    await telegramNotify(
      `⛔ *Sub-Wallets — Skipped*\n\nPer-unit price exceeds $0.51 — not minting on any wallet.`
    );
    return;
  }

  if (subNewQty !== null && subNewQty !== subOrigQty) {
    await telegramNotify(
      `⚠️ *Quantity Adjusted (Sub-Wallets)*\n\nWhale minted ×${subOrigQty} → minting ×${subNewQty} per wallet`
    );
  }

  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas
    ? (feeData.maxFeePerGas * 120n) / 100n
    : ethers.parseUnits("50", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
    ? feeData.maxPriorityFeePerGas
    : ethers.parseUnits("2", "gwei");

  // Gas buffer = actual estimated gas cost based on live gas price
  const gasLimit = pickGasLimit(whaleTx, subAdj);
  const GAS_BUFFER = (maxFeePerGas * gasLimit * 120n) / 100n; // +20% safety margin

  const funded = [];
  let rpcErrors = 0;
  let belowThreshold = 0;

  const balances = await getBalances(signers.map((s) => s.address));
  for (const signer of signers) {
    const balance = balances.get(signer.address.toLowerCase());
    if (balance == null) rpcErrors++;
    else if (balance >= txValue + GAS_BUFFER) funded.push(signer);
    else belowThreshold++;
  }

  if (funded.length === 0) {
    const threshold = ethers.formatEther(txValue + GAS_BUFFER);
    await telegramNotify(
      `💼 *Sub-Wallets:* 0 funded — skipped\n` +
      `Checked: ${signers.length} wallets | Need: ${threshold} ETH each` +
      (rpcErrors > 0 ? `\n⚠️ ${rpcErrors} RPC errors (rate limit?)` : "") +
      (belowThreshold > 0 ? `\n💸 ${belowThreshold} wallets below threshold` : "")
    );
    return;
  }

  const fixedSubData = fixSeaDropCalldata(whaleTx.to, adjSubData);
  const baseMintTx = {
    to: whaleTx.to,
    data: fixedSubData,
    value: txValue,
    gasLimit,
    type: 2,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };

  const subNftContract = getNftContract(baseMintTx.to, baseMintTx.data);

  // Test simulation on first wallet to detect token ID collision
  // walletDataMap: null = all wallets use same calldata; Map = per-wallet calldata
  let walletDataMap = null;
  let effectiveFunded = funded;
  try {
    await provider.call({ ...baseMintTx, from: funded[0].address });
  } catch (simErr) {
    const reason = simErr.reason || simErr.message?.slice(0, 120) || "";
    if (isTokenCollisionRevert(reason)) {
      const collidedId = decodeTokenIdFromCalldata(baseMintTx.data);
      if (collidedId !== null) {
        await telegramNotify(
          `🔍 *Sub-Wallets: Token ID Collision*\nScanning for ${funded.length} free token IDs...`
        );
        const freeIds = await findFreeTokenIds(subNftContract, collidedId + 1n, funded.length);
        if (freeIds.length === 0) {
          await telegramNotify(`⚠️ *No Free Token IDs Found* — sub-wallets skipped.`);
          return;
        }
        if (freeIds.length < funded.length) {
          await telegramNotify(
            `⚠️ Only ${freeIds.length}/${funded.length} free IDs found — ${funded.length - freeIds.length} wallets will be skipped.`
          );
        }
        walletDataMap = new Map();
        effectiveFunded = funded.slice(0, freeIds.length);
        for (let i = 0; i < freeIds.length; i++) {
          walletDataMap.set(funded[i].address, reencodeWithTokenId(baseMintTx.data, freeIds[i]));
        }
      }
    }
    // Non-collision revert: fire anyway — on-chain result determines outcome
  }

  const subCollectionName = await getCollectionName(subNftContract);

  const results = await Promise.allSettled(
    effectiveFunded.map(async (signer) => {
      const walletData = walletDataMap ? walletDataMap.get(signer.address) : baseMintTx.data;
      const tx = await signer.sendTransaction({ ...baseMintTx, data: walletData });
      await logMint({
        contract: subNftContract.toLowerCase(),
        wallet: signer.address.toLowerCase(),
        txHash: tx.hash,
        ethSpent: parseFloat(ethers.formatEther(txValue)),
        timestamp: Date.now(),
      });
      return tx;
    })
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  await telegramNotify(
    `💼 *Sub-Wallet Mints Complete*\n\n` +
    (subCollectionName ? `🎨 *${subCollectionName}*\n` : ``) +
    `📄 Contract: \`${subNftContract}\`\n` +
    `✅ Succeeded: ${succeeded}\n` +
    `❌ Failed: ${failed}\n` +
    `⏭️ Skipped (no balance): ${signers.length - funded.length}`
  );
}

// Manual mint — called from /mint command
export async function executeManualMint(contractAddress, calldata, valueEth, groupName = null) {
  const value = valueEth ? ethers.parseEther(valueEth.toString()) : 0n;
  const data = calldata || "0x1249c58b"; // standard mint() selector

  const subSigners = groupName
    ? getGroupSigners(groupName, provider)
    : getAllSigners(provider);

  // Always include main wallet
  const signers = [mainSigner, ...subSigners];

  if (subSigners.length === 0 && !groupName) {
    throw new Error("No sub-wallets configured");
  }

  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas
    ? (feeData.maxFeePerGas * 120n) / 100n
    : ethers.parseUnits("50", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
    ? feeData.maxPriorityFeePerGas
    : ethers.parseUnits("2", "gwei");
  const GAS_BUFFER = (maxFeePerGas * 300000n * 120n) / 100n; // dynamic: based on live gas price

  const balances = await getBalances(signers.map((s) => s.address));
  const funded = signers.filter((s) => (balances.get(s.address.toLowerCase()) ?? -1n) >= value + GAS_BUFFER);

  if (funded.length === 0) {
    throw new Error(`No wallets have enough ETH in ${groupName ? `group "${groupName}"` : "sub-wallets"}`);
  }

  const mintTx = {
    to: contractAddress,
    data,
    value,
    gasLimit: 300000n,
    type: 2,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };

  const results = await Promise.allSettled(
    funded.map(async (signer) => {
      const tx = await signer.sendTransaction(mintTx);
      await logMint({
        contract: contractAddress.toLowerCase(),
        wallet: signer.address.toLowerCase(),
        txHash: tx.hash,
        ethSpent: parseFloat(ethers.formatEther(value)),
        timestamp: Date.now(),
      });
      return tx;
    })
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  const skipped = signers.length - funded.length;

  return { succeeded, failed, skipped, total: signers.length };
}

// Like executeManualMint but each wallet gets its own calldata.
// calldataFn(signerAddress) must return the hex calldata for that wallet.
export async function executePerWalletMint(contractAddress, calldataFn, valueEth, groupName = null) {
  const value = valueEth ? ethers.parseEther(valueEth.toString()) : 0n;

  const subSigners = groupName ? getGroupSigners(groupName, provider) : getAllSigners(provider);
  const signers = [mainSigner, ...subSigners];

  if (subSigners.length === 0 && !groupName) throw new Error("No sub-wallets configured");

  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas
    ? (feeData.maxFeePerGas * 120n) / 100n
    : ethers.parseUnits("50", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");
  const GAS_BUFFER = (maxFeePerGas * 300000n * 120n) / 100n;

  const balances = await getBalances(signers.map((s) => s.address));
  const funded = signers.filter((s) => (balances.get(s.address.toLowerCase()) ?? -1n) >= value + GAS_BUFFER);

  if (funded.length === 0) throw new Error("No wallets have enough ETH");

  const results = await Promise.allSettled(
    funded.map(async (signer) => {
      const data = calldataFn(signer.address);
      if (!data) throw new Error(`No calldata for ${signer.address}`);
      const tx = await signer.sendTransaction({
        to: contractAddress, data, value,
        gasLimit: 300000n, type: 2, maxFeePerGas, maxPriorityFeePerGas,
      });
      await logMint({
        contract: contractAddress.toLowerCase(),
        wallet: signer.address.toLowerCase(),
        txHash: tx.hash,
        ethSpent: parseFloat(ethers.formatEther(value)),
        timestamp: Date.now(),
      });
      return tx;
    })
  );

  return {
    succeeded: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
    skipped: signers.length - funded.length,
    total: signers.length,
  };
}

async function sendViaFlashbots(mintTx) {
  const currentBlock = await provider.getBlockNumber();

  for (let attempt = 0; attempt < MAX_BLOCKS_TO_TRY; attempt++) {
    const targetBlock = currentBlock + 1 + attempt;
    const bundle = [
      {
        signer: mainSigner,
        transaction: {
          ...mintTx,
          chainId: 1,
          type: 2,
          maxFeePerGas: ethers.parseUnits("50", "gwei"),
          maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
        },
      },
    ];

    const signedBundle = await flashbotsProvider.signBundle(bundle);
    const simulation = await flashbotsProvider.simulate(signedBundle, targetBlock);
    if ("error" in simulation) continue;

    const submission = await flashbotsProvider.sendRawBundle(signedBundle, targetBlock);
    if ("error" in submission) continue;

    const waitResult = await submission.wait();
    if (waitResult === 0) {
      const receipts = await submission.receipts();
      return receipts[0]?.transactionHash;
    }
  }

  const sentTx = await mainSigner.sendTransaction(mintTx);
  return sentTx.hash;
}

export async function mintByContract(contractAddress, data, value, signer) {
  const mintTx = {
    to: contractAddress,
    data: data || "0x1249c58b",
    value: value ? ethers.parseEther(value) : 0n,
    gasLimit: 300000n,
  };

  const settings = getSettings();
  const signerToUse = signer || mainSigner;
  if (settings.mevShield && flashbotsProvider && signerToUse === mainSigner) {
    return sendViaFlashbots(mintTx);
  }

  const tx = await signerToUse.sendTransaction(mintTx);
  return tx.hash;
}
