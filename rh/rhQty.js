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

// SeaDrop keeps BOTH the per-wallet cap and the authoritative mint price on the
// router (getPublicDrop), keyed by the real NFT contract — not the router.
//
// Cached only 10s on purpose: creators mutate the drop mid-flight. Gorala
// (0x219BCa1b…) went from 0.00003/NFT to FREE between the whale's mint and ours,
// which is exactly how a long-lived cache gets us reverted.
const DROP_TTL_MS = 10_000;
const dropCache = new Map();
async function getSeadropDrop(provider, nft) {
  const a = nft.toLowerCase();
  const hit = dropCache.get(a);
  if (hit && Date.now() - hit.at < DROP_TTL_MS) return hit.drop;
  let drop = null;
  try {
    const raw = await provider.call({ to: SEADROP_ADDRESS, data: SEADROP_DROP_IFACE.encodeFunctionData("getPublicDrop", [nft]) });
    const d = SEADROP_DROP_IFACE.decodeFunctionResult("getPublicDrop", raw);
    const max = Number(d.maxTotalMintableByWallet);
    drop = {
      mintPrice: BigInt(d.mintPrice),
      cap: max > 0 && max <= 100000 ? max : null,
      startTime: Number(d.startTime),
      endTime: Number(d.endTime),
    };
  } catch {}
  dropCache.set(a, { drop, at: Date.now() });
  return drop;
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

  // ── price + cap ──
  // For SeaDrop the ROUTER is the authority on price: mintPublic enforces
  // msg.value == mintPrice * qty against the CURRENT on-chain drop. The whale's
  // paid value is only a hint — if the creator repriced (incl. → FREE) between
  // their mint and ours, copying their price earns an IncorrectPayment revert.
  let cap = null;
  let pricePerNft = isFree ? 0n : value / BigInt(effQty);
  let priceSource = "whale";
  if (isSeaDrop && seadropNft) {
    const drop = await getSeadropDrop(provider, seadropNft);
    if (drop) {
      cap = drop.cap;
      pricePerNft = drop.mintPrice;
      priceSource = "onchain";
    }
  }
  const isFreeNow = pricePerNft === 0n;

  // ── decide target quantity via the ladder ──
  const FREE_MAX = Number(s.freeMintMax || 10);
  const FREE_FALLBACK = Number(s.freeMintFallback || 3);
  let newQty, priceUsd = 0;
  if (isFreeNow) {
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
    return { data, value, skip: false, originalQty: null, newQty: null, priceUsd, nft: seadropNft, reencode: null };
  }

  // Rebuilds calldata + native value for an arbitrary quantity. The executor uses
  // this to step the qty down when the sim reverts (cap we couldn't read, stage
  // supply nearly exhausted, etc.) instead of throwing the whole mint away.
  const reencode = (qty) => {
    // Value is ALWAYS recomputed from the authoritative price — never carried over
    // from the whale's tx — except when we had no on-chain price to trust and the
    // qty is unchanged, where replaying their exact value verbatim is safest
    // (integer division can otherwise shave wei off the total).
    const keepWhaleValue = priceSource === "whale" && qty === originalQty;
    const v2 = keepWhaleValue ? value : pricePerNft * BigInt(qty);
    if (qty === originalQty) return { data, value: v2 };

    let d2 = data;
    if (isSeaDrop) {
      try {
        const dec = SEADROP_IFACE.decodeFunctionData("mintPublic", data);
        d2 = SEADROP_IFACE.encodeFunctionData("mintPublic", [
          dec.nftContract, dec.feeRecipient || OPENSEA_FEE_RECIPIENT, ethers.ZeroAddress, qty,
        ]);
      } catch { return { data, value: v2 }; }
    } else if (data.length === 74) {
      d2 = data.slice(0, 10) + qty.toString(16).padStart(64, "0");
    } else {
      d2 = data.slice(0, -64) + qty.toString(16).padStart(64, "0");
    }
    return { data: d2, value: v2 };
  };

  const built = reencode(newQty);
  return {
    data: built.data, value: built.value, skip: false,
    originalQty, newQty, priceUsd, nft: seadropNft, cap, reencode,
    priceSource, isFree: isFreeNow, repriced: isFree !== isFreeNow || priceSource === "onchain",
  };
}

// Custom errors we expect to eat on a SeaDrop-style mint. Without this the sim
// gate just says "reverted" and we learn nothing about WHY we missed a drop.
const REVERT_IFACE = new ethers.Interface([
  "error Error(string)",
  "error MintQuantityExceedsMaxSupply(uint256 total, uint256 maxSupply)",
  "error MintQuantityExceedsMaxMintedPerWallet(uint256 total, uint256 allowed)",
  "error MintQuantityExceedsMaxTokenSupplyForStage(uint256 total, uint256 maxTokenSupplyForStage)",
  "error MintQuantityCannotBeZero()",
  "error NotActive(uint256 currentTimestamp, uint256 startTimestamp, uint256 endTimestamp)",
  "error IncorrectPayment(uint256 got, uint256 want)",
  "error FeeRecipientNotAllowed()",
  "error FeeRecipientCannotBeZeroAddress()",
  "error OnlyINonFungibleSeaDropToken(address received)",
  "error TokenGatedNotTokenOwner(address nftContract, address allowedNftToken, uint256 allowedNftTokenId)",
]);

// Pull the revert payload out of whatever shape ethers/the RPC wrapped it in.
export function decodeRhRevert(err) {
  const data =
    err?.data ??
    err?.error?.data ??
    err?.info?.error?.data ??
    err?.value?.data ??
    null;
  const hex = typeof data === "string" ? data : data?.data;
  if (!hex || !hex.startsWith("0x") || hex.length < 10) {
    return err?.shortMessage || err?.reason || err?.message?.slice(0, 120) || "unknown revert";
  }
  try {
    const parsed = REVERT_IFACE.parseError(hex);
    if (!parsed) return `unrecognized revert ${hex.slice(0, 10)}`;
    if (parsed.name === "Error") return parsed.args[0];
    const args = parsed.args.map((a) => a.toString()).join(", ");
    return args ? `${parsed.name}(${args})` : parsed.name;
  } catch {
    return `unrecognized revert ${hex.slice(0, 10)}`;
  }
}
