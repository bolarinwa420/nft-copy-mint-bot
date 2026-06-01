import { ethers } from "ethers";

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const FROM_ZERO = "0x" + "0".repeat(64);

const MAX_SUPPLY_GETTERS = [
  "maxSupply", "MAX_SUPPLY", "maxTokens", "MAX_TOKENS",
  "collectionSize", "COLLECTION_SIZE", "maxMintable", "MAX_MINTABLE",
];

async function getMaxSupply(contractAddress, provider) {
  for (const name of MAX_SUPPLY_GETTERS) {
    try {
      const iface = new ethers.Interface([`function ${name}() view returns (uint256)`]);
      const raw = await provider.call({ to: contractAddress, data: iface.encodeFunctionData(name) });
      const [val] = iface.decodeFunctionResult(name, raw);
      if (val > 0n && val <= 100000n) return val;
    } catch {}
  }
  return null;
}

async function getMintedIds(contractAddress, provider) {
  const minted = new Set();
  try {
    const latest = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - 150000); // ~1 month of blocks
    const logs = await provider.getLogs({
      address: contractAddress,
      topics: [TRANSFER_TOPIC, FROM_ZERO],
      fromBlock,
      toBlock: "latest",
    });
    for (const log of logs) {
      // Standard ERC721: tokenId is topics[3] (indexed)
      if (log.topics[3]) {
        minted.add(BigInt(log.topics[3]));
      } else if (log.data && log.data !== "0x") {
        // Non-standard: tokenId in data
        try { minted.add(BigInt(log.data)); } catch {}
      }
    }
  } catch (err) {
    console.warn("[IdScanner] getLogs error:", err.message);
  }
  return minted;
}

// Returns a random sample of available IDs plus summary stats.
// sampleCount = how many IDs to show the user as quick-pick options.
export async function scanAvailableIds(contractAddress, provider, sampleCount = 6) {
  const [maxSupply, mintedIds] = await Promise.all([
    getMaxSupply(contractAddress, provider),
    getMintedIds(contractAddress, provider),
  ]);

  const total = maxSupply ? Number(maxSupply) : null;
  const minted = mintedIds.size;

  if (total === null) {
    return { available: [], total: null, minted, allAvailable: 0 };
  }

  const available = [];
  for (let i = 0; i < total; i++) {
    if (!mintedIds.has(BigInt(i))) available.push(BigInt(i));
  }

  const sample = [...available]
    .sort(() => Math.random() - 0.5)
    .slice(0, sampleCount)
    .sort((a, b) => Number(a - b));

  return { available: sample, total, minted, allAvailable: available.length };
}
