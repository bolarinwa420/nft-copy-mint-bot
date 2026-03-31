import { ethers } from "ethers";
import { getSubWallets } from "./storage.js";
import { getWalletSigner } from "./wallets.js";
import { getAlchemy } from "./tracker.js";

// ─── OpenSea / Seaport constants ─────────────────────────────────────────────
const OPENSEA_API    = "https://api.opensea.io/api/v2";
const SEAPORT        = "0x0000000000000068F116a894984e2DB1123eB395"; // Seaport 1.6
const CONDUIT        = "0x1E0049783F008A0085193E00003D00cd54003c71"; // OpenSea conduit
const CONDUIT_KEY    = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000";
const OS_FEE_RECIP   = "0x0000a26b00c1F0DF003000390027140000fAa719"; // OpenSea fee wallet
const ZONE           = "0x004C00500000aD104D7DBd00e3ae0A5C00560C00"; // OpenSea zone
const OS_FEE_BPS     = 250n; // 2.5%
const LISTING_DAYS   = 7;    // default listing duration

const ERC721_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
  "function name() view returns (string)",
];

const SEAPORT_ABI = [
  "function getCounter(address offerer) view returns (uint256)",
];

const EIP712_TYPES = {
  OrderComponents: [
    { name: "offerer",       type: "address" },
    { name: "zone",          type: "address" },
    { name: "offer",         type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType",     type: "uint8" },
    { name: "startTime",     type: "uint256" },
    { name: "endTime",       type: "uint256" },
    { name: "zoneHash",      type: "bytes32" },
    { name: "salt",          type: "uint256" },
    { name: "conduitKey",    type: "bytes32" },
    { name: "counter",       type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType",              type: "uint8" },
    { name: "token",                 type: "address" },
    { name: "identifierOrCriteria",  type: "uint256" },
    { name: "startAmount",           type: "uint256" },
    { name: "endAmount",             type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType",              type: "uint8" },
    { name: "token",                 type: "address" },
    { name: "identifierOrCriteria",  type: "uint256" },
    { name: "startAmount",           type: "uint256" },
    { name: "endAmount",             type: "uint256" },
    { name: "recipient",             type: "address" },
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function osGet(path, apiKey) {
  const res = await fetch(`${OPENSEA_API}${path}`, {
    headers: { "x-api-key": apiKey, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`OpenSea ${res.status}: ${await res.text()}`);
  return res.json();
}

// Get token IDs held by an address for a given contract.
// Tries Alchemy NFT API first (handles non-Enumerable contracts), falls back to tokenOfOwnerByIndex.
async function getTokenIds(ownerAddress, contractAddress, ethersContract) {
  try {
    const alchemy = getAlchemy();
    const { ownedNfts } = await alchemy.nft.getNftsForOwner(ownerAddress, {
      contractAddresses: [contractAddress],
      omitMetadata: true,
    });
    return ownedNfts.map((n) => BigInt(n.tokenId));
  } catch {
    // fallback: on-chain enumerable
    const bal = await ethersContract.balanceOf(ownerAddress);
    if (bal === 0n) return [];
    const ids = [];
    for (let i = 0; i < bal; i++) {
      ids.push(await ethersContract.tokenOfOwnerByIndex(ownerAddress, i));
    }
    return ids;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns collection name, floor price, and which sub-wallets hold the NFT.
 */
export async function getContractInfo(contractAddress, provider, apiKey) {
  const nftContract = new ethers.Contract(contractAddress, ERC721_ABI, provider);

  // 1. Collection info from OpenSea
  let collectionName = null;
  let floorPrice     = null;
  let slug           = null;

  try {
    const contractData = await osGet(`/chain/ethereum/contract/${contractAddress}`, apiKey);
    slug = contractData.collection;
    collectionName = contractData.name || slug;
  } catch {}

  if (slug) {
    try {
      const collData = await osGet(`/collections/${slug}`, apiKey);
      collectionName = collData.name || collectionName;
      // v2 API returns floor_price as a nested object
      const fp = collData.floor_price ?? collData.stats?.floor_price;
      if (fp !== undefined && fp !== null) floorPrice = fp;
    } catch {}
  }

  // 2. Which sub-wallets hold this NFT
  const wallets = getSubWallets();
  const holdingWallets = [];

  for (const w of wallets) {
    try {
      const tokenIds = await getTokenIds(w.address, contractAddress, nftContract);
      if (tokenIds.length > 0) {
        holdingWallets.push({ address: w.address, count: tokenIds.length, tokenIds });
      }
    } catch {}
  }

  return { collectionName, floorPrice, holdingWallets, slug };
}

/**
 * Creates OpenSea listings from up to `numWallets` wallets.
 * Each wallet lists its first token at `priceEth` ETH.
 * Returns array of result objects.
 */
export async function massListNFTs(contractAddress, numWallets, priceEth, provider, apiKey) {
  const nftContract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
  const seaport     = new ethers.Contract(SEAPORT, SEAPORT_ABI, provider);

  // Find eligible wallets (hold at least 1 NFT), capped at numWallets
  const wallets  = getSubWallets();
  const eligible = [];

  for (const w of wallets) {
    if (eligible.length >= numWallets) break;
    try {
      const tokenIds = await getTokenIds(w.address, contractAddress, nftContract);
      if (tokenIds.length > 0) eligible.push({ wallet: w, tokenId: tokenIds[0] });
    } catch {}
  }

  if (eligible.length === 0) {
    return [{ status: "error", error: "No wallets hold this NFT" }];
  }

  const priceWei    = ethers.parseEther(String(priceEth));
  const feeWei      = (priceWei * OS_FEE_BPS) / 10000n;
  const sellerWei   = priceWei - feeWei;
  const startTime   = Math.floor(Date.now() / 1000);
  const endTime     = startTime + LISTING_DAYS * 86400;

  const domain = {
    name: "Seaport",
    version: "1.6",
    chainId: 1,
    verifyingContract: SEAPORT,
  };

  const results = [];

  for (const { wallet, tokenId } of eligible) {
    try {
      const signer = getWalletSigner(wallet.address, provider);

      // Approve Seaport conduit if not already approved
      const isApproved = await nftContract.isApprovedForAll(wallet.address, CONDUIT);
      if (!isApproved) {
        const approveTx = await nftContract.connect(signer).setApprovalForAll(CONDUIT, true);
        await approveTx.wait();
      }

      // Nonce / counter for this offerer
      const counter = await seaport.getCounter(wallet.address);

      // Random salt as uint256
      const saltHex = ethers.hexlify(ethers.randomBytes(16));
      const salt    = BigInt(saltHex).toString();

      const orderComponents = {
        offerer:  wallet.address,
        zone:     ZONE,
        offer: [
          {
            itemType:             2,                      // ERC721
            token:                contractAddress,
            identifierOrCriteria: tokenId.toString(),
            startAmount:          "1",
            endAmount:            "1",
          },
        ],
        consideration: [
          {
            itemType:             0,                      // ETH
            token:                ethers.ZeroAddress,
            identifierOrCriteria: "0",
            startAmount:          sellerWei.toString(),
            endAmount:            sellerWei.toString(),
            recipient:            wallet.address,
          },
          {
            itemType:             0,
            token:                ethers.ZeroAddress,
            identifierOrCriteria: "0",
            startAmount:          feeWei.toString(),
            endAmount:            feeWei.toString(),
            recipient:            OS_FEE_RECIP,
          },
        ],
        orderType: 0,                                     // FULL_OPEN
        startTime: startTime.toString(),
        endTime:   endTime.toString(),
        zoneHash:  ethers.ZeroHash,
        salt,
        conduitKey: CONDUIT_KEY,
        counter:    counter.toString(),
      };

      const signature = await signer.signTypedData(domain, EIP712_TYPES, orderComponents);

      // POST order to OpenSea
      const postRes = await fetch(`${OPENSEA_API}/orders/ethereum/seaport/listings`, {
        method: "POST",
        headers: {
          "x-api-key":    apiKey,
          "Content-Type": "application/json",
          Accept:         "application/json",
        },
        body: JSON.stringify({ parameters: orderComponents, signature }),
      });

      if (postRes.ok) {
        results.push({
          status:  "listed",
          address: wallet.address,
          tokenId: tokenId.toString(),
          priceEth,
        });
      } else {
        const errText = await postRes.text();
        results.push({
          status:  "failed",
          address: wallet.address,
          tokenId: tokenId.toString(),
          error:   errText.slice(0, 120),
        });
      }
    } catch (err) {
      results.push({
        status:  "failed",
        address: wallet.address,
        error:   err.message.slice(0, 120),
      });
    }
  }

  return results;
}
