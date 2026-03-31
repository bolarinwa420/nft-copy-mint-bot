import { ethers } from "ethers";
import { getSubWallets } from "./storage.js";
import { getWalletSigner } from "./wallets.js";
import { getAlchemy } from "./tracker.js";

// ─── OpenSea / Seaport constants ─────────────────────────────────────────────
const OPENSEA_API  = "https://api.opensea.io/api/v2";
const SEAPORT      = "0x0000000000000068F116a894984e2DB1123eB395"; // Seaport 1.6
const CONDUIT      = "0x1E0049783F008A0085193E00003D00cd54003c71"; // OpenSea conduit
const CONDUIT_KEY  = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000";
const ZONE         = "0x004C00500000aD104D7DBd00e3ae0A5C00560C00"; // OpenSea zone
const LISTING_DAYS = 7;

// Gas cap for setApprovalForAll — keeps approval cost ≤ ~$0.05 at normal gas
// At 3 gwei * 50k gas = 0.00015 ETH ≈ $0.38 — already cheap; cap at 5 gwei to be safe
const MAX_GAS_GWEI = 1n;

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
// Tries Alchemy NFT API first (handles non-Enumerable), falls back to tokenOfOwnerByIndex.
async function getTokenIds(ownerAddress, contractAddress, ethersContract) {
  try {
    const alchemy = getAlchemy();
    const { ownedNfts } = await alchemy.nft.getNftsForOwner(ownerAddress, {
      contractAddresses: [contractAddress],
      omitMetadata: true,
    });
    return ownedNfts.map((n) => BigInt(n.tokenId));
  } catch {
    const bal = await ethersContract.balanceOf(ownerAddress);
    if (bal === 0n) return [];
    const ids = [];
    for (let i = 0; i < bal; i++) {
      ids.push(await ethersContract.tokenOfOwnerByIndex(ownerAddress, i));
    }
    return ids;
  }
}

// Fetch collection slug + fees from OpenSea.
// Returns { slug, fees, name, floor } where fees = [{ feeBps: bigint, recipient: string }]
async function getCollectionMeta(contractAddress, apiKey) {
  let slug  = null;
  let fees  = [];
  let name  = null;
  let floor = null;

  try {
    const contractData = await osGet(`/chain/ethereum/contract/${contractAddress}`, apiKey);
    slug = contractData.collection;
    name = contractData.name || slug;
  } catch (e) {
    console.log("[listing] contract lookup failed:", e.message);
  }

  if (slug) {
    try {
      const collData = await osGet(`/collections/${slug}`, apiKey);
      name = collData.name || name;
      const raw = collData.fees || [];
      console.log("[listing] collection fees raw:", JSON.stringify(raw));
      fees = raw.filter((f) => f.fee > 0 && f.recipient).map((f) => ({
        feeBps:    f.fee,       // plain number — BigInt only at arithmetic time
        recipient: f.recipient,
      }));
      const fp = collData.floor_price ?? collData.stats?.floor_price;
      if (fp != null) floor = fp;
    } catch (e) {
      console.log("[listing] collection meta failed:", e.message);
    }
  }

  // Fallback: derive real fee structure from an existing active listing
  if (fees.length === 0) {
    fees = await getFeesFromExistingListing(contractAddress, apiKey);
  }

  console.log("[listing] resolved fees:", JSON.stringify(fees));
  return { slug, fees, name, floor };
}

// Derive fee structure from an actual validated listing on OpenSea.
// This is the most reliable method — existing listings already passed OS validation.
async function getFeesFromExistingListing(contractAddress, apiKey) {
  try {
    const data = await osGet(
      `/orders/ethereum/seaport/listings?asset_contract_address=${contractAddress}&limit=5&order_by=created_date&order_direction=desc`,
      apiKey
    );
    const order = data.orders?.[0];
    if (!order) return [];

    const params   = order.protocol_data?.parameters;
    if (!params)   return [];

    const offerer  = (params.offerer || "").toLowerCase();
    const allEth   = (params.consideration || []).filter(
      (c) => (c.itemType === 0 || c.itemType === "0")
    );
    const feeItems = allEth.filter(
      (c) => c.recipient?.toLowerCase() !== offerer
    );
    if (feeItems.length === 0) return [];

    const totalWei = allEth.reduce((s, c) => s + BigInt(c.startAmount), 0n);
    if (totalWei === 0n) return [];

    return feeItems.map((c) => ({
      feeBps:    Number((BigInt(c.startAmount) * 10000n) / totalWei),
      recipient: c.recipient,
    }));
  } catch (e) {
    console.log("[listing] fee derivation from listing failed:", e.message);
    return [];
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getContractInfo(contractAddress, provider, apiKey) {
  const nftContract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
  const { name, floor, slug } = await getCollectionMeta(contractAddress, apiKey);

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

  return { collectionName: name, floorPrice: floor, holdingWallets, slug };
}

export async function massListNFTs(contractAddress, numWallets, priceEth, provider, apiKey) {
  const nftContract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
  const seaport     = new ethers.Contract(SEAPORT, SEAPORT_ABI, provider);

  // Fetch real collection fees from OpenSea (handles 0% fee era correctly)
  const { fees: collectionFees } = await getCollectionMeta(contractAddress, apiKey);

  // Find eligible wallets
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

  // Build consideration: seller receives full price minus any required fees
  const priceWei  = ethers.parseEther(String(priceEth));
  let   sellerWei = priceWei;

  const feeItems = [];
  for (const fee of collectionFees) {
    const feeWei = (priceWei * BigInt(fee.feeBps)) / 10000n;
    sellerWei -= feeWei;
    feeItems.push({
      itemType:             0,
      token:                ethers.ZeroAddress,
      identifierOrCriteria: "0",
      startAmount:          feeWei.toString(),
      endAmount:            feeWei.toString(),
      recipient:            fee.recipient,
    });
  }
  console.log("[listing] price:", priceWei.toString(), "sellerWei:", sellerWei.toString(), "feeItems:", JSON.stringify(feeItems));

  const startTime = Math.floor(Date.now() / 1000);
  const endTime   = startTime + LISTING_DAYS * 86400;

  const domain = {
    name: "Seaport",
    version: "1.6",
    chainId: 1,
    verifyingContract: SEAPORT,
  };

  // Gas price cap for approval tx
  const feeData    = await provider.getFeeData();
  const capWei     = ethers.parseUnits(MAX_GAS_GWEI.toString(), "gwei");
  const gasPrice   = feeData.gasPrice && feeData.gasPrice < capWei ? feeData.gasPrice : capWei;

  const results = [];

  for (const { wallet, tokenId } of eligible) {
    try {
      const signer = getWalletSigner(wallet.address, provider);

      // Approve Seaport conduit — one-time, gas-capped
      const isApproved = await nftContract.isApprovedForAll(wallet.address, CONDUIT);
      if (!isApproved) {
        const approveTx = await nftContract.connect(signer).setApprovalForAll(CONDUIT, true, {
          maxFeePerGas:         gasPrice,
          maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei"),
        });
        await approveTx.wait();
      }

      const counter = await seaport.getCounter(wallet.address);
      const salt    = BigInt(ethers.hexlify(ethers.randomBytes(16))).toString();

      const orderComponents = {
        offerer:  wallet.address,
        zone:     ZONE,
        offer: [
          {
            itemType:             2, // ERC721
            token:                contractAddress,
            identifierOrCriteria: tokenId.toString(),
            startAmount:          "1",
            endAmount:            "1",
          },
        ],
        consideration: [
          {
            itemType:             0,
            token:                ethers.ZeroAddress,
            identifierOrCriteria: "0",
            startAmount:          sellerWei.toString(),
            endAmount:            sellerWei.toString(),
            recipient:            wallet.address,
          },
          ...feeItems,
        ],
        orderType:  0, // FULL_OPEN
        startTime:  startTime.toString(),
        endTime:    endTime.toString(),
        zoneHash:   ethers.ZeroHash,
        salt,
        conduitKey: CONDUIT_KEY,
        counter:    counter.toString(),
      };

      const signature = await signer.signTypedData(domain, EIP712_TYPES, orderComponents);

      const postRes = await fetch(`${OPENSEA_API}/orders/ethereum/seaport/listings`, {
        method: "POST",
        headers: {
          "x-api-key":    apiKey,
          "Content-Type": "application/json",
          Accept:         "application/json",
        },
        body: JSON.stringify({ parameters: orderComponents, signature, protocol_address: SEAPORT }),
      });

      if (postRes.ok) {
        results.push({ status: "listed", address: wallet.address, tokenId: tokenId.toString(), priceEth });
      } else {
        const errText = await postRes.text();
        results.push({ status: "failed", address: wallet.address, tokenId: tokenId.toString(), error: errText.slice(0, 120) });
      }
    } catch (err) {
      results.push({ status: "failed", address: wallet.address, error: err.message.slice(0, 120) });
    }
  }

  return results;
}
