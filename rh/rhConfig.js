// Robinhood Chain (4663) constants. Kept separate from mainnet config so nothing
// here can leak into the Ethereum copy-mint path.
export const RH_RPC_URL = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const RH_CHAIN_ID = Number(process.env.RH_CHAIN_ID || 4663);
export const RH_EXPLORER_TX = "https://robinhoodchain.blockscout.com/tx/";
export const RH_EXPLORER_ADDR = "https://robinhoodchain.blockscout.com/address/";
export const RH_EXPLORER_API = "https://robinhoodchain.blockscout.com/api/v2";

// DEX addresses the mint diagnoser uses to price a token a whale had to buy.
// Same deployments the rh-copy-trader trades through.
export const RH_DEX = {
  v2Router: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  // Used by the replicator to rebuild a whale's swap route (v2 / v3 / v4 hops).
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
};

// How often to poll for new blocks. RH is HTTP-only (no public wss), and far less
// contested than mainnet, so a short poll is plenty — no MEV-war latency needed.
export const RH_POLL_MS = Number(process.env.RH_POLL_MS || 500);

// Same NFT mint selectors the mainnet blockScanner uses. Copied (not imported) so
// the RH scanner has zero coupling to the mainnet module. Signature/voucher mints
// (0x4b61cd6f, 0x4a9eee69) are intentionally EXCLUDED here — they're wallet-bound
// and uncopyable, so we don't want to fire on them on RH.
export const RH_MINT_SELECTORS = new Set([
  "0xa0712d68", "0x1249c58b", "0x6a627842", "0x40c10f19",
  "0x2db11544", "0x84bb1e42", "0xd96a094a", "0xd0def521",
  "0xe7572e43", "0x5eca0752", "0x488a7b25", "0x81012e40",
  "0x0c143a93", "0x4b5f1bd2", "0x8b83209b", "0xf3aaf5b7",
  "0x161ac21f", "0x9dbb844d", "0xefef39a1",
  "0xd85d3d27", "0xfa7b9a7b", "0x57bc3d78",
]);

export function isRhMintTx(input) {
  if (!input || input === "0x" || input.length < 10) return false;
  return RH_MINT_SELECTORS.has(input.slice(0, 10).toLowerCase());
}
