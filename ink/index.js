// Ink copy-minter — single entry point.
// initInk(bot, notify) boots the isolated Ink db, seeds the whale list, starts the
// polling scanner, and registers the /ink* Telegram commands. Called from bot.js
// ONLY when INK_ENABLED=true, so the mainnet bot is byte-for-byte unaffected when off.
import { ethers } from "ethers";
import { listWallets } from "../wallets.js";
import {
  initInkDb, seedTrackedOnce, getInkTracked, addInkTracked, removeInkTracked,
  getInkSettings, updateInkSettings, getInkMintLog,
} from "./inkStore.js";
import { initInkScanner, getInkProvider, inkScannerStatus } from "./inkScanner.js";
import { INK_EXPLORER_ADDR, INK_CHAIN_ID } from "./inkConfig.js";
import { diagnoseInkMint, formatInkDiagnosis } from "./inkDiagnose.js";
import { replicateInkMint } from "./inkReplicate.js";

const md = { parse_mode: "Markdown" };
const shortAddr = a => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?");

export async function initInk(bot, notify) {
  await initInkDb();
  const seed = await seedTrackedOnce();
  console.log(`[INK] Seed: ${seed.skipped ? "already seeded" : `imported ${seed.added || 0}`} (${seed.count} tracked)`);
  await initInkScanner(notify);

  bot.command("inkstatus", async (ctx) => {
    const s = getInkSettings();
    const st = inkScannerStatus();
    await ctx.reply(
      `🟣 *Ink Copy-Minter*\n` +
      `Chain: ${INK_CHAIN_ID}\n` +
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

  bot.command("inkon", async (ctx) => { await updateInkSettings({ enabled: true }); ctx.reply("🟢 Ink auto-mint ON"); });
  bot.command("inkoff", async (ctx) => { await updateInkSettings({ enabled: false }); ctx.reply("🔴 Ink auto-mint OFF"); });
  bot.command("inkdry", async (ctx) => { await updateInkSettings({ dryRun: true }); ctx.reply("🧪 Ink set to DRY RUN (simulate only, no broadcast)"); });
  bot.command("inklive", async (ctx) => { await updateInkSettings({ dryRun: false }); ctx.reply("🚀 Ink set to LIVE — real txs will broadcast. Fund wallets on Ink first!"); });

  bot.command("inktrack", async (ctx) => {
    const a = (ctx.match || "").trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return ctx.reply("Usage: /inktrack 0xAddress");
    const added = await addInkTracked(a);
    ctx.reply(added ? `🐋 Now tracking \`${a}\` on Ink` : `Already tracking \`${a}\``, md);
  });

  bot.command("inkuntrack", async (ctx) => {
    const a = (ctx.match || "").trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return ctx.reply("Usage: /inkuntrack 0xAddress");
    const removed = await removeInkTracked(a);
    ctx.reply(removed ? `❌ Untracked \`${a}\`` : "Not in list.", md);
  });

  bot.command("inktracked", async (ctx) => {
    const list = getInkTracked();
    if (!list.length) return ctx.reply("No Ink whales tracked.");
    const lines = list.slice(0, 60).map((a, i) => `${i + 1}. \`${a}\``).join("\n");
    ctx.reply(`🐋 *Ink tracked (${list.length})*\n${lines}${list.length > 60 ? "\n…" : ""}`, md);
  });

  // set config: /inkcap 0.05 | /inkgas 5 | /inkwallets 100 | /inkfree on|off
  bot.command("inkcap", async (ctx) => {
    const v = (ctx.match || "").trim();
    if (!/^\d*\.?\d+$/.test(v)) return ctx.reply("Usage: /inkcap 0.05  (max native spend per wallet)");
    await updateInkSettings({ maxMintNative: v }); ctx.reply(`💰 Ink max spend/wallet = ${v}`);
  });
  bot.command("inkgas", async (ctx) => {
    const v = Number((ctx.match || "").trim());
    if (!v || v <= 0) return ctx.reply("Usage: /inkgas 5  (gas ceiling in gwei)");
    await updateInkSettings({ gasCeilingGwei: v }); ctx.reply(`⛽ Ink gas ceiling = ${v} gwei`);
  });
  bot.command("inkwallets", async (ctx) => {
    const arg = (ctx.match || "").trim();
    if (arg) {
      const n = Number(arg);
      if (!n || n < 1) return ctx.reply("Usage: /inkwallets 100  (how many wallets to fire)");
      await updateInkSettings({ walletCount: n });
      return ctx.reply(`👛 Ink will fire from ${n} wallet(s)`);
    }
    // no arg → show native balances of the firing pool on Ink, in FIRING ORDER
    const provider = getInkProvider();
    const s = getInkSettings();
    const pool = [];
    if (s.useMainWallet && process.env.MAIN_PRIVATE_KEY) {
      try { pool.push({ addr: new ethers.Wallet(process.env.MAIN_PRIVATE_KEY).address, tag: "MAIN" }); } catch {}
    }
    for (const a of listWallets()) pool.push({ addr: a, tag: "sub" });
    if (!pool.length) return ctx.reply("No wallets in pool. Enable /inkmain on or import sub-wallets.");
    const sample = pool.slice(0, 15);
    const bals = await Promise.all(sample.map(w => provider.getBalance(w.addr).catch(() => null)));
    const lines = sample.map((w, i) =>
      `#${i + 1} ${w.tag === "MAIN" ? "👑" : "  "}\`${shortAddr(w.addr)}\` — ${bals[i] == null ? "?" : (+ethers.formatEther(bals[i])).toFixed(4)}`
    ).join("\n");
    ctx.reply(
      `👛 *Ink pool balances* (firing order, first ${sample.length}/${pool.length})\n${lines}\n\n` +
      `Firing top *${s.walletCount}*. \`#1\` is what \`/inkwallets 1\` uses.\n[explorer](${INK_EXPLORER_ADDR}${sample[0].addr})`,
      md
    );
  });
  bot.command("inkmain", async (ctx) => {
    const v = (ctx.match || "").trim().toLowerCase();
    if (v !== "on" && v !== "off") return ctx.reply("Usage: /inkmain on|off  (include the MAIN wallet as pool position #1)");
    await updateInkSettings({ useMainWallet: v === "on" });
    ctx.reply(`👑 Main wallet ${v === "on" ? "INCLUDED as pool #1" : "excluded from pool"}`);
  });
  bot.command("inkfree", async (ctx) => {
    const v = (ctx.match || "").trim().toLowerCase();
    if (v !== "on" && v !== "off") return ctx.reply("Usage: /inkfree on|off");
    await updateInkSettings({ allowFreeMints: v === "on" }); ctx.reply(`Ink free mints ${v === "on" ? "enabled" : "disabled"}`);
  });

  // Explain how a wallet got a mint through: /inkdiag 0xTxHash
  bot.command("inkdiag", async (ctx) => {
    const h = (ctx.match || "").trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(h)) return ctx.reply("Usage: /inkdiag 0xTxHash  (a mint tx on Ink)");
    const provider = getInkProvider();
    try {
      const tx = await provider.getTransaction(h);
      if (!tx) return ctx.reply("Tx not found on Ink.");
      await ctx.reply("🔎 Reading the wallet's last ~2.5h…");
      const r = await diagnoseInkMint({ hash: h, from: tx.from, to: tx.to }, provider, { capUsd: getInkSettings().prereqCapUsd });
      await ctx.reply(formatInkDiagnosis(r), { ...md, link_preview_options: { is_disabled: true } });
    } catch (e) {
      ctx.reply(`Diagnosis failed: ${e.message}`);
    }
  });
  // Diagnose a whale's mint AND plan our copy of it: /inkcopy 0xTxHash
  bot.command("inkcopy", async (ctx) => {
    const [h, go] = (ctx.match || "").trim().toLowerCase().split(/\s+/);
    if (!/^0x[0-9a-f]{64}$/.test(h || "")) return ctx.reply("Usage: /inkcopy 0xTxHash  (plan only)  |  /inkcopy 0xTxHash go  (plan, then send it)");
    const provider = getInkProvider();
    const say = (text) => ctx.reply(text, { ...md, link_preview_options: { is_disabled: true } });
    try {
      const tx = await provider.getTransaction(h);
      if (!tx?.to) return ctx.reply("Tx not found on Ink.");
      await ctx.reply("🔎 Tracing the whale's path and simulating ours…");
      const r = await diagnoseInkMint({ hash: h, from: tx.from, to: tx.to }, provider, { capUsd: getInkSettings().prereqCapUsd });
      await say(formatInkDiagnosis(r));
      await replicateInkMint(r, { hash: h, from: tx.from, to: tx.to, input: tx.data, value: tx.value }, provider, say, { manual: true, send: go === "go" });
    } catch (e) {
      ctx.reply(`Replay planning failed: ${e.message}`);
    }
  });
  bot.command("inkreplicate", async (ctx) => {
    const v = (ctx.match || "").trim().toLowerCase();
    if (v !== "on" && v !== "off") return ctx.reply("Usage: /inkreplicate on|off  (replay the whale's buy → burn → mint from the main wallet when our copy fails)");
    await updateInkSettings({ prereqReplicate: v === "on" });
    ctx.reply(`🔁 Ink replay ${v === "on" ? "ON" : "OFF"}`);
  });
  bot.command("inkprereqcap", async (ctx) => {
    const v = Number((ctx.match || "").trim());
    if (!(v >= 0) || (ctx.match || "").trim() === "") return ctx.reply(`Usage: /inkprereqcap 1.2  (max $ of token to buy per wallet for a mint — now $${getInkSettings().prereqCapUsd})`);
    await updateInkSettings({ prereqCapUsd: v }); ctx.reply(`🪙 Ink prerequisite-token cap = $${v} per wallet`);
  });

  bot.command("inkhistory", async (ctx) => {
    const log = getInkMintLog().slice(-10).reverse();
    if (!log.length) return ctx.reply("No Ink mints logged yet.");
    const lines = log.map(e => `\`${shortAddr(e.contract)}\` ← \`${shortAddr(e.wallet)}\` (${e.txHash?.slice(0, 8)})`).join("\n");
    ctx.reply(`📜 *Ink mint history*\n${lines}`, md);
  });

  console.log("[INK] Commands registered: /inkstatus /inkon /inkoff /inkdry /inklive /inktrack /inkuntrack /inktracked /inkcap /inkgas /inkwallets /inkmain /inkfree /inkdiag /inkcopy /inkreplicate /inkprereqcap /inkhistory");
}
