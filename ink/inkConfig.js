// Ink (57073, Kraken OP-stack L2) constants. Kept separate from mainnet config so nothing
// here can leak into the Ethereum copy-mint path.
export const INK_RPC_URL = process.env.INK_RPC_URL || "https://rpc-qnd.inkonchain.com";
export const INK_CHAIN_ID = Number(process.env.INK_CHAIN_ID || 57073);
export const INK_EXPLORER_TX = "https://explorer.inkonchain.com/tx/";
export const INK_EXPLORER_ADDR = "https://explorer.inkonchain.com/address/";
export const INK_EXPLORER_API = "https://explorer.inkonchain.com/api/v2";

// Ink RPCs cap getLogs at 1k (gel, thirdweb) or 10k (qnd) blocks — useless for
// "every v4 pool ever initialized". Blockscout's etherscan-style logs API has no
// range cap (max 1000 rows), so long lookbacks go through it. Returns logs shaped
// like ethers' ({ address, topics, data, blockNumber, index, transactionHash }).
export async function explorerLogs({ address, topics = [], fromBlock = 0 }) {
  const q = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: String(fromBlock), toBlock: "latest", address });
  const set = topics.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
  for (const i of set) q.set(`topic${i}`, topics[i].toLowerCase());
  for (let a = 0; a < set.length; a++) for (let b = a + 1; b < set.length; b++) q.set(`topic${set[a]}_${set[b]}_opr`, "and");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch(`https://explorer.inkonchain.com/api?${q}`, { signal: ctl.signal });
    const d = await r.json();
    if (!Array.isArray(d.result)) return [];
    return d.result.map((l) => ({
      address: l.address, topics: l.topics.filter(Boolean), data: l.data,
      blockNumber: Number(l.blockNumber), index: Number(l.logIndex || 0), transactionHash: l.transactionHash,
    }));
  } catch { return []; }
  finally { clearTimeout(t); }
}

// DEX addresses the mint diagnoser uses to price a token a whale had to buy.
// Same deployments the rh-copy-trader trades through.
export const INK_DEX = {
  // No verified Uniswap v2 Router02 on Ink yet — v2 quotes/routes are skipped
  // when null; pricing falls back to the explorer and v4 pools.
  v2Router: process.env.INK_V2_ROUTER || null,
  weth: "0x4200000000000000000000000000000000000006",
  usdg: "0x2D270e6886d130D724215A266106e6832161EAEd", // native USDC (slot kept as "usdg" for parity with rh/)
  // Uniswap deployments on Ink (bytecode checked on chain 2026-10-15).
  universalRouter: "0x112908dac86e20e7241b0927479ea3bf935d1fa0",
  poolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
  stateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
  // RH's router takes an extra uint256 minHopPriceX36 in ExactInputSingleParams;
  // stock v4-periphery doesn't. Set by whichever layout simulates on Ink.
  v4MinHopField: process.env.INK_V4_MINHOP === "true",
};

// How often to poll for new blocks. Ink has ~1s blocks and is far less
// contested than mainnet, so a short poll is plenty — no MEV-war latency needed.
export const INK_POLL_MS = Number(process.env.INK_POLL_MS || 500);

// Same NFT mint selectors the mainnet blockScanner uses. Copied (not imported) so
// the Ink scanner has zero coupling to the mainnet module. Signature/voucher mints
// (0x4b61cd6f, 0x4a9eee69) are intentionally EXCLUDED here — they're wallet-bound
// and uncopyable, so we don't want to fire on them on Ink.
export const INK_MINT_SELECTORS = new Set([
  "0xa0712d68", "0x1249c58b", "0x6a627842", "0x40c10f19",
  "0x2db11544", "0x84bb1e42", "0xd96a094a", "0xd0def521",
  "0xe7572e43", "0x5eca0752", "0x488a7b25", "0x81012e40",
  "0x0c143a93", "0x4b5f1bd2", "0x8b83209b", "0xf3aaf5b7",
  "0x161ac21f", "0x9dbb844d", "0xefef39a1",
  "0xd85d3d27", "0xfa7b9a7b", "0x57bc3d78",
]);

export function isInkMintTx(input) {
  if (!input || input === "0x" || input.length < 10) return false;
  return INK_MINT_SELECTORS.has(input.slice(0, 10).toLowerCase());
}
