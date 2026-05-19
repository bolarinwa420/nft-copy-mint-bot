import { ethers } from "ethers";

const ETHERSCAN_API = "https://api.etherscan.io/api";
const MINT_KEYWORDS = ["mint", "claim", "purchase", "buy", "presale", "public"];
const PRICE_KEYWORDS = ["price", "cost", "fee", "rate"];

export async function fetchABI(contractAddress, apiKey) {
  if (!apiKey) return null;
  try {
    const url = `${ETHERSCAN_API}?module=contract&action=getabi&address=${contractAddress}&apikey=${apiKey}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.status === "1") return JSON.parse(json.result);
  } catch {}
  return null;
}

export function findBestMintFn(abi) {
  if (!abi) return null;

  const candidates = abi.filter(
    (item) =>
      item.type === "function" &&
      item.stateMutability !== "view" &&
      item.stateMutability !== "pure" &&
      MINT_KEYWORDS.some((kw) => item.name.toLowerCase().includes(kw))
  );

  if (candidates.length === 0) return null;

  const priority = [
    (fn) => fn.name === "publicMint" && fn.inputs.length === 1 && fn.inputs[0].type === "uint256",
    (fn) => fn.name === "mint" && fn.inputs.length === 1 && fn.inputs[0].type === "uint256",
    (fn) => fn.name === "publicMint" && fn.inputs.length === 0,
    (fn) => fn.name === "mint" && fn.inputs.length === 0,
    (fn) => fn.name === "claim" && fn.inputs.length === 1 && fn.inputs[0].type === "uint256",
    (fn) => fn.name === "claim" && fn.inputs.length === 0,
    (fn) => fn.inputs.length === 1 && fn.inputs[0].type === "uint256",
    (fn) => fn.inputs.length === 2 && fn.inputs.some((i) => i.type === "uint256"),
    (fn) => fn.inputs.length === 0,
  ];

  for (const test of priority) {
    const match = candidates.find(test);
    if (match) return match;
  }

  return candidates[0];
}

// Read mint price per NFT from on-chain getters. Returns ETH string ("0" = free).
export async function readMintPrice(provider, contractAddress, abi) {
  const brute = [
    "price", "mintPrice", "cost", "getPrice", "publicSalePrice",
    "publicPrice", "salePrice", "tokenPrice", "tokenCost",
    "MINT_PRICE", "PRICE", "getPublicPrice", "getPricePerToken", "currentPrice",
  ];

  // Try ABI-defined view functions that return uint256 and look price-related
  if (abi) {
    const viewFns = abi.filter(
      (item) =>
        item.type === "function" &&
        (item.stateMutability === "view" || item.stateMutability === "pure") &&
        item.inputs.length === 0 &&
        item.outputs?.length === 1 &&
        item.outputs[0].type === "uint256" &&
        PRICE_KEYWORDS.some((kw) => item.name.toLowerCase().includes(kw))
    );

    for (const fn of viewFns) {
      try {
        const iface = new ethers.Interface([fn]);
        const result = await provider.call({ to: contractAddress, data: iface.encodeFunctionData(fn.name, []) });
        const [price] = iface.decodeFunctionResult(fn.name, result);
        if (price > 0n) return ethers.formatEther(price);
      } catch {}
    }
  }

  // Brute-force common names
  for (const name of brute) {
    try {
      const iface = new ethers.Interface([`function ${name}() view returns (uint256)`]);
      const data = iface.encodeFunctionData(name, []);
      const result = await provider.call({ to: contractAddress, data });
      const [price] = iface.decodeFunctionResult(name, result);
      if (price > 0n) return ethers.formatEther(price);
    } catch {}
  }

  return "0";
}

// Build calldata for the detected mint function.
// Returns hex string, or null if parameters are too exotic to encode safely.
export function buildMintCalldata(mintFn, quantity, walletAddress) {
  if (!mintFn) return null;

  const iface = new ethers.Interface([mintFn]);
  const inputs = mintFn.inputs;

  try {
    if (inputs.length === 0) {
      return iface.encodeFunctionData(mintFn.name, []);
    }

    if (inputs.length === 1 && inputs[0].type === "uint256") {
      return iface.encodeFunctionData(mintFn.name, [quantity]);
    }

    if (inputs.length === 2) {
      const [a, b] = inputs;
      if (a.type === "address" && b.type === "uint256") {
        return iface.encodeFunctionData(mintFn.name, [walletAddress, quantity]);
      }
      if (a.type === "uint256" && b.type === "address") {
        return iface.encodeFunctionData(mintFn.name, [quantity, walletAddress]);
      }
    }
  } catch {}

  return null;
}

export function mintFnSignature(mintFn) {
  if (!mintFn) return "mint()";
  return `${mintFn.name}(${mintFn.inputs.map((i) => i.type).join(",")})`;
}
