// gas.js — EIP-1559 gas tiers for competitive mints.
//
// The priority fee (tip) is what actually wins the race when many bots hit the same block.
// Tiers scale the tip; a hard ceiling on maxFeePerGas keeps you from overpaying catastrophically.

import { ethers } from "ethers";

export const GAS_TIERS = {
  normal: { tipGwei: 2,  baseMult: 2n, emoji: "🐢" },
  fast:   { tipGwei: 8,  baseMult: 2n, emoji: "⚡" },
  war:    { tipGwei: 30, baseMult: 3n, emoji: "🔥" },
};

// Compute { maxFeePerGas, maxPriorityFeePerGas } for a tier, capped at ceilingGwei.
export async function computeGas(provider, tier = "fast", ceilingGwei = 200) {
  const t = GAS_TIERS[tier] || GAS_TIERS.fast;
  let baseFee;
  try {
    const fd = await provider.getFeeData();
    if (fd.maxFeePerGas && fd.maxPriorityFeePerGas) baseFee = fd.maxFeePerGas - fd.maxPriorityFeePerGas;
    else if (fd.gasPrice) baseFee = fd.gasPrice;
  } catch {}
  if (!baseFee || baseFee <= 0n) baseFee = ethers.parseUnits("20", "gwei");

  const tip = ethers.parseUnits(String(t.tipGwei), "gwei");
  let maxFee = baseFee * t.baseMult + tip;

  const ceiling = ethers.parseUnits(String(ceilingGwei), "gwei");
  if (maxFee > ceiling) maxFee = ceiling;

  let priority = tip;
  if (priority > maxFee) priority = maxFee; // never let tip exceed the cap

  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, baseFee };
}

export function gweiOf(wei) {
  return Number(ethers.formatUnits(wei, "gwei")).toFixed(1);
}
