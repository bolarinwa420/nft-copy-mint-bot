import { ethers } from "ethers";
import { fetchABI, findBestMintFn, readMintPrice, mintFnSignature } from "./contractMinter.js";

const ERC721_ID = "0x80ac58cd";
const ERC1155_ID = "0xd9b67a26";

function extractAddresses(html) {
  const matches = html.match(/0x[0-9a-fA-F]{40}/g) || [];
  return [...new Set(matches)];
}

async function isNFTContract(provider, address) {
  const iface = new ethers.Interface(["function supportsInterface(bytes4) view returns (bool)"]);
  for (const id of [ERC721_ID, ERC1155_ID]) {
    try {
      const data = iface.encodeFunctionData("supportsInterface", [id]);
      const result = await provider.call({ to: address, data });
      const [ok] = iface.decodeFunctionResult("supportsInterface", result);
      if (ok) return true;
    } catch {}
  }
  return false;
}

async function lookupSelector4byte(selector) {
  try {
    const res = await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`, {
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return (json.results || []).map((r) => r.text_signature);
  } catch {
    return [];
  }
}

async function getTopSelectorFromTxs(contract, apiKey) {
  if (!apiKey) return null;
  try {
    const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${contract}&sort=desc&page=1&offset=50&apikey=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();
    if (json.status !== "1" || !Array.isArray(json.result)) return null;

    const counts = {};
    for (const tx of json.result) {
      if (tx.to?.toLowerCase() !== contract.toLowerCase()) continue;
      if (tx.isError !== "0") continue;
      const inp = tx.input || "";
      if (inp.length < 10 || inp === "0x") continue;
      const sel = inp.slice(0, 10).toLowerCase();
      counts[sel] = (counts[sel] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return null;
    return { selector: sorted[0][0], count: sorted[0][1] };
  } catch {
    return null;
  }
}

export function classifyMintType(sig) {
  if (!sig) return "unknown";
  const lower = sig.toLowerCase();
  if (/^(mint|claim|freemint|claimfree|publicmint|safemint)\(\)$/.test(lower)) return "noarg";
  if (lower.includes("tokenid") || /\(uint256 id\)/.test(lower)) return "tokenId";
  if (lower.includes("quantity") || lower.includes("amount") || lower.includes("qty") || lower.includes("count")) return "quantity";
  if (/\(uint256\)/.test(lower)) return "quantity"; // single uint256 → almost always qty
  return "unknown";
}

// Probe ownerOf() to find unclaimed token IDs. Returns up to `needed` available IDs.
export async function findAvailableTokenIds(provider, contract, needed = 100) {
  const ownerIface = new ethers.Interface(["function ownerOf(uint256) view returns (address)"]);

  // Try totalSupply so we start probing right after minted supply
  let startId = 0;
  try {
    const tsIface = new ethers.Interface(["function totalSupply() view returns (uint256)"]);
    const result = await provider.call({ to: contract, data: tsIface.encodeFunctionData("totalSupply", []) });
    const [ts] = tsIface.decodeFunctionResult("totalSupply", result);
    startId = Number(ts);
  } catch {}

  const available = [];
  const BATCH = 25;
  const maxCheck = startId + 3000;

  for (let i = startId; i <= maxCheck && available.length < needed; i += BATCH) {
    const ids = Array.from({ length: Math.min(BATCH, maxCheck - i + 1) }, (_, k) => i + k);
    await Promise.all(
      ids.map(async (tokenId) => {
        if (available.length >= needed) return;
        try {
          const data = ownerIface.encodeFunctionData("ownerOf", [tokenId]);
          await provider.call({ to: contract, data });
          // no revert = owned, skip
        } catch (err) {
          const msg = (err.message || "").toLowerCase();
          if (msg.includes("revert") || msg.includes("nonexistent") || msg.includes("invalid") || msg.includes("owner")) {
            if (available.length < needed) available.push(tokenId);
          }
        }
      })
    );
  }
  return available;
}

// Main entry point: fetch a URL, extract NFT contracts, analyze mint format.
export async function analyzeLink(url, provider, etherscanApiKey) {
  // 1. Fetch page HTML/JS
  let html;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    throw new Error(`Couldn't fetch page: ${err.message}`);
  }

  // 2. Extract all 0x addresses
  const allAddresses = extractAddresses(html);
  if (allAddresses.length === 0) throw new Error("No contract addresses found on this page.");

  // 3. Filter to NFT contracts
  const nftChecks = await Promise.allSettled(
    allAddresses.map(async (addr) => ({ addr, isNFT: await isNFTContract(provider, addr) }))
  );
  const nftContracts = nftChecks
    .filter((r) => r.status === "fulfilled" && r.value.isNFT)
    .map((r) => r.value.addr);

  const candidates = nftContracts.length > 0 ? nftContracts : allAddresses.slice(0, 5);

  // 4. Analyze each candidate
  const analyzed = [];
  for (const contract of candidates.slice(0, 5)) {
    const abi = await fetchABI(contract, etherscanApiKey);
    const mintFn = findBestMintFn(abi);
    const priceEth = await readMintPrice(provider, contract, abi);

    let sig = mintFn ? mintFnSignature(mintFn) : null;
    let selector = mintFn ? ethers.id(sig).slice(0, 10) : null;
    let source = abi ? "Etherscan ABI" : null;

    if (!mintFn) {
      const top = await getTopSelectorFromTxs(contract, etherscanApiKey);
      if (top) {
        selector = top.selector;
        const sigs = await lookupSelector4byte(selector);
        sig = sigs[0] || null;
        source = `tx history (${top.count} calls)${sig ? " + 4byte" : ""}`;
      }
    }

    const mintType = classifyMintType(sig);

    analyzed.push({
      contract,
      hasAbi: !!abi,
      mintFn,
      sig,
      selector,
      priceEth,
      mintType,
      source,
      isNFT: nftContracts.includes(contract),
    });
  }

  // 5. Sort: prefer verified NFT contract with a detected mint fn
  analyzed.sort((a, b) => {
    const score = (x) =>
      (x.isNFT ? 4 : 0) + (x.mintFn ? 3 : 0) + (x.sig ? 2 : 0) + (x.hasAbi ? 1 : 0);
    return score(b) - score(a);
  });

  return {
    url,
    allFound: allAddresses.length,
    nftContracts,
    contracts: analyzed,
    best: analyzed[0] || null,
  };
}
