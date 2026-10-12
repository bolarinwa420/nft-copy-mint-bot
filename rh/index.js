// Robinhood Chain copy-minter — single entry point.
// initRh(bot, notify) boots the isolated RH db, seeds the whale list, starts the
// polling scanner, and registers the /rh* Telegram commands. Called from bot.js
// ONLY when RH_ENABLED=true, so the mainnet bot is byte-for-byte unaffected when off.
import { ethers } from "ethers";
import { listWallets } from "../wallets.js";
import {
  initRhDb, seedTrackedOnce, getRhTracked, addRhTracked, removeRhTracked,
  getRhSettings, updateRhSettings, getRhMintLog,
} from "./rhStore.js";
import { initRhScanner, getRhProvider, rhScannerStatus } from "./rhScanner.js";
import { RH_EXPLORER_ADDR, RH_CHAIN_ID } from "./rhConfig.js";
import { diagnoseRhMint, formatRhDiagnosis } from "./rhDiagnose.js";
import { replicateRhMint } from "./rhReplicate.js";

const md = { parse_mode: "Markdown" };
const shortAddr = a => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?");

export async function initRh(bot, notify) {
  await initRhDb();
  const seed = await seedTrackedOnce();
  console.log(`[RH] Seed: ${seed.skipped ? "already seeded" : `imported ${seed.added || 0}`} (${seed.count} tracked)`);
  await initRhScanner(notify);

  bot.command("rhstatus", async (ctx) => {
    const s = getRhSettings();
    const st = rhScannerStatus();
    await ctx.reply(
      `🟣 *Robinhood Chain Copy-Minter*\n` +
      `Chain: ${RH_CHAIN_ID}\n` +
      `Auto-mint: ${s.enabled ? "🟢 ON" : "🔴 OFF"}  |  Mode: ${s.dryRun ? "🧪 DRY RUN" : "🚀 LIVE"}\n` +
      `Tracked whales: ${st.tracked}\n` +
      `Wallets firing: ${s.walletCount} (from top of pool)\n` +
      `Main wallet in pool: ${s.useMainWallet ? "🟢 yes (position #1)" : "🔴 no"}  |  sub-wallets loaded: ${listWallets().length}\n` +
      `Gas ceiling: ${s.gasCeilingGwei} gwei  |  Hard cap/wallet: ${s.maxMintNative}\n` +
      `Free mints: ${s.allowFreeMints ? `yes → max ${s.freeMintMax}/wallet` : "no"}\n` +
      `Ladder ($/NFT): <0.10→10 · 0.10-0.30→3 · 0.31-0.50→2 · 0.51-2.00→1 · >2→skip\n` +
      `Failed copies: diagnosed${s.prereqReplicate ? ` + replayed from main wallet (max ${s.prereqDailyMax}/day)` : " (alert only)"}  |  token cap: $${s.prereqCapUsd}\n` +
      `Head block: ${st.lastBlock}  |  scanned: ${st.scannedBlocks}  |  mints seen: ${st.seenMints}`,
      md
    );
  });

  bot.command("rhon", async (ctx) => { await updateRhSettings({ enabled: true }); ctx.reply("🟢 RH auto-mint ON"); });
  bot.command("rhoff", async (ctx) => { await updateRhSettings({ enabled: false }); ctx.reply("🔴 RH auto-mint OFF"); });
  bot.command("rhdry", async (ctx) => { await updateRhSettings({ dryRun: true }); ctx.reply("🧪 RH set to DRY RUN (simulate only, no broadcast)"); });
  bot.command("rhlive", async (ctx) => { await updateRhSettings({ dryRun: false }); ctx.reply("🚀 RH set to LIVE — real txs will broadcast. Fund wallets on RH first!"); });

  bot.command("rhtrack", async (ctx) => {
    const a = (ctx.match || "").trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return ctx.reply("Usage: /rhtrack 0xAddress");
    const added = await addRhTracked(a);
    ctx.reply(added ? `🐋 Now tracking \`${a}\` on RH` : `Already tracking \`${a}\``, md);
  });

  bot.command("rhuntrack", async (ctx) => {
    const a = (ctx.match || "").trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return ctx.reply("Usage: /rhuntrack 0xAddress");
    const removed = await removeRhTracked(a);
    ctx.reply(removed ? `❌ Untracked \`${a}\`` : "Not in list.", md);
  });

  bot.command("rhtracked", async (ctx) => {
    const list = getRhTracked();
    if (!list.length) return ctx.reply("No RH whales tracked.");
    const lines = list.slice(0, 60).map((a, i) => `${i + 1}. \`${a}\``).join("\n");
    ctx.reply(`🐋 *RH tracked (${list.length})*\n${lines}${list.length > 60 ? "\n…" : ""}`, md);
  });

  // set config: /rhcap 0.05 | /rhgas 5 | /rhwallets 100 | /rhfree on|off
  bot.command("rhcap", async (ctx) => {
    const v = (ctx.match || "").trim();
    if (!/^\d*\.?\d+$/.test(v)) return ctx.reply("Usage: /rhcap 0.05  (max native spend per wallet)");
    await updateRhSettings({ maxMintNative: v }); ctx.reply(`💰 RH max spend/wallet = ${v}`);
  });
  bot.command("rhgas", async (ctx) => {
    const v = Number((ctx.match || "").trim());
    if (!v || v <= 0) return ctx.reply("Usage: /rhgas 5  (gas ceiling in gwei)");
    await updateRhSettings({ gasCeilingGwei: v }); ctx.reply(`⛽ RH gas ceiling = ${v} gwei`);
  });
  bot.command("rhwallets", async (ctx) => {
    const arg = (ctx.match || "").trim();
    if (arg) {
      const n = Number(arg);
      if (!n || n < 1) return ctx.reply("Usage: /rhwallets 100  (how many wallets to fire)");
      await updateRhSettings({ walletCount: n });
      return ctx.reply(`👛 RH will fire from ${n} wallet(s)`);
    }
    // no arg → show native balances of the firing pool on RH, in FIRING ORDER
    const provider = getRhProvider();
    const s = getRhSettings();
    const pool = [];
    if (s.useMainWallet && process.env.MAIN_PRIVATE_KEY) {
      try { pool.push({ addr: new ethers.Wallet(process.env.MAIN_PRIVATE_KEY).address, tag: "MAIN" }); } catch {}
    }
    for (const a of listWallets()) pool.push({ addr: a, tag: "sub" });
    if (!pool.length) return ctx.reply("No wallets in pool. Enable /rhmain on or import sub-wallets.");
    const sample = pool.slice(0, 15);
    const bals = await Promise.all(sample.map(w => provider.getBalance(w.addr).catch(() => null)));
    const lines = sample.map((w, i) =>
      `#${i + 1} ${w.tag === "MAIN" ? "👑" : "  "}\`${shortAddr(w.addr)}\` — ${bals[i] == null ? "?" : (+ethers.formatEther(bals[i])).toFixed(4)}`
    ).join("\n");
    ctx.reply(
      `👛 *RH pool balances* (firing order, first ${sample.length}/${pool.length})\n${lines}\n\n` +
      `Firing top *${s.walletCount}*. \`#1\` is what \`/rhwallets 1\` uses.\n[explorer](${RH_EXPLORER_ADDR}${sample[0].addr})`,
      md
    );
  });
  bot.command("rhmain", async (ctx) => {
    const v = (ctx.match || "").trim().toLowerCase();
    if (v !== "on" && v !== "off") return ctx.reply("Usage: /rhmain on|off  (include the MAIN wallet as pool position #1)");
    await updateRhSettings({ useMainWallet: v === "on" });
    ctx.reply(`👑 Main wallet ${v === "on" ? "INCLUDED as pool #1" : "excluded from pool"}`);
  });
  bot.command("rhfree", async (ctx) => {
    const v = (ctx.match || "").trim().toLowerCase();
    if (v !== "on" && v !== "off") return ctx.reply("Usage: /rhfree on|off");
    await updateRhSettings({ allowFreeMints: v === "on" }); ctx.reply(`RH free mints ${v === "on" ? "enabled" : "disabled"}`);
  });

  // Explain how a wallet got a mint through: /rhdiag 0xTxHash
  bot.command("rhdiag", async (ctx) => {
    const h = (ctx.match || "").trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(h)) return ctx.reply("Usage: /rhdiag 0xTxHash  (a mint tx on Robinhood Chain)");
    const provider = getRhProvider();
    try {
      const tx = await provider.getTransaction(h);
      if (!tx) return ctx.reply("Tx not found on Robinhood Chain.");
      await ctx.reply("🔎 Reading the wallet's last ~2.5h…");
      const r = await diagnoseRhMint({ hash: h, from: tx.from, to: tx.to }, provider, { capUsd: getRhSettings().prereqCapUsd });
      await ctx.reply(formatRhDiagnosis(r), { ...md, link_preview_options: { is_disabled: true } });
    } catch (e) {
      ctx.reply(`Diagnosis failed: ${e.message}`);
    }
  });
  // Diagnose a whale's mint AND plan our copy of it: /rhcopy 0xTxHash
  bot.command("rhcopy", async (ctx) => {
    const [h, go] = (ctx.match || "").trim().toLowerCase().split(/\s+/);
    if (!/^0x[0-9a-f]{64}$/.test(h || "")) return ctx.reply("Usage: /rhcopy 0xTxHash  (plan only)  |  /rhcopy 0xTxHash go  (plan, then send it)");
    const provider = getRhProvider();
    const say = (text) => ctx.reply(text, { ...md, link_preview_options: { is_disabled: true } });
    try {
      const tx = await provider.getTransaction(h);
      if (!tx?.to) return ctx.reply("Tx not found on Robinhood Chain.");
      await ctx.reply("🔎 Tracing the whale's path and simulating ours…");
      const r = await diagnoseRhMint({ hash: h, from: tx.from, to: tx.to }, provider, { capUsd: getRhSettings().prereqCapUsd });
      await say(formatRhDiagnosis(r));
      await replicateRhMint(r, { hash: h, from: tx.from, to: tx.to, input: tx.data, value: tx.value }, provider, say, { manual: true, send: go === "go" });
    } catch (e) {
      ctx.reply(`Replay planning failed: ${e.message}`);
    }
  });
  bot.command("rhreplicate", async (ctx) => {
    const v = (ctx.match || "").trim().toLowerCase();
    if (v !== "on" && v !== "off") return ctx.reply("Usage: /rhreplicate on|off  (replay the whale's buy → burn → mint from the main wallet when our copy fails)");
    await updateRhSettings({ prereqReplicate: v === "on" });
    ctx.reply(`🔁 RH replay ${v === "on" ? "ON" : "OFF"}`);
  });
  bot.command("rhprereqcap", async (ctx) => {
    const v = Number((ctx.match || "").trim());
    if (!(v >= 0) || (ctx.match || "").trim() === "") return ctx.reply(`Usage: /rhprereqcap 1.2  (max $ of token to buy per wallet for a mint — now $${getRhSettings().prereqCapUsd})`);
    await updateRhSettings({ prereqCapUsd: v }); ctx.reply(`🪙 RH prerequisite-token cap = $${v} per wallet`);
  });

  bot.command("rhhistory", async (ctx) => {
    const log = getRhMintLog().slice(-10).reverse();
    if (!log.length) return ctx.reply("No RH mints logged yet.");
    const lines = log.map(e => `\`${shortAddr(e.contract)}\` ← \`${shortAddr(e.wallet)}\` (${e.txHash?.slice(0, 8)})`).join("\n");
    ctx.reply(`📜 *RH mint history*\n${lines}`, md);
  });

  console.log("[RH] Commands registered: /rhstatus /rhon /rhoff /rhdry /rhlive /rhtrack /rhuntrack /rhtracked /rhcap /rhgas /rhwallets /rhmain /rhfree /rhdiag /rhcopy /rhreplicate /rhprereqcap /rhhistory");
}
