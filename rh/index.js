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
      `Wallets firing: ${s.walletCount} (of ${listWallets().length} loaded)\n` +
      `Gas ceiling: ${s.gasCeilingGwei} gwei  |  Max spend/wallet: ${s.maxMintNative}\n` +
      `Free mints: ${s.allowFreeMints ? "yes" : "no"}\n` +
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
    // no arg → show native balances of the pool on RH
    const provider = getRhProvider();
    const addrs = listWallets();
    if (!addrs.length) return ctx.reply("No sub-wallets loaded.");
    const sample = addrs.slice(0, 15);
    const bals = await Promise.all(sample.map(a => provider.getBalance(a).catch(() => null)));
    let total = 0n; const okBals = [];
    for (const b of bals) if (b != null) { total += b; okBals.push(b); }
    const lines = sample.map((a, i) => `\`${shortAddr(a)}\` — ${bals[i] == null ? "?" : (+ethers.formatEther(bals[i])).toFixed(4)}`).join("\n");
    ctx.reply(
      `👛 *RH native balances* (first ${sample.length}/${addrs.length})\n${lines}\n\n` +
      `Sampled total: ${(+ethers.formatEther(total)).toFixed(4)}\n[explorer](${RH_EXPLORER_ADDR}${addrs[0]})`,
      md
    );
  });
  bot.command("rhfree", async (ctx) => {
    const v = (ctx.match || "").trim().toLowerCase();
    if (v !== "on" && v !== "off") return ctx.reply("Usage: /rhfree on|off");
    await updateRhSettings({ allowFreeMints: v === "on" }); ctx.reply(`RH free mints ${v === "on" ? "enabled" : "disabled"}`);
  });

  bot.command("rhhistory", async (ctx) => {
    const log = getRhMintLog().slice(-10).reverse();
    if (!log.length) return ctx.reply("No RH mints logged yet.");
    const lines = log.map(e => `\`${shortAddr(e.contract)}\` ← \`${shortAddr(e.wallet)}\` (${e.txHash?.slice(0, 8)})`).join("\n");
    ctx.reply(`📜 *RH mint history*\n${lines}`, md);
  });

  console.log("[RH] Commands registered: /rhstatus /rhon /rhoff /rhdry /rhlive /rhtrack /rhuntrack /rhtracked /rhcap /rhgas /rhwallets /rhfree /rhhistory");
}
