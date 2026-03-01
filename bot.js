import "dotenv/config";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { ethers } from "ethers";
import { initDb, addTracked, removeTracked, getTracked, getSettings, updateSettings, createGroup, deleteGroup, getGroups, getGroupWallets, addToWhitelist, removeFromWhitelist, addToBlacklist, removeFromBlacklist, getMintLog } from "./storage.js";
import { addWallet, deleteWallet, listWallets, distributeGas, sweepGas, sweepNFTs, getGroupPrivateKeys } from "./wallets.js";
import { initTracker, startTracking, restartTracking } from "./tracker.js";
import { initCopyMint, resolveApproval, executeManualMint } from "./copymint.js";
import { initScheduler, createJob, cancelJob, getPendingJobs } from "./scheduler.js";

// ─── Init ────────────────────────────────────────────────────────────────────

await initDb();

const bot = new Bot(process.env.BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(
  `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
);
const mainSigner = new ethers.Wallet(process.env.MAIN_PRIVATE_KEY, provider);
const MAIN_ADDRESS = await mainSigner.getAddress();

// Bot notification function — sends to alert chat or falls back to admin
async function notify(text, txHash) {
  const settings = getSettings();
  const chatId = settings.alertChatId || process.env.ALERT_CHAT_ID;
  if (!chatId) return;

  let msg = text;
  const opts = { parse_mode: "Markdown" };

  if (txHash) {
    const kb = new InlineKeyboard().url(
      "🔗 View Transaction",
      `https://etherscan.io/tx/${txHash}`
    );
    opts.reply_markup = kb;
  }

  try {
    await bot.api.sendMessage(chatId, msg, opts);
  } catch (err) {
    console.error("[Notify] Failed:", err.message);
  }
}

// Approval prompt — sent when mint price exceeds limit
async function askApproval({ mintId, usdCost, ethAmount, maxUsd, contract, whale }) {
  const chatId = getSettings().alertChatId || process.env.ALERT_CHAT_ID;
  if (!chatId) return;

  const kb = new InlineKeyboard()
    .text("✅ Mint It", `approve_mint_${mintId}`)
    .text("❌ Skip", `skip_mint_${mintId}`);

  await bot.api.sendMessage(
    chatId,
    `⚠️ *Mint Price Above Limit!*\n\n` +
    `Whale: \`${whale}\`\n` +
    `Contract: \`${contract}\`\n` +
    `Price: ${ethAmount} ETH (*$${usdCost}*)\n` +
    `Your limit: $${maxUsd}\n\n` +
    `Proceed with mint? _(auto-skips in 2 minutes)_`,
    { parse_mode: "Markdown", reply_markup: kb }
  );
}

// Init subsystems
initTracker(process.env.ALCHEMY_API_KEY);
await initCopyMint(provider, mainSigner, notify, askApproval);
initScheduler(notify);
await startTracking();

// ─── Helpers ────────────────────────────────────────────────────────────────

function isValidAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function shortAddr(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatStatusMessage() {
  const settings = getSettings();
  const tracked = getTracked();
  const wallets = listWallets();
  const on = "🟢";
  const off = "🔴";
  const wl = settings.whitelist || [];
  const bl = settings.blacklist || [];
  const mintLog = getMintLog();

  return (
    `✅ *Status Update*\n\n` +
    `*Modules:*\n` +
    `Tracker: ${tracked.length > 0 ? on : off}\n` +
    `Auto-Mint: ${settings.autoMint ? on + " ON" : off + " OFF"}\n` +
    `MEV Shield: ${settings.mevShield ? on + " ON" : off + " OFF"}\n` +
    `Max Mint: $${settings.maxMintUsd || "0.15"} USD\n` +
    `Free Mints: ${settings.allowFreeMints !== false ? on + " ON" : off + " OFF"}\n\n` +
    `*Filters:*\n` +
    `Whitelist: ${wl.length > 0 ? `${wl.length} contract(s)` : "All"}\n` +
    `Blacklist: ${bl.length > 0 ? `${bl.length} blocked` : "None"}\n\n` +
    `*Network:*\n` +
    `Active Node: eth-mainnet.g.alchemy.com\n` +
    `Alert Chat: ${settings.alertChatId || process.env.ALERT_CHAT_ID || "not set"}\n` +
    `Total Wallets: ${wallets.length}\n` +
    `Tracked Addresses: ${tracked.length}\n` +
    `Total Mints Logged: ${mintLog.length}`
  );
}

function statusKeyboard() {
  const settings = getSettings();
  return new InlineKeyboard()
    .text("🔄 Refresh Status", "status_refresh")
    .text("➕ Add Sub-Wallet", "wallet_add_prompt")
    .row()
    .text(
      settings.autoMint ? "⚡ Auto-Mint: ON" : "⚡ Toggle Auto-Mint",
      "toggle_automint"
    )
    .text(
      settings.mevShield ? "🛡 MEV Shield: ON" : "🛡 Toggle MEV Shield",
      "toggle_mev"
    );
}

// ─── Commands ────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await ctx.reply(
    `👋 *NFT Copy-Mint Bot*\n\n` +
    `I watch whale wallets and copy-mint whatever they mint.\n\n` +
    `*Commands:*\n` +
    `/status — dashboard\n` +
    `/track <address> — track a whale\n` +
    `/untrack <address> — stop tracking\n` +
    `/tracked — list tracked wallets\n` +
    `/wallets — list sub-wallets\n` +
    `/addwallet <privkey> — add sub-wallet\n` +
    `/removewallet <address> — remove sub-wallet\n` +
    `/distribute <eth> [group] — send ETH to all or one group\n` +
    `/sweepgas — pull ETH back to main wallet\n` +
    `/sweepnfts <contract> — sweep NFTs to main wallet\n` +
    `/checkgas [min_eth] — show wallets with low gas\n` +
    `/creategroup <name> <from> <to> — assign wallet range to a person\n` +
    `/groups — list all groups\n` +
    `/groupwallets <name> — show wallets in a group\n` +
    `/groupprivatekey <name> — export private keys for a group (file)\n` +
    `/deletegroup <name> — remove a group\n` +
    `/mint <contract> [group] [calldata] [value] — manual mint\n` +
    `/whitelist <contract> — only auto-mint this contract\n` +
    `/unwhitelist <contract> — remove from whitelist\n` +
    `/blacklist <contract> — never auto-mint this contract\n` +
    `/unblacklist <contract> — remove from blacklist\n` +
    `/mintfilters — show whitelist/blacklist\n` +
    `/togglefreemints — allow/block free mints\n` +
    `/profits [contract] — mint profit tracker\n` +
    `/schedule — schedule a mint\n` +
    `/jobs — view scheduled mints\n` +
    `/setmaxmint <usd> — set max copy-mint price in USD\n` +
    `/setalertchat — set this chat as alert chat`,
    { parse_mode: "Markdown" }
  );
});

bot.command("status", async (ctx) => {
  await ctx.reply(formatStatusMessage(), {
    parse_mode: "Markdown",
    reply_markup: statusKeyboard(),
  });
});

bot.command("setalertchat", async (ctx) => {
  await updateSettings({ alertChatId: String(ctx.chat.id) });
  await ctx.reply(`✅ This chat is now the alert channel.\nChat ID: \`${ctx.chat.id}\``, {
    parse_mode: "Markdown",
  });
});

// ─── Tracking ────────────────────────────────────────────────────────────────

bot.command("track", async (ctx) => {
  const address = ctx.match?.trim();
  if (!address || !isValidAddress(address)) {
    return ctx.reply("Usage: /track 0xAddress");
  }
  await addTracked(address);
  await restartTracking();
  await ctx.reply(`🐋 Tracking \`${shortAddr(address)}\``, { parse_mode: "Markdown" });
});

bot.command("untrack", async (ctx) => {
  const address = ctx.match?.trim();
  if (!address || !isValidAddress(address)) {
    return ctx.reply("Usage: /untrack 0xAddress");
  }
  await removeTracked(address);
  await restartTracking();
  await ctx.reply(`❌ Removed \`${shortAddr(address)}\``, { parse_mode: "Markdown" });
});

bot.command("tracked", async (ctx) => {
  const tracked = getTracked();
  if (tracked.length === 0) {
    return ctx.reply("No wallets tracked yet.\nUse /track 0xAddress or upload a .txt file.");
  }
  const list = tracked.map((a, i) => `${i + 1}. \`${shortAddr(a)}\``).join("\n");
  await ctx.reply(`🐋 *Tracked Wallets (${tracked.length}):*\n\n${list}`, {
    parse_mode: "Markdown",
  });
});

// Upload .txt file — auto-detects private keys vs whale addresses
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.file_name?.endsWith(".txt")) {
    return ctx.reply("Upload a .txt file.\n• One private key per line → imports as sub-wallets\n• One address per line → imports as tracked whales");
  }

  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

  const res = await fetch(url);
  const text = await res.text();

  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  const isPrivateKey = (s) => /^(0x)?[0-9a-fA-F]{64}$/.test(s);
  const isAddress = (s) => isValidAddress(s);

  const privateKeys = lines.filter(isPrivateKey);
  const addresses = lines.filter(isAddress);

  // Private keys take priority if found
  if (privateKeys.length > 0) {
    await ctx.reply(`🔑 Found ${privateKeys.length} private key(s). Importing wallets...`);

    let added = 0;
    let failed = 0;
    const errors = [];

    for (const pk of privateKeys) {
      try {
        const normalizedPk = pk.startsWith("0x") ? pk : `0x${pk}`;
        await addWallet(normalizedPk);
        added++;
      } catch (err) {
        failed++;
        errors.push(err.message);
      }
    }

    // Delete the message containing private keys immediately
    try { await ctx.deleteMessage(); } catch {}

    const total = listWallets().length;
    let msg = `💼 *Wallet Import Successful!*\n\nAdded ${added} new wallet(s).\nFailed: ${failed}\nTotal Wallets: ${total}`;
    if (errors.length > 0) {
      const unique = [...new Set(errors)];
      msg += `\n\n_Errors: ${unique.join(", ")}_`;
    }
    return ctx.reply(msg, { parse_mode: "Markdown" });
  }

  // Otherwise treat as whale addresses
  if (addresses.length === 0) {
    return ctx.reply("No valid addresses or private keys found in the file.");
  }

  let added = 0;
  for (const addr of addresses) {
    await addTracked(addr);
    added++;
  }

  await restartTracking();
  const total = getTracked().length;

  await ctx.reply(
    `🐋 *Whale Import Successful!*\n\nParsed file and added ${added} new addresses to the tracker.\nTotal Tracked: ${total}`,
    { parse_mode: "Markdown" }
  );
});

// ─── Wallet Management ───────────────────────────────────────────────────────

bot.command("wallets", async (ctx) => {
  const wallets = listWallets();
  if (wallets.length === 0) {
    return ctx.reply("No sub-wallets added yet.\nUse /addwallet <privatekey>");
  }

  // Fetch balances in parallel
  const balances = await Promise.all(
    wallets.map(async (addr) => {
      try {
        const bal = await provider.getBalance(addr);
        return ethers.formatEther(bal).slice(0, 8);
      } catch {
        return "?.????";
      }
    })
  );

  const list = wallets
    .map((a, i) => `${i + 1}. \`${shortAddr(a)}\` — ${balances[i]} ETH`)
    .join("\n");

  await ctx.reply(
    `💼 *Sub-Wallets (${wallets.length}/100):*\n\n${list}\n\nMain: \`${shortAddr(MAIN_ADDRESS)}\``,
    { parse_mode: "Markdown" }
  );
});

bot.command("addwallet", async (ctx) => {
  const pk = ctx.match?.trim();
  if (!pk) return ctx.reply("Usage: /addwallet <private_key>\n⚠️ Send in private chat only!");
  try {
    const address = await addWallet(pk);
    await ctx.reply(`✅ Wallet added: \`${shortAddr(address)}\``, { parse_mode: "Markdown" });
    // Delete the message containing the private key
    try { await ctx.deleteMessage(); } catch {}
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  }
});

bot.command("removewallet", async (ctx) => {
  const address = ctx.match?.trim();
  if (!address || !isValidAddress(address)) {
    return ctx.reply("Usage: /removewallet 0xAddress");
  }
  await deleteWallet(address);
  await ctx.reply(`✅ Removed \`${shortAddr(address)}\``, { parse_mode: "Markdown" });
});

bot.command("distribute", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/);
  const amount = parts?.[0];
  const groupName = parts?.[1] || null;

  if (!amount || isNaN(parseFloat(amount))) {
    return ctx.reply(
      "Usage:\n" +
      "`/distribute 0.01` — send to ALL wallets\n" +
      "`/distribute 0.01 mine` — send to group only",
      { parse_mode: "Markdown" }
    );
  }

  const target = groupName ? `group *${groupName}*` : "all sub-wallets";

  // Preflight: check main wallet has enough for transfers + estimated gas
  try {
    const { getGroupWallets, getSubWallets } = await import("./storage.js");
    const walletList = groupName ? getGroupWallets(groupName) : getSubWallets();
    const count = walletList?.length || 0;
    const amountWei = ethers.parseEther(amount);
    const GAS_PER_TX = ethers.parseEther("0.0005"); // ~21k gas at 24 gwei
    const totalNeeded = (amountWei + GAS_PER_TX) * BigInt(count);
    const mainBalance = await provider.getBalance(MAIN_ADDRESS);

    if (mainBalance < totalNeeded) {
      const needed = parseFloat(ethers.formatEther(totalNeeded)).toFixed(6);
      const have = parseFloat(ethers.formatEther(mainBalance)).toFixed(6);
      return ctx.reply(
        `❌ *Insufficient balance in main wallet*\n\n` +
        `Need: ${needed} ETH\nHave: ${have} ETH\n\n` +
        `Top up main wallet first: \`${MAIN_ADDRESS}\``,
        { parse_mode: "Markdown" }
      );
    }
  } catch {}

  await ctx.reply(`📤 Distributing ${amount} ETH to ${target}...`, { parse_mode: "Markdown" });

  try {
    const results = await distributeGas(mainSigner, amount, groupName);
    const ok = results.filter(r => r.status === "sent").length;
    const fail = results.filter(r => r.status === "failed").length;

    let msg = `✅ Distribution complete!\n\n${ok} sent, ${fail} failed`;
    if (fail > 0) {
      const failList = results
        .filter(r => r.status === "failed")
        .map(r => `• \`${shortAddr(r.address)}\`: \`${String(r.error).slice(0, 60)}\``)
        .join("\n");
      msg += `\n\n*Failed:*\n${failList}`;
    }
    await ctx.reply(msg, { parse_mode: "Markdown" });
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  }
});

// ─── Wallet Groups ────────────────────────────────────────────────────────────

bot.command("creategroup", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/);
  if (!parts || parts.length !== 3) {
    return ctx.reply(
      "Usage: `/creategroup <name> <from> <to>`\n\nExample:\n`/creategroup mine 1 30` — assigns wallets 1–30 to group 'mine'\n`/creategroup alice 31 50` — assigns wallets 31–50 to 'alice'",
      { parse_mode: "Markdown" }
    );
  }

  const [name, fromStr, toStr] = parts;
  const from = parseInt(fromStr) - 1; // convert to 0-index
  const to = parseInt(toStr) - 1;
  const totalWallets = listWallets().length;

  if (isNaN(from) || isNaN(to) || from < 0 || to >= totalWallets || from > to) {
    return ctx.reply(`❌ Invalid range. You have wallets 1–${totalWallets}.`);
  }

  await createGroup(name, from, to);
  const count = to - from + 1;
  await ctx.reply(
    `✅ Group *${name}* created\n\nWallets: ${fromStr}–${toStr} (${count} wallets)`,
    { parse_mode: "Markdown" }
  );
});

bot.command("groups", async (ctx) => {
  const groups = getGroups();
  const names = Object.keys(groups);

  if (names.length === 0) {
    return ctx.reply(
      "No groups yet.\n\nCreate one with:\n`/creategroup mine 1 30`",
      { parse_mode: "Markdown" }
    );
  }

  const totalWallets = listWallets().length;
  const assigned = new Set(Object.values(groups).flat());
  const unassigned = totalWallets - assigned.size;

  const list = names.map(n => {
    const indices = groups[n];
    const first = Math.min(...indices) + 1;
    const last = Math.max(...indices) + 1;
    return `• *${n}*: wallets ${first}–${last} (${indices.length} wallets)`;
  }).join("\n");

  await ctx.reply(
    `👥 *Wallet Groups:*\n\n${list}\n\n_Unassigned: ${unassigned} wallets_`,
    { parse_mode: "Markdown" }
  );
});

bot.command("deletegroup", async (ctx) => {
  const name = ctx.match?.trim();
  if (!name) return ctx.reply("Usage: /deletegroup <name>");
  await deleteGroup(name);
  await ctx.reply(`✅ Group *${name}* deleted`, { parse_mode: "Markdown" });
});

bot.command("groupwallets", async (ctx) => {
  const name = ctx.match?.trim();
  if (!name) return ctx.reply("Usage: /groupwallets <name>");

  const wallets = getGroupWallets(name);
  if (!wallets || wallets.length === 0) {
    return ctx.reply(`❌ Group "${name}" not found or empty.`);
  }

  const list = wallets.map((w, i) => `${i + 1}. \`${w.address}\``).join("\n");
  await ctx.reply(
    `👥 *Group: ${name}* (${wallets.length} wallets)\n\n${list}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("groupprivatekey", async (ctx) => {
  // Admin-only — only the alert chat can request private keys
  const adminChatId = String(getSettings().alertChatId || process.env.ALERT_CHAT_ID || "");
  if (adminChatId && String(ctx.chat.id) !== adminChatId) {
    return ctx.reply("❌ Unauthorized.");
  }

  const name = ctx.match?.trim();
  if (!name) {
    return ctx.reply("Usage: `/groupprivatekey <groupname>`\nExample: `/groupprivatekey karlkestis`", { parse_mode: "Markdown" });
  }

  const keys = getGroupPrivateKeys(name);
  if (!keys) {
    return ctx.reply(`❌ Group "${name}" not found or empty.`);
  }

  // Build file content
  const lines = keys.map((w, i) =>
    `Wallet #${i + 1}\nAddress:     ${w.address}\nPrivate Key: ${w.privateKey}`
  ).join("\n\n");

  const fileContent = `Group: ${name}\nTotal wallets: ${keys.length}\nExported: ${new Date().toUTCString()}\n\n${"─".repeat(50)}\n\n${lines}\n`;

  // Send as a file — safer than pasting raw keys in chat
  const buf = Buffer.from(fileContent, "utf-8");
  await ctx.replyWithDocument(new InputFile(buf, `keys-${name}.txt`), {
    caption: `🔐 *${name}* — ${keys.length} wallet keys\n⚠️ Delete this file after importing.`,
    parse_mode: "Markdown",
  });
});

bot.command("groupbalance", async (ctx) => {
  const name = ctx.match?.trim();
  if (!name) {
    return ctx.reply("Usage: `/groupbalance <name>`\nExample: `/groupbalance mine`", { parse_mode: "Markdown" });
  }

  const wallets = getGroupWallets(name);
  if (!wallets || wallets.length === 0) {
    return ctx.reply(`❌ Group "${name}" not found or empty.`);
  }

  await ctx.reply(`🔍 Fetching balances for group *${name}*...`, { parse_mode: "Markdown" });

  const balances = await Promise.all(
    wallets.map(async (w) => {
      try {
        const bal = await provider.getBalance(w.address);
        return { address: w.address, eth: parseFloat(ethers.formatEther(bal)) };
      } catch {
        return { address: w.address, eth: 0 };
      }
    })
  );

  const total = balances.reduce((sum, w) => sum + w.eth, 0);
  const empty = balances.filter(w => w.eth === 0).length;
  const funded = balances.filter(w => w.eth > 0).length;

  const list = balances
    .map((w, i) => `${i + 1}. \`${shortAddr(w.address)}\` — ${w.eth.toFixed(6)} ETH`)
    .join("\n");

  await ctx.reply(
    `💼 *Group: ${name} — Balances*\n\n${list}\n\n` +
    `*Total: ${total.toFixed(6)} ETH*\n` +
    `Funded: ${funded} | Empty: ${empty}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("sweepgas", async (ctx) => {
  await ctx.reply("💸 Sweeping ETH from all sub-wallets to main...");
  try {
    const results = await sweepGas(provider, MAIN_ADDRESS);
    const ok = results.filter(r => r.status === "sent").length;
    const skipped = results.filter(r => r.status === "skipped").length;
    await ctx.reply(`✅ Gas swept!\n\n${ok} swept, ${skipped} skipped (no balance)`);
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  }
});

bot.command("sweepnfts", async (ctx) => {
  const contract = ctx.match?.trim();
  if (!contract || !isValidAddress(contract)) {
    return ctx.reply("Usage: /sweepnfts 0xContractAddress");
  }

  await ctx.reply(`🖼 Sweeping NFTs from \`${shortAddr(contract)}\` to main wallet...`, {
    parse_mode: "Markdown",
  });

  try {
    const results = await sweepNFTs(contract, provider, MAIN_ADDRESS);
    const swept = results.filter(r => r.status === "swept");
    const total = swept.reduce((sum, r) => sum + (r.count || 0), 0);
    await ctx.reply(`✅ NFT Sweep done!\n\n${total} NFT(s) moved to main wallet`);
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  }
});

// ─── Scheduled Mints ─────────────────────────────────────────────────────────

// Conversation state for /schedule flow
const scheduleState = new Map();

bot.command("schedule", async (ctx) => {
  scheduleState.set(ctx.chat.id, { step: "contract" });
  await ctx.reply(
    `🗓 *Schedule a Mint*\n\nStep 1/4: Enter the NFT contract address:`,
    { parse_mode: "Markdown" }
  );
});

bot.command("jobs", async (ctx) => {
  const jobs = getPendingJobs();
  if (jobs.length === 0) {
    return ctx.reply("No scheduled mints pending.");
  }

  const kb = new InlineKeyboard();
  const list = jobs
    .map((j, i) => {
      const time = new Date(j.triggerAt).toISOString().slice(0, 16).replace("T", " ") + " UTC";
      kb.text(`❌ Cancel #${i + 1}`, `cancel_job_${j.id}`).row();
      return `${i + 1}. \`${shortAddr(j.contract)}\` — ${time}`;
    })
    .join("\n");

  await ctx.reply(
    `🗓 *Pending Scheduled Mints (${jobs.length}):*\n\n${list}`,
    { parse_mode: "Markdown", reply_markup: kb }
  );
});

bot.command("setmaxmint", async (ctx) => {
  const val = ctx.match?.trim();
  if (!val || isNaN(parseFloat(val))) {
    return ctx.reply("Usage: `/setmaxmint 0.15`\n\nSets the max price per NFT in USD.\nFree mints always go through automatically.", { parse_mode: "Markdown" });
  }
  await updateSettings({ maxMintUsd: val });
  await ctx.reply(`✅ Max mint price set to *$${val} USD* per NFT\n\nFree mints → auto\nUnder $${val} → auto\nOver $${val} → asks you`, { parse_mode: "Markdown" });
});

// ─── Mint Filters ─────────────────────────────────────────────────────────────

bot.command("whitelist", async (ctx) => {
  const contract = ctx.match?.trim();
  if (!contract || !isValidAddress(contract)) {
    return ctx.reply("Usage: `/whitelist 0xContractAddress`\n\nOnly auto-mint whitelisted contracts (leave empty to mint all).", { parse_mode: "Markdown" });
  }
  await addToWhitelist(contract);
  const wl = getSettings().whitelist || [];
  await ctx.reply(
    `✅ *Whitelisted:* \`${contract}\`\n\nOnly contracts on this list will auto-mint.\nWhitelist has ${wl.length} contract(s).\n\nUse /mintfilters to view all.`,
    { parse_mode: "Markdown" }
  );
});

bot.command("unwhitelist", async (ctx) => {
  const contract = ctx.match?.trim();
  if (!contract || !isValidAddress(contract)) {
    return ctx.reply("Usage: `/unwhitelist 0xContractAddress`", { parse_mode: "Markdown" });
  }
  await removeFromWhitelist(contract);
  await ctx.reply(`✅ Removed \`${shortAddr(contract)}\` from whitelist.`, { parse_mode: "Markdown" });
});

bot.command("blacklist", async (ctx) => {
  const contract = ctx.match?.trim();
  if (!contract || !isValidAddress(contract)) {
    return ctx.reply("Usage: `/blacklist 0xContractAddress`\n\nThis contract will always be skipped.", { parse_mode: "Markdown" });
  }
  await addToBlacklist(contract);
  await ctx.reply(`🚫 *Blacklisted:* \`${contract}\`\n\nThis contract will never be auto-minted.`, { parse_mode: "Markdown" });
});

bot.command("unblacklist", async (ctx) => {
  const contract = ctx.match?.trim();
  if (!contract || !isValidAddress(contract)) {
    return ctx.reply("Usage: `/unblacklist 0xContractAddress`", { parse_mode: "Markdown" });
  }
  await removeFromBlacklist(contract);
  await ctx.reply(`✅ Removed \`${shortAddr(contract)}\` from blacklist.`, { parse_mode: "Markdown" });
});

bot.command("mintfilters", async (ctx) => {
  const settings = getSettings();
  const wl = settings.whitelist || [];
  const bl = settings.blacklist || [];

  const wlText = wl.length > 0
    ? wl.map(c => `• \`${c}\``).join("\n")
    : "_None — all contracts allowed_";

  const blText = bl.length > 0
    ? bl.map(c => `• \`${c}\``).join("\n")
    : "_None_";

  await ctx.reply(
    `🔍 *Mint Filters*\n\n` +
    `*Whitelist* (${wl.length}) — only mint these:\n${wlText}\n\n` +
    `*Blacklist* (${bl.length}) — never mint these:\n${blText}\n\n` +
    `*Free Mints:* ${settings.allowFreeMints !== false ? "✅ Allowed" : "❌ Blocked"}\n\n` +
    `Commands:\n` +
    `/whitelist 0x... — add to whitelist\n` +
    `/blacklist 0x... — add to blacklist\n` +
    `/togglefreemints — toggle free mints`,
    { parse_mode: "Markdown" }
  );
});

bot.command("togglefreemints", async (ctx) => {
  const current = getSettings().allowFreeMints !== false;
  await updateSettings({ allowFreeMints: !current });
  const now = !current;
  await ctx.reply(
    `${now ? "✅" : "❌"} *Free Mints: ${now ? "Allowed" : "Blocked"}*\n\n` +
    `Auto-mint will ${now ? "now include" : "skip"} free (0 ETH) mints.`,
    { parse_mode: "Markdown" }
  );
});

// ─── Manual Mint ──────────────────────────────────────────────────────────────

bot.command("mint", async (ctx) => {
  const input = ctx.match?.trim();
  if (!input) {
    return ctx.reply(
      `*Manual Mint*\n\n` +
      `Usage: \`/mint <contract> [group] [calldata] [value_eth]\`\n\n` +
      `Examples:\n` +
      `\`/mint 0xContract\` — all wallets, default calldata\n` +
      `\`/mint 0xContract mine\` — group 'mine' only\n` +
      `\`/mint 0xContract mine 0.05\` — group + pay 0.05 ETH each\n` +
      `\`/mint 0xContract mine 0x1249c58b 0.05\` — custom calldata`,
      { parse_mode: "Markdown" }
    );
  }

  // Smart parser: detect each arg by format
  const args = input.split(/\s+/);
  let contract = null, group = null, calldata = null, value = "0";

  for (const arg of args) {
    if (/^0x[0-9a-fA-F]{40}$/.test(arg) && !contract) {
      contract = arg;
    } else if (/^0x[0-9a-fA-F]{8,}$/.test(arg)) {
      calldata = arg;
    } else if (/^\d*\.?\d+$/.test(arg)) {
      value = arg;
    } else if (/^[a-zA-Z0-9_-]+$/.test(arg)) {
      group = arg;
    }
  }

  if (!contract) {
    return ctx.reply("❌ Provide a valid contract address.\n\nUsage: `/mint 0xContract [group] [calldata] [value]`", { parse_mode: "Markdown" });
  }

  const target = group ? `group *${group}*` : "all sub-wallets";
  const ethVal = parseFloat(value);

  await ctx.reply(
    `⚡ *Minting...*\n\n` +
    `Contract: \`${shortAddr(contract)}\`\n` +
    `Wallets: ${target}\n` +
    `Value: ${ethVal} ETH each\n` +
    `Calldata: \`${calldata || "default mint()"}\``,
    { parse_mode: "Markdown" }
  );

  try {
    const { succeeded, failed, skipped, total } = await executeManualMint(contract, calldata, value, group);
    await ctx.reply(
      `✅ *Manual Mint Complete!*\n\n` +
      `✅ Succeeded: ${succeeded}\n` +
      `❌ Failed: ${failed}\n` +
      `⏭️ Skipped (low balance): ${skipped}\n` +
      `📊 Total wallets: ${total}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(`❌ Mint failed: ${err.message}`);
  }
});

// ─── Gas Health Check ─────────────────────────────────────────────────────────

bot.command("checkgas", async (ctx) => {
  const thresholdInput = parseFloat(ctx.match?.trim() || "0.01");
  const threshold = isNaN(thresholdInput) ? 0.01 : thresholdInput;
  const CRITICAL = 0.003;

  const wallets = listWallets();
  if (wallets.length === 0) return ctx.reply("No sub-wallets configured.");

  await ctx.reply(`🔍 Checking ${wallets.length} wallets (threshold: ${threshold} ETH)...`);

  const balances = await Promise.all(
    wallets.map(async (addr, i) => {
      try {
        const bal = await provider.getBalance(addr);
        const eth = parseFloat(ethers.formatEther(bal));
        return { index: i + 1, address: addr, eth };
      } catch {
        return { index: i + 1, address: addr, eth: 0 };
      }
    })
  );

  const low = balances.filter(w => w.eth < threshold);

  if (low.length === 0) {
    return ctx.reply(`✅ All ${wallets.length} wallets are above ${threshold} ETH. You're good.`);
  }

  const list = low.map(w => {
    const icon = w.eth < CRITICAL ? "🔴" : "🟡";
    return `${icon} #${w.index} \`${shortAddr(w.address)}\` — ${w.eth.toFixed(6)} ETH`;
  }).join("\n");

  const critical = low.filter(w => w.eth < CRITICAL).length;
  const warn = low.length - critical;

  await ctx.reply(
    `⚠️ *Gas Health Check*\n\n` +
    `${list}\n\n` +
    `🔴 Critical (< ${CRITICAL} ETH): ${critical}\n` +
    `🟡 Low (< ${threshold} ETH): ${warn}\n` +
    `🟢 OK: ${wallets.length - low.length}\n\n` +
    `_Use /distribute to top up wallets_`,
    { parse_mode: "Markdown" }
  );
});

// ─── Profit Tracker ───────────────────────────────────────────────────────────

async function getFloorPrice(contractAddress) {
  try {
    const res = await fetch(
      `https://api.reservoir.tools/collections/v7?id=${contractAddress}`,
      { headers: { "x-api-key": "demo" } }
    );
    const data = await res.json();
    return data.collections?.[0]?.floorAsk?.price?.amount?.native ?? null;
  } catch {
    return null;
  }
}

bot.command("profits", async (ctx) => {
  const filterContract = ctx.match?.trim()?.toLowerCase();
  const log = getMintLog();

  if (log.length === 0) {
    return ctx.reply("No mints recorded yet. Start minting and profits will be tracked here.");
  }

  // Group by contract
  const byContract = {};
  for (const entry of log) {
    const c = entry.contract;
    if (filterContract && c !== filterContract) continue;
    if (!byContract[c]) byContract[c] = { count: 0, ethSpent: 0 };
    byContract[c].count++;
    byContract[c].ethSpent += entry.ethSpent || 0;
  }

  const contracts = Object.keys(byContract);
  if (contracts.length === 0) {
    return ctx.reply(`No mints found for \`${filterContract}\``, { parse_mode: "Markdown" });
  }

  // Limit to 8 most recent contracts (prevents giant messages)
  const recent = contracts.slice(-8);

  await ctx.reply(`📊 Fetching floor prices...`);

  const ethPrice = await provider.getBalance(MAIN_ADDRESS)
    .then(async () => {
      try {
        const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
        const d = await r.json();
        return d.ethereum.usd;
      } catch { return 2000; }
    })
    .catch(() => 2000);

  const lines = await Promise.all(
    recent.map(async (c) => {
      const { count, ethSpent } = byContract[c];
      const floor = await getFloorPrice(c);

      const spentUsd = (ethSpent * ethPrice).toFixed(2);
      let profitLine = "";

      if (floor !== null) {
        const portfolioEth = floor * count;
        const portfolioUsd = portfolioEth * ethPrice;
        const plUsd = portfolioUsd - ethSpent * ethPrice;
        const plSign = plUsd >= 0 ? "+" : "";
        profitLine = `\nFloor: ${floor.toFixed(4)} ETH | Portfolio: ${portfolioEth.toFixed(4)} ETH\nP&L: ${plSign}$${plUsd.toFixed(2)}`;
      } else {
        profitLine = `\nFloor: N/A`;
      }

      return (
        `*Contract:* \`${shortAddr(c)}\`\n` +
        `Mints: ${count} | Spent: ${ethSpent.toFixed(4)} ETH ($${spentUsd})` +
        profitLine
      );
    })
  );

  const totalMints = Object.values(byContract).reduce((s, v) => s + v.count, 0);
  const totalEth = Object.values(byContract).reduce((s, v) => s + v.ethSpent, 0);

  await ctx.reply(
    `📊 *Mint Profit Tracker*\n` +
    `_${totalMints} total mints across ${contracts.length} contracts_\n\n` +
    lines.join("\n\n─────────────────\n\n") +
    `\n\n─────────────────\n` +
    `*Total ETH Spent: ${totalEth.toFixed(4)} ETH ($${(totalEth * ethPrice).toFixed(2)})*`,
    { parse_mode: "Markdown" }
  );
});

// ─── Text handler (schedule flow + fallback) ─────────────────────────────────

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return; // handled by commands

  const state = scheduleState.get(chatId);
  if (!state) return;

  if (state.step === "contract") {
    if (!isValidAddress(text)) {
      return ctx.reply("Invalid address. Try again or /start to cancel.");
    }
    state.contract = text;
    state.step = "quantity";
    scheduleState.set(chatId, state);
    await ctx.reply("Step 2/4: How many to mint? (enter a number, e.g. 2)");
  } else if (state.step === "quantity") {
    const qty = parseInt(text);
    if (isNaN(qty) || qty < 1) return ctx.reply("Enter a valid number.");
    state.quantity = qty;
    state.step = "value";
    scheduleState.set(chatId, state);
    await ctx.reply("Step 3/4: Mint price in ETH? (enter 0 for free mints)");
  } else if (state.step === "value") {
    if (isNaN(parseFloat(text))) return ctx.reply("Enter a valid ETH amount.");
    state.value = text;
    state.step = "time";
    scheduleState.set(chatId, state);
    await ctx.reply(
      "Step 4/4: Trigger time in UTC?\nFormat: `2026-03-01 18:30`",
      { parse_mode: "Markdown" }
    );
  } else if (state.step === "time") {
    const parsed = new Date(text + ":00Z");
    if (isNaN(parsed.getTime())) {
      return ctx.reply("Invalid time. Use format: 2026-03-01 18:30");
    }
    if (parsed.getTime() <= Date.now()) {
      return ctx.reply("That time is in the past. Try again.");
    }

    const triggerAt = parsed.getTime();
    scheduleState.delete(chatId);

    try {
      const job = await createJob({
        label: `${shortAddr(state.contract)}`,
        contract: state.contract,
        value: state.value,
        quantity: state.quantity,
        triggerAt,
      });

      const triggerStr = parsed.toISOString().slice(0, 16).replace("T", " ") + " UTC";
      const kb = new InlineKeyboard()
        .text("🗓 Schedule Another Drop", "schedule_another")
        .row()
        .text("◀️ Back to Scheduler", "jobs_back");

      await ctx.reply(
        `🗓 *Mint Scheduled!*\n\n` +
        `Collection: \`${shortAddr(state.contract)}\`\n` +
        `Phase: Public\n` +
        `Quantity: ${state.quantity}\n` +
        `Chain: Ethereum\n` +
        `Wallet: \`${shortAddr(MAIN_ADDRESS)}\`\n` +
        `Trigger: ${triggerStr}\n\n` +
        `I'll execute and notify you automatically.`,
        { parse_mode: "Markdown", reply_markup: kb }
      );
    } catch (err) {
      scheduleState.delete(chatId);
      await ctx.reply(`❌ Failed to schedule: ${err.message}`);
    }
  }
});

// ─── Mint Approval Callbacks ─────────────────────────────────────────────────

bot.callbackQuery(/^approve_mint_(.+)$/, async (ctx) => {
  const mintId = ctx.match[1];
  const resolved = resolveApproval(mintId, true);
  if (resolved) {
    await ctx.editMessageText(
      ctx.message?.text + "\n\n✅ *Approved — minting now...*",
      { parse_mode: "Markdown" }
    );
  } else {
    await ctx.editMessageText("⏰ Too late — this mint already timed out.");
  }
  await ctx.answerCallbackQuery("Minting!");
});

bot.callbackQuery(/^skip_mint_(.+)$/, async (ctx) => {
  const mintId = ctx.match[1];
  const resolved = resolveApproval(mintId, false);
  if (resolved) {
    await ctx.editMessageText(
      ctx.message?.text + "\n\n⏭️ *Skipped.*",
      { parse_mode: "Markdown" }
    );
  } else {
    await ctx.editMessageText("⏰ Too late — this mint already timed out.");
  }
  await ctx.answerCallbackQuery("Skipped");
});

// ─── Inline Keyboard Callbacks ────────────────────────────────────────────────

bot.callbackQuery("status_refresh", async (ctx) => {
  await ctx.editMessageText(formatStatusMessage(), {
    parse_mode: "Markdown",
    reply_markup: statusKeyboard(),
  });
  await ctx.answerCallbackQuery("Refreshed");
});

bot.callbackQuery("toggle_automint", async (ctx) => {
  const settings = getSettings();
  await updateSettings({ autoMint: !settings.autoMint });
  await ctx.editMessageText(formatStatusMessage(), {
    parse_mode: "Markdown",
    reply_markup: statusKeyboard(),
  });
  await ctx.answerCallbackQuery(
    settings.autoMint ? "Auto-Mint disabled" : "Auto-Mint enabled"
  );
});

bot.callbackQuery("toggle_mev", async (ctx) => {
  const settings = getSettings();
  await updateSettings({ mevShield: !settings.mevShield });
  await ctx.editMessageText(formatStatusMessage(), {
    parse_mode: "Markdown",
    reply_markup: statusKeyboard(),
  });
  await ctx.answerCallbackQuery(
    settings.mevShield ? "MEV Shield disabled" : "MEV Shield enabled"
  );
});

bot.callbackQuery("wallet_add_prompt", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Send: /addwallet <your_private_key>\n⚠️ Only in private chat — I'll delete your message immediately.");
});

bot.callbackQuery(/^cancel_job_(.+)$/, async (ctx) => {
  const jobId = ctx.match[1];
  await cancelJob(jobId);
  await ctx.answerCallbackQuery("Mint cancelled");
  await ctx.editMessageText("✅ Scheduled mint cancelled.");
});

bot.callbackQuery("schedule_another", async (ctx) => {
  await ctx.answerCallbackQuery();
  scheduleState.set(ctx.chat.id, { step: "contract" });
  await ctx.reply("Step 1/4: Enter the NFT contract address:");
});

bot.callbackQuery("jobs_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  const jobs = getPendingJobs();
  await ctx.reply(
    jobs.length === 0
      ? "No scheduled mints pending."
      : `You have ${jobs.length} pending mint(s). Use /jobs to view.`
  );
});

// ─── Start ───────────────────────────────────────────────────────────────────

console.log(`[Bot] Starting — Main wallet: ${MAIN_ADDRESS}`);
bot.start({
  onStart: () => console.log("[Bot] Online and watching"),
});

// Graceful shutdown for Railway restarts
process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
