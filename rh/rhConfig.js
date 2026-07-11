// Robinhood Chain (4663) constants. Kept separate from mainnet config so nothing
// here can leak into the Ethereum copy-mint path.
export const RH_RPC_URL = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const RH_CHAIN_ID = Number(process.env.RH_CHAIN_ID || 4663);
export const RH_EXPLORER_TX = "https://robinhoodchain.blockscout.com/tx/";
export const RH_EXPLORER_ADDR = "https://robinhoodchain.blockscout.com/address/";

// How often to poll for new blocks. RH is HTTP-only (no public wss), and far less
// contested than mainnet, so a short poll is plenty — no MEV-war latency needed.
export const RH_POLL_MS = Number(process.env.RH_POLL_MS || 1500);

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
