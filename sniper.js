// sniper.js — "mint the moment it opens" for OpenSea SeaDrop public drops.
//
// Given an NFT contract + the on-chain public-drop startTime, it wakes a few seconds early,
// fast-polls getPublicDrop, and fires mintPublic from the dedicated mint pool the instant
// the window is live. Snipes persist in storage so a Railway restart re-arms them.

import { ethers } from "ethers";
import { readSeadropSchedule, SEADROP_ADDRESS, buildMintAllowListCalldata } from "./mintInspector.js";
import { executeManualMint, executePerWalletMint } from "./copymint.js";
import { getMintSigners } from "./wallets.js";
import { addSnipe, getSnipes, updateSnipe, getSettings } from "./storage.js";
import { computeGas } from "./gas.js";

const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
const LEAD_MS = 5_000;          // start polling 5s before the expected open
const POLL_MS = 250;            // poll cadence near open
const POLL_WINDOW_MS = 120_000; // give up 2 min after expected open if it never goes live

let provider;
let notifyFn;
let flashbotsProvider; // optional private-mempool send path
const timers = new Map(); // snipeId -> timeout

export function initSniper(ethProvider, notify, fbProvider = null) {
  provider = ethProvider;
  notifyFn = notify;
  flashbotsProvider = fbProvider;
  restoreSnipes();
}

// Build the gas + send options for a competitive fire: war-tier gas, optional Flashbots-private send.
async function fireOpts(signers) {
  const s = getSettings();
  const gas = await computeGas(provider, "war", s.gasCeilingGwei || 200);
  const sendVia = s.privateSnipe && flashbotsProvider ? flashbotsProvider : undefined;
  return { signers, gas, sendVia };
}

function buildMintPublicCalldata(nftContract, qty) {
  const iface = new ethers.Interface([
    "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)",
  ]);
  return iface.encodeFunctionData("mintPublic", [
    nftContract,
    OPENSEA_FEE_RECIPIENT,
    ethers.ZeroAddress, // address(0) → mints to msg.sender (each wallet mints for itself)
    qty,
  ]);
}

// Public API: arm a snipe.
//   mode "public"    → fires mintPublic when the SeaDrop public window goes live
//   mode "allowlist" → fires mintAllowList per-wallet at startTime; needs feeRecipient + entries{addr:{mintParams,proof}}
export async function scheduleSnipe({ nftContract, qty = 1, startTime, label, mode = "public", feeRecipient, entries }) {
  const snipe = {
    id: Math.random().toString(36).slice(2, 10),
    nftContract: ethers.getAddress(nftContract),
    qty: Math.max(1, qty),
    startTime, // unix seconds
    label: label || nftContract.slice(0, 10),
    mode,
    feeRecipient: feeRecipient || null,
    entries: entries || null, // { "0xaddr": { mintParams:[8], proof:[...] } }
    status: "armed",
    createdAt: Date.now(),
  };
  await addSnipe(snipe);
  arm(snipe);
  return snipe;
}

function restoreSnipes() {
  const snipes = getSnipes().filter((s) => s.status === "armed" || s.status === "firing");
  for (const s of snipes) arm(s);
  if (snipes.length) console.log(`[Sniper] Re-armed ${snipes.length} snipe(s)`);
}

function arm(snipe) {
  if (timers.has(snipe.id)) clearTimeout(timers.get(snipe.id));
  const fireAt = snipe.startTime * 1000;
  const delay = Math.max(0, fireAt - Date.now() - LEAD_MS);
  timers.set(snipe.id, setTimeout(() => beginPolling(snipe), delay));
}

async function beginPolling(snipe) {
  const deadline = snipe.startTime * 1000 + POLL_WINDOW_MS;

  const tick = async () => {
    if (Date.now() > deadline) {
      timers.delete(snipe.id);
      await updateSnipe(snipe.id, { status: "missed" });
      await notifyFn(`⏰ *Snipe missed* — \`${snipe.label}\` never went live within the window.`);
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    if (snipe.mode === "allowlist") {
      // Allowlist times live in mintParams; fire as soon as the stage start is reached
      if (now >= snipe.startTime) {
        timers.delete(snipe.id);
        await fireAllowlist(snipe);
        return;
      }
    } else {
      let sched = null;
      try { sched = await readSeadropSchedule(provider, snipe.nftContract); } catch {}
      const pub = sched?.public;
      if (pub && pub.startTime > 0 && now >= pub.startTime && (!pub.endTime || now <= pub.endTime)) {
        timers.delete(snipe.id);
        await fire(snipe, pub);
        return;
      }
    }
    timers.set(snipe.id, setTimeout(tick, POLL_MS));
  };

  await tick();
}

async function fireAllowlist(snipe) {
  await updateSnipe(snipe.id, { status: "firing" });
  const signers = getMintSigners(provider).filter((s) => snipe.entries?.[s.address.toLowerCase()]);
  if (signers.length === 0) {
    await updateSnipe(snipe.id, { status: "failed" });
    return notifyFn(`❌ *Allowlist snipe failed* — none of your mint-pool wallets are on the allowlist.`);
  }

  // All addresses in a stage share the same price; read it from any entry
  const sample = snipe.entries[signers[0].address.toLowerCase()];
  const priceWei = BigInt(sample.mintParams[0]);
  const totalValue = ethers.formatEther(priceWei * BigInt(snipe.qty));

  const calldataFn = (address) => {
    const e = snipe.entries[address.toLowerCase()];
    if (!e) return null;
    return buildMintAllowListCalldata(
      snipe.nftContract, snipe.feeRecipient, ethers.ZeroAddress, snipe.qty, e.mintParams, e.proof
    );
  };

  await notifyFn(
    `🚨 *${snipe.label} allowlist is LIVE — sniping now!*\n\n` +
    `Contract: \`${snipe.nftContract}\`\n` +
    `Price: ${priceWei === 0n ? "FREE" : `${ethers.formatEther(priceWei)} ETH`} × ${snipe.qty}\n` +
    `Qualifying wallets: ${signers.length}\n\n_Firing..._`
  );

  try {
    const r = await executePerWalletMint(SEADROP_ADDRESS, calldataFn, totalValue, null, await fireOpts(signers));
    await updateSnipe(snipe.id, { status: "done" });
    await notifyFn(
      `✅ *Allowlist snipe complete — ${snipe.label}*\n\n` +
      `✅ Succeeded: ${r.succeeded}\n❌ Failed: ${r.failed}\n⏭️ Skipped: ${r.skipped}\n📊 Wallets: ${r.total}`
    );
  } catch (err) {
    await updateSnipe(snipe.id, { status: "failed" });
    await notifyFn(`❌ *Allowlist snipe failed* — ${err.message}`);
  }
}

async function fire(snipe, pub) {
  await updateSnipe(snipe.id, { status: "firing" });
  const signers = getMintSigners(provider);
  if (signers.length === 0) {
    await updateSnipe(snipe.id, { status: "failed" });
    return notifyFn(`❌ *Snipe failed* — mint pool is empty. Add wallets with /addmintwallet.`);
  }

  const calldata = buildMintPublicCalldata(snipe.nftContract, snipe.qty);
  const totalValue = (parseFloat(pub.price) * snipe.qty).toFixed(18);

  await notifyFn(
    `🚨 *${snipe.label} is LIVE — sniping now!*\n\n` +
    `Contract: \`${snipe.nftContract}\`\n` +
    `Price: ${pub.price === "0" ? "FREE" : `${pub.price} ETH`} × ${snipe.qty}\n` +
    `Wallets: ${signers.length} (mint pool)\n\n_Firing..._`
  );

  try {
    // SeaDrop mints go through the router; value = price × qty per wallet
    const r = await executeManualMint(SEADROP_ADDRESS, calldata, totalValue, null, await fireOpts(signers));
    await updateSnipe(snipe.id, { status: "done" });
    await notifyFn(
      `✅ *Snipe complete — ${snipe.label}*\n\n` +
      `✅ Succeeded: ${r.succeeded}\n❌ Failed: ${r.failed}\n⏭️ Skipped (low balance): ${r.skipped}\n📊 Wallets: ${r.total}`
    );
  } catch (err) {
    await updateSnipe(snipe.id, { status: "failed" });
    await notifyFn(`❌ *Snipe failed* — ${err.message}`);
  }
}

export function listSnipes() {
  return getSnipes().filter((s) => s.status === "armed" || s.status === "firing");
}

export async function cancelSnipe(id) {
  if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
  await updateSnipe(id, { status: "cancelled" });
}
