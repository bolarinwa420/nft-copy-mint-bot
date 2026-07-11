// RH mint-quantity engine — ports the mainnet copymint adjustMintQuantity logic
// but with the user's own USD-per-NFT ladder. Self-contained (no import from
// copymint.js) so the mainnet path stays untouched.
//
// Ladder (price per NFT, USD):
//   free ($0)        → mint per-wallet cap (max), clamped to freeMintMax
//   $0.001 – $0.099  → 10
//   $0.10  – $0.30   → 5
//   $0.31  – $0.50   → 2
//   $0.51  – $2.00   → 1
//   > $2.00          → skip
import { ethers } from "ethers";
import { getRhSettings } from "./rhStore.js";

const SEADROP_ADDRESS = "0x00005ea00ac477b1030ce78506496e8c2de24bf5";
const SEADROP_MINT_PUBLIC_SELECTOR = "0x161ac21f";
const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
const SEADROP_IFACE = new ethers.Interface([
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)",
]);
const SEADROP_DROP_IFACE = new ethers.Interface([
  "function getPublicDrop(address nftContract) view returns (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)",
]);

// The user's ladder. Returns 0 to signal "skip — too expensive".
// Round to the nearest cent first so a mint priced at exactly $0.10 or $2.00
// isn't kicked into the wrong band by float noise (0.0999999.../2.0000001...).
function getRhTargetQty(usdPerNftRaw) {
  const usdPerNft = Math.round(usdPerNftRaw * 100) / 100;
  if (usdPerNft < 0.10) return 10;   // under a dime
  if (usdPerNft <= 0.30) return 5;   // $0.10 – $0.30
  if (usdPerNft <= 0.50) return 2;   // $0.31 – $0.50
  if (usdPerNft <= 2.00) return 1;   // $0.51 – $2.00
  return 0;                          // > $2 → skip
}

// RH native token is ETH (bridged), so ETH/USD is the right conversion — same
// assumption the rh-copy-trader uses. Cached 60s.
let ethUsdCache = null, ethUsdAt = 0;
async function getEthUsdPrice() {
  const now = Date.now();
  if (ethUsdCache && now - ethUsdAt < 60000) return ethUsdCache;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const d = await r.json();
    ethUsdCache = d.ethereum.usd; ethUsdAt = now; return ethUsdCache;
  } catch { return ethUsdCache || 3000; }
}

// SeaDrop keeps the per-wallet cap on the router (getPublicDrop), keyed by the
// real NFT contract — not the router address. Cached per NFT.
const capCache = new Map();
async function getSeadropWalletCap(provider, nft) {
  const a = nft.toLowerCase();
  if (capCache.has(a)) return capCache.get(a);
  let cap = null;
  try {
    const raw = await provider.call({ to: SEADROP_ADDRESS, data: SEADROP_DROP_IFACE.encodeFunctionData("getPublicDrop", [nft]) });
    const d = SEADROP_DROP_IFACE.decodeFunctionResult("getPublicDrop", raw);
    const max = Number(d.maxTotalMintableByWallet);
    if (max > 0 && max <= 100000) cap = max;
  } catch {}
  capCache.set(a, cap);
  return cap;
}

// Returns { data, value, skip, reason, originalQty, newQty, priceUsd, nft } where
// data/value are the ADJUSTED per-wallet calldata + native value to send.
export async function rhAdjustQuantity(rawData, txValue, provider) {
  const data = rawData || "0x";
  const value = BigInt(txValue || 0);
  const isFree = value === 0n;
  const s = getRhSettings();

  // ── decode quantity + the real NFT contract from calldata ──
  let originalQty = null, isSeaDrop = false, seadropNft = null;
  if (data.slice(0, 10).toLowerCase() === SEADROP_MINT_PUBLIC_SELECTOR) {
    try {
      const dec = SEADROP_IFACE.decodeFunctionData("mintPublic", data);
      originalQty = Number(dec.quantity); seadropNft = dec.nftContract; isSeaDrop = true;
    } catch {}
  }
  if (originalQty === null && data.length === 74) {
    const q = parseInt(data.slice(10), 16); if (q > 0 && q <= 10000) originalQty = q;
  }
  if (originalQty === null && data.length > 74 && (data.length - 10) % 64 === 0) {
    const q = parseInt(data.slice(-64), 16); if (q > 0 && q <= 10000) originalQty = q;
  }
  const effQty = originalQty || 1;
  const pricePerNft = isFree ? 0n : value / BigInt(effQty);

  // ── per-wallet cap (hard ceiling) ──
  let cap = null;
  if (isSeaDrop && seadropNft) cap = await getSeadropWalletCap(provider, seadropNft);

  // ── decide target quantity via the ladder ──
  const FREE_MAX = Number(s.freeMintMax || 10);
  const FREE_FALLBACK = Number(s.freeMintFallback || 3);
  let newQty, priceUsd = 0;
  if (isFree) {
    newQty = cap !== null ? Math.min(cap, FREE_MAX) : FREE_FALLBACK;
  } else {
    const ethUsd = await getEthUsdPrice();
    priceUsd = parseFloat(ethers.formatEther(pricePerNft)) * ethUsd;
    newQty = getRhTargetQty(priceUsd);
    if (newQty < 1) return { skip: true, reason: `$${priceUsd.toFixed(3)}/NFT > $2 ceiling`, priceUsd, originalQty, newQty: 0, nft: seadropNft };
  }
  if (cap !== null && cap < newQty) newQty = cap;
  if (newQty < 1) newQty = 1;

  // ── re-encode ──
  // Can't locate qty in calldata → send verbatim (best effort). Sim gate still guards it.
  if (originalQty === null) {
    return { data, value, skip: false, originalQty: null, newQty: null, priceUsd, nft: seadropNft };
  }
  if (newQty === originalQty) {
    return { data, value, skip: false, originalQty, newQty, priceUsd, nft: seadropNft };
  }
  let newData = data;
  if (isSeaDrop) {
    try {
      const dec = SEADROP_IFACE.decodeFunctionData("mintPublic", data);
      newData = SEADROP_IFACE.encodeFunctionData("mintPublic", [
        dec.nftContract, dec.feeRecipient || OPENSEA_FEE_RECIPIENT, ethers.ZeroAddress, newQty,
      ]);
    } catch {}
  } else if (data.length === 74) {
    newData = data.slice(0, 10) + newQty.toString(16).padStart(64, "0");
  } else {
    newData = data.slice(0, -64) + newQty.toString(16).padStart(64, "0");
  }
  const newValue = pricePerNft * BigInt(newQty);
  return { data: newData, value: newValue, skip: false, originalQty, newQty, priceUsd, nft: seadropNft };
}
