import "dotenv/config";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { ethers } from "ethers";
import { initDb, addTracked, removeTracked, getTracked, getSettings, updateSettings, createGroup, deleteGroup, getGroups, getGroupWallets, addToWhitelist, removeFromWhitelist, addToBlacklist, removeFromBlacklist, getMintLog, addWatch, removeWatch, getWatches, addPriceAlert, removePriceAlert, getPriceAlerts, addSweepWatcher, removeSweepWatcher, getSweepWatchers } from "./storage.js";
import { initPriceAlerts, getFloorPrice as getAlertFloorPrice } from "./priceAlerts.js";
import { addWallet, deleteWallet, listWallets, distributeGas, sweepGas, sweepNFTs, getGroupPrivateKeys } from "./wallets.js";
import { initTracker, startTracking, restartTracking, getAlchemy } from "./tracker.js";
import { initCopyMint, resolveApproval, executeManualMint } from "./copymint.js";
import { initScheduler, createJob, cancelJob, getPendingJobs } from "./scheduler.js";
import { initWatcher, startWatcher, buildMintPublicCalldata } from "./watcher.js";
import { initSweepWatcher } from "./sweepWatcher.js";
import { v4 as uuidv4 } from "uuid";

// ─── Init ────────────────────────────────────────────────────────────────────

await initDb();

const bot = new Bot(process.env.BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(
  `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
);
const mainSigner = new ethers.Wallet(process.env.MAIN_PRIVATE_KEY, provider);
const MAIN_ADDRESS = await mainSigner.getAddress();

// Bot notification function — sends to alert chat or falls back to admin
async function notify(text, txHash, parseMode = "Markdown") {
  const settings = getSettings();
  const chatId = settings.alertChatId || process.env.ALERT_CHAT_ID;
  if (!chatId) {
    console.warn("[Notify] No alertChatId set — run /setalertchat in the bot to receive alerts.");
    return;
  }
  console.log(`[Notify] Sending to chatId: ${chatId}`);

  let msg = text;
  const opts = parseMode ? { parse_mode: parseMode } : {};

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
initWatcher(provider, notify);
initPriceAlerts(notify);
initSweepWatcher(notify);
startWatcher();
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
    `Free Mints: ${settings.allowFreeMints !== false ? on + " ON" : off + " OFF"}\n` +
    `Catch-All: ${settings.catchAll ? "⚡ ON" : off + " OFF (known selectors only)"}\n\n` +
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
    `/whalestats [address] [date] — daily activity for tracked whales\n` +
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
    `/decode <contract> — get mint function selectors\n` +
    `/whitelist <contract> — only auto-mint this contract\n` +
    `/unwhitelist <contract> — remove from whitelist\n` +
    `/blacklist <contract> — never auto-mint this contract\n` +
    `/unblacklist <contract> — remove from blacklist\n` +
    `/mintfilters — show whitelist/blacklist\n` +
    `/togglefreemints — allow/block free mints\n` +
    `/togglecatchall — fire on ANY whale contract call (catches unknown mints)\n` +
    `/profits [contract] — mint profit tracker\n` +
    `/history [page] — full mint transaction history\n` +
    `/schedule — schedule a mint\n` +
    `/jobs — view scheduled mints\n` +
    `/setmaxmint <usd> — set max copy-mint price in USD\n` +
    `/setalertchat — set this chat as alert chat`,
    { parse_mode: "Markdown" }
  );
});

bot.command("commands", async (ctx) => {
  await ctx.reply(
    `📋 *All Commands*\n\n` +

    `*📊 Dashboard*\n` +
    `/status — live dashboard\n` +
    `/commands — this list\n\n` +

    `*🐋 Whale Tracking*\n` +
    `/track <address> — start tracking a whale\n` +
    `/untrack <address> — stop tracking\n` +
    `/tracked — list tracked wallets\n` +
    `/whalestats [address] [date] — daily on-chain activity\n\n` +

    `*⚡ Auto-Mint Settings*\n` +
    `/setmaxmint <usd> — max price per NFT in USD\n` +
    `/togglefreemints — allow/block free mints\n` +
    `/togglecatchall — catch ALL whale contract calls\n\n` +

    `*🔍 Filters*\n` +
    `/mintfilters — view whitelist & blacklist\n` +
    `/whitelist <contract> — only auto-mint this contract\n` +
    `/unwhitelist <contract> — remove from whitelist\n` +
    `/blacklist <contract> — never auto-mint this contract\n` +
    `/unblacklist <contract> — remove from blacklist\n\n` +

    `*🖐 Manual Mint*\n` +
    `/mint <contract> [group] [calldata] [value] — fire mint now\n` +
    `/decode <contract> — get mint function selectors\n\n` +

    `*💼 Wallets*\n` +
    `/wallets — list all sub-wallets with balances\n` +
    `/addwallet <privkey> — add a sub-wallet\n` +
    `/removewallet <address> — remove a sub-wallet\n` +
    `/checkgas [min_eth] — show wallets with low gas\n` +
    `/distribute <eth> [group] — send ETH to wallets\n` +
    `/sweepgas — pull all ETH back to main wallet\n` +
    `/sweepnfts <contract> — sweep NFTs to main wallet\n\n` +

    `*👥 Groups*\n` +
    `/creategroup <name> <from> <to> — create a wallet group\n` +
    `/groups — list all groups\n` +
    `/groupwallets <name> — wallets in a group\n` +
    `/groupbalance <name> — balances for a group\n` +
    `/groupprivatekey <name> — export keys for a group\n` +
    `/deletegroup <name> — delete a group\n\n` +

    `*📅 Scheduled Mints*\n` +
    `/schedule — schedule a mint\n` +
    `/jobs — view pending scheduled mints\n\n` +

    `*📈 History & Profits*\n` +
    `/history [page] — full mint log\n` +
    `/profits [contract] — P&L tracker with floor prices\n\n` +

    `*🔔 Price Alerts*\n` +
    `/setalert <contract> <name> <price> — alert when floor hits target ETH\n` +
    `/removealert <contract> — remove an alert\n` +
    `/alerts — list all active alerts\n\n` +

    `*⚙️ Settings*\n` +
    `/setalertchat — set this chat as the alert channel`,
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
  const list = tracked.map((a, i) => `${i + 1}. \`${a}\``).join("\n");
  await ctx.reply(`🐋 *Tracked Wallets (${tracked.length}):*\n\n${list}`, {
    parse_mode: "Markdown",
  });
});

// ─── Whale Daily Activity ─────────────────────────────────────────────────────

async function fetchWhaleActivity(address, dateStr) {
  const alchemy = getAlchemy();

  // Build start/end timestamps for the requested date (UTC)
  const start = new Date(`${dateStr}T00:00:00Z`);
  const end   = new Date(`${dateStr}T23:59:59Z`);

  const resp = await alchemy.core.getAssetTransfers({
    fromAddress: address,
    category: ["external", "erc721", "erc1155"],
    withMetadata: true,
    maxCount: 100,
    order: "desc",
  });

  const transfers = (resp.transfers || []).filter(tx => {
    const ts = new Date(tx.metadata?.blockTimestamp);
    return ts >= start && ts <= end;
  });

  return transfers;
}

function summariseTransfers(transfers) {
  // Group by contract (to address) with counts and ETH spent
  const byContract = {};
  for (const tx of transfers) {
    const contract = tx.to?.toLowerCase() || "unknown";
    if (!byContract[contract]) byContract[contract] = { count: 0, eth: 0, category: tx.category };
    byContract[contract].count++;
    byContract[contract].eth += parseFloat(tx.value || 0);
  }
  return byContract;
}

// ─── Price Alerts ─────────────────────────────────────────────────────────────

bot.command("setalert", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/);
  if (!parts || parts.length < 3) {
    return ctx.reply("Usage: `/setalert <contract> <name> <targetPriceETH>`\nExample: `/setalert 0xabc...def cc0mon 0.05`", { parse_mode: "Markdown" });
  }
  const contract = parts[0];
  const priceStr = parts[parts.length - 1].replace(/[^\d.]/g, ""); // strip trailing punctuation
  const name = parts.slice(1, -1).join(" ");
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    return ctx.reply("Invalid contract address.");
  }
  const targetPrice = parseFloat(priceStr);
  if (isNaN(targetPrice) || targetPrice <= 0) {
    return ctx.reply("Invalid price — enter a number in ETH, e.g. `0.01` or `2.5`.", { parse_mode: "Markdown" });
  }
  const { v4: uuidv4Alert } = await import("uuid");
  const existing = getPriceAlerts().find(a => a.contract === contract.toLowerCase());
  if (existing) {
    return ctx.reply(`Alert already set for *${existing.name}* at ${existing.targetPrice} ETH. Use /removealert first to change it.`, { parse_mode: "Markdown" });
  }
  await addPriceAlert({
    id: uuidv4Alert(),
    contract: contract.toLowerCase(),
    name,
    targetPrice,
    lastFiredAt: null,
    createdAt: Date.now(),
  });
  await ctx.reply(`✅ Alert set!\nI'll ping you when *${name}* floor hits *${targetPrice} ETH* or above.`, { parse_mode: "Markdown" });
});

bot.command("removealert", async (ctx) => {
  const contract = ctx.match?.trim().toLowerCase();
  if (!contract) return ctx.reply("Usage: `/removealert <contract>`", { parse_mode: "Markdown" });
  const alert = getPriceAlerts().find(a => a.contract === contract);
  if (!alert) return ctx.reply("No alert found for that contract.");
  await removePriceAlert(alert.id);
  await ctx.reply(`🗑 Alert removed for \`${contract}\``, { parse_mode: "Markdown" });
});

bot.command("alerts", async (ctx) => {
  const alerts = getPriceAlerts();
  if (alerts.length === 0) return ctx.reply("No price alerts set. Use `/setalert <contract> <price>` to add one.", { parse_mode: "Markdown" });
  const lines = alerts.map((a, i) => {
    const fired = a.lastFiredAt ? `Last fired: ${new Date(a.lastFiredAt).toUTCString()}` : "Not yet fired";
    return `${i + 1}. *${a.name || "unnamed"}* — \`${a.contract}\`\nTarget: *${a.targetPrice} ETH* | ${fired}`;
  });
  await ctx.reply(`🔔 *Price Alerts (${alerts.length})*\n\n` + lines.join("\n\n"), { parse_mode: "Markdown" });
});

bot.command("checkalert", async (ctx) => {
  const alerts = getPriceAlerts();
  if (alerts.length === 0) return ctx.reply("No alerts set.");
  await ctx.reply("🔍 Checking floor prices now...");
  const lines = await Promise.all(alerts.map(async (a) => {
    const floor = await getAlertFloorPrice(a.contract);
    const cooldownInfo = a.lastFiredAt
      ? `Last fired: ${Math.round((Date.now() - a.lastFiredAt) / 60000)} min ago`
      : "Never fired";
    const status = floor === null
      ? "❓ Reservoir returned null"
      : floor >= a.targetPrice
        ? `✅ ABOVE target (${floor.toFixed(4)} ETH ≥ ${a.targetPrice} ETH)`
        : `⏳ Below target (${floor.toFixed(4)} ETH < ${a.targetPrice} ETH)`;
    return `*${a.name || "unnamed"}*\n${status}\n${cooldownInfo}`;
  }));
  await ctx.reply(lines.join("\n\n"), { parse_mode: "Markdown" });
});

bot.command("whalestats", async (ctx) => {
  const args = ctx.match?.trim().split(/\s+/).filter(Boolean) || [];

  // Parse: optional address + optional date
  let address = null;
  let dateStr = new Date().toISOString().slice(0, 10); // default: today UTC

  for (const arg of args) {
    if (isValidAddress(arg)) address = arg.toLowerCase();
    else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) dateStr = arg;
  }

  const tracked = getTracked();
  if (tracked.length === 0) return ctx.reply("No wallets being tracked. Use /track 0xAddress first.");

  const targets = address ? [address] : tracked;

  if (!targets.every(a => tracked.includes(a))) {
    return ctx.reply(`❌ That address isn't in your tracked list.\nUse /tracked to see who you're watching.`);
  }

  await ctx.reply(`🔍 Fetching activity for ${targets.length} whale(s) on *${dateStr}*...`, { parse_mode: "Markdown" });

  const sections = [];

  for (const whale of targets) {
    try {
      const transfers = await fetchWhaleActivity(whale, dateStr);

      if (transfers.length === 0) {
        sections.push(`🐋 \`${shortAddr(whale)}\`\n_No activity on ${dateStr}_`);
        continue;
      }

      const grouped = summariseTransfers(transfers);
      const contracts = Object.keys(grouped);

      const lines = contracts.map(c => {
        const { count, eth, category } = grouped[c];
        const icon = category === "erc721" || category === "erc1155" ? "🖼" : "💸";
        const ethStr = eth > 0 ? ` — ${eth.toFixed(4)} ETH` : " — free";
        return `${icon} \`${shortAddr(c)}\` × ${count}${ethStr}`;
      });

      const totalEth = transfers.reduce((s, t) => s + parseFloat(t.value || 0), 0);

      sections.push(
        `🐋 \`${whale}\`\n` +
        `${transfers.length} tx(s) — ${totalEth.toFixed(4)} ETH spent\n\n` +
        lines.join("\n")
      );
    } catch (err) {
      sections.push(`🐋 \`${shortAddr(whale)}\` — ❌ Error: ${err.message}`);
    }
  }

  // Telegram has a 4096 char limit — split if needed
  const header = `📅 *Whale Activity — ${dateStr}*\n\n`;
  const body = sections.join("\n\n─────────────────\n\n");
  const full = header + body;

  if (full.length <= 4000) {
    await ctx.reply(full, { parse_mode: "Markdown", disable_web_page_preview: true });
  } else {
    // Send each whale as a separate message
    await ctx.reply(header.trim(), { parse_mode: "Markdown" });
    for (const section of sections) {
      await ctx.reply(section, { parse_mode: "Markdown", disable_web_page_preview: true });
    }
  }
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

bot.command("togglecatchall", async (ctx) => {
  const current = getSettings().catchAll || false;
  await updateSettings({ catchAll: !current });
  const now = !current;
  await ctx.reply(
    `${now ? "⚡" : "🎯"} *Catch-All Mode: ${now ? "ON" : "OFF"}*\n\n` +
    (now
      ? `Bot will now fire on *any* contract call from tracked whales — including whitelist mints, presales, and unknown selectors.\n\n⚠️ May trigger on non-mint interactions (approvals, swaps, etc.)`
      : `Bot will only fire on *known* mint selectors (standard + allowlist + presale).`),
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

// Known selectors that accept uint256 quantity as first param
const QTY_SELECTORS = {
  "0xa0712d68": "mint(uint256)",
  "0x379607f5": "claim(uint256)",
  "0x3b4c4b25": "publicMint(uint256)",
  "0x61a503b0": "purchase(uint256)",
  "0xefef39a1": "mintPublic(uint256)",
};

async function autoDetectCalldata(contract, qty = 1) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${contract}&sort=desc&page=1&offset=20&apikey=${apiKey}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.status !== "1" || !Array.isArray(json.result)) return null;

    for (const tx of json.result) {
      if (tx.to?.toLowerCase() !== contract.toLowerCase()) continue;
      const input = tx.input || "";
      const selector = input.slice(0, 10).toLowerCase();

      // Selector takes a uint256 quantity — re-encode with desired qty
      if (QTY_SELECTORS[selector]) {
        const encodedQty = qty.toString(16).padStart(64, "0");
        return { calldata: selector + encodedQty, sig: QTY_SELECTORS[selector], qty, autoDetected: true };
      }

      // No-arg mint selectors — use as-is
      if (["0x1249c58b", "0x4e71d92d", "0xd85d3d27", "0x26092b83", "0x77d8d0a7"].includes(selector)) {
        return { calldata: selector, sig: selector, qty: null, autoDetected: true };
      }
    }
  } catch (_) {}
  return null;
}

bot.command("mint", async (ctx) => {
  const input = ctx.match?.trim();
  if (!input) {
    return ctx.reply(
      `*Manual Mint*\n\n` +
      `Usage: \`/mint <contract> [group] [calldata|qty:N] [value_eth]\`\n\n` +
      `Examples:\n` +
      `\`/mint 0xContract\` — auto-detect calldata, qty 1\n` +
      `\`/mint 0xContract mine qty:5\` — auto-detect, mint 5 per wallet\n` +
      `\`/mint 0xContract mine qty:4 0.05\` — qty 4, pay 0.05 ETH each\n` +
      `\`/mint 0xContract mine 0x1249c58b 0.05\` — manual calldata`,
      { parse_mode: "Markdown" }
    );
  }

  // Smart parser: detect each arg by format
  // Rejoin hex fragments split by Telegram line-wrapping
  const rejoined = input.replace(/([0-9a-fA-F]+)\n\s*([0-9a-fA-F])/g, "$1$2").replace(/\n/g, " ");
  const args = rejoined.split(/\s+/);
  let contract = null, group = null, calldata = null, value = "0", qty = null;

  for (const arg of args) {
    if (/^0x[0-9a-fA-F]{40}$/.test(arg) && !contract) {
      contract = arg;
    } else if (/^0x[0-9a-fA-F]{8,}$/.test(arg)) {
      calldata = arg;
    } else if (/^qty:\d+$/i.test(arg)) {
      qty = parseInt(arg.split(":")[1]);
    } else if (/^\d*\.?\d+$/.test(arg)) {
      value = arg;
    } else if (/^[a-zA-Z0-9_-]+$/.test(arg)) {
      group = arg;
    }
  }

  if (!contract) {
    return ctx.reply("❌ Provide a valid contract address.\n\nUsage: `/mint 0xContract [group] [qty:N] [calldata] [value]`", { parse_mode: "Markdown" });
  }

  // Auto-detect calldata if not provided
  let autoDetectNote = "";
  if (!calldata) {
    const detected = await autoDetectCalldata(contract, qty || 1);
    if (detected) {
      calldata = detected.calldata;
      autoDetectNote = `\nAuto-detected: \`${detected.sig}\`${detected.qty ? ` × ${detected.qty}` : ""}`;
    }
  }

  const target = group ? `group *${group}*` : "all sub-wallets";
  const ethVal = parseFloat(value);

  await ctx.reply(
    `⚡ *Minting...*\n\n` +
    `Contract: \`${shortAddr(contract)}\`\n` +
    `Wallets: ${target}\n` +
    `Value: ${ethVal} ETH each\n` +
    `Calldata: \`${calldata || "default mint()"}\`` +
    autoDetectNote,
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

// ─── Decode Contract ──────────────────────────────────────────────────────────

const MINT_KEYWORDS = ["mint", "claim", "purchase", "buy", "presale", "allowlist", "whitelist"];

// Common mint selectors to probe when ABI isn't available
const KNOWN_SELECTORS = [
  { selector: "0x1249c58b", sig: "mint()" },
  { selector: "0x40c10f19", sig: "mint(address,uint256)" },
  { selector: "0xa0712d68", sig: "mint(uint256)" },
  { selector: "0x6a627842", sig: "mint(address)" },
  { selector: "0x4e71d92d", sig: "claim()" },
  { selector: "0x379607f5", sig: "claim(uint256)" },
  { selector: "0xd85d3d27", sig: "publicMint()" },
  { selector: "0x3b4c4b25", sig: "publicMint(uint256)" },
  { selector: "0x61a503b0", sig: "purchase(uint256)" },
  { selector: "0xefef39a1", sig: "mintPublic(uint256)" },
  { selector: "0x26092b83", sig: "freeMint()" },
  { selector: "0x77d8d0a7", sig: "claimFree()" },
];

function computeSelector(item) {
  const sig = `${item.name}(${item.inputs.map(i => i.type).join(",")})`;
  return ethers.id(sig).slice(0, 10);
}

bot.command("decode", async (ctx) => {
  const contract = ctx.match?.trim();
  if (!contract || !isValidAddress(contract)) {
    return ctx.reply(
      `*Decode Contract*\n\nFetches mint functions + selectors from Etherscan.\nFalls back to probing common selectors if contract isn't verified.\n\n` +
      `Usage: \`/decode 0xContractAddress\`\n\n` +
      `Then use the selector with:\n\`/mint 0xContract [group] 0xSELECTOR [value]\``,
      { parse_mode: "Markdown" }
    );
  }

  await ctx.reply(`🔍 Decoding \`${contract}\`...`, { parse_mode: "Markdown" });

  const apiKey = process.env.ETHERSCAN_API_KEY;

  // ── Path 1: Etherscan ABI lookup ──
  if (apiKey) {
    try {
      const url = `https://api.etherscan.io/api?module=contract&action=getabi&address=${contract}&apikey=${apiKey}`;
      const res = await fetch(url);
      const json = await res.json();

      if (json.status === "1") {
        const abi = JSON.parse(json.result);

        const mintFns = abi
          .filter(item => item.type === "function" && item.stateMutability !== "view" && item.stateMutability !== "pure")
          .filter(item => MINT_KEYWORDS.some(kw => item.name.toLowerCase().includes(kw)))
          .map(item => {
            const selector = computeSelector(item);
            const params = item.inputs.map(i => `${i.type}${i.name ? " " + i.name : ""}`).join(", ");
            const payable = item.stateMutability === "payable";
            return { name: item.name, selector, params, payable };
          });

        if (mintFns.length > 0) {
          const lines = mintFns.map(fn =>
            `\`${fn.selector}\` — *${fn.name}*(${fn.params})${fn.payable ? " 💰" : ""}`
          ).join("\n\n");

          return ctx.reply(
            `🔍 *Mint Functions — \`${contract.slice(0, 8)}...\`*\n\n${lines}\n\n` +
            `💰 = payable (pass ETH value)\n\n` +
            `Example: \`/mint ${contract} mine ${mintFns[0].selector}${mintFns[0].payable ? " 0.05" : ""}\``,
            { parse_mode: "Markdown" }
          );
        }

        // No mint-keyword functions — show all write functions
        const allWrite = abi
          .filter(item => item.type === "function" && item.stateMutability !== "view" && item.stateMutability !== "pure")
          .slice(0, 12)
          .map(item => {
            const selector = computeSelector(item);
            const payable = item.stateMutability === "payable";
            return `\`${selector}\` — ${item.name}${payable ? " 💰" : ""}`;
          });

        return ctx.reply(
          `⚠️ *No obvious mint functions found.*\n\nAll write functions on this contract:\n\n${allWrite.join("\n")}`,
          { parse_mode: "Markdown" }
        );
      }
      // If Etherscan returns non-"1", fall through to probe
    } catch (_) {
      // fall through
    }
  }

  // ── Path 2: Probe common selectors ──
  await ctx.reply(`⚙️ Contract not verified (or no API key). Probing ${KNOWN_SELECTORS.length} common selectors...`);

  const hits = [];
  await Promise.all(
    KNOWN_SELECTORS.map(async ({ selector, sig }) => {
      try {
        await provider.call({ to: contract, data: selector });
        // If we get here without "invalid opcode" / "function not found" it likely exists
        hits.push({ selector, sig, status: "✅ responds" });
      } catch (err) {
        const msg = err.message || "";
        // "invalid opcode" or no data = function probably doesn't exist
        // Revert with actual reason = function exists but call failed (missing args, paused, etc.)
        if (!msg.includes("invalid opcode") && !msg.includes("0x") === false) {
          if (msg.includes("execution reverted") || msg.includes("revert") || msg.length < 200) {
            hits.push({ selector, sig, status: "⚠️ reverts (exists, may need args/value)" });
          }
        }
      }
    })
  );

  if (hits.length === 0) {
    return ctx.reply(
      `❌ Couldn't identify mint functions on \`${contract.slice(0, 8)}...\`\n\n` +
      `Try checking Etherscan manually for the Input Data on a recent tx.\n\n` +
      `Add ETHERSCAN_API_KEY to Railway env for verified contract support.`,
      { parse_mode: "Markdown" }
    );
  }

  const lines = hits.map(h => `\`${h.selector}\` — *${h.sig}* ${h.status}`).join("\n");
  await ctx.reply(
    `🔍 *Selector Probe — \`${contract.slice(0, 8)}...\`*\n\n${lines}\n\n` +
    `Use: \`/mint ${contract} [group] <selector> [value]\``,
    { parse_mode: "Markdown" }
  );
});

// ─── Drop Watcher ─────────────────────────────────────────────────────────────

bot.command("watch", async (ctx) => {
  const args = ctx.match?.trim().split(/\s+/) || [];
  const contract = args[0];
  const group = args[1] || null;

  if (!contract || !isValidAddress(contract)) {
    return ctx.reply(
      `*SeaDrop Drop Watcher*\n\n` +
      `Polls every 30s — fires automatically when public mint goes live.\n\n` +
      `Usage: \`/watch <nftContract> [group]\`\n\n` +
      `Examples:\n` +
      `\`/watch 0x4ff1931f0a1c0c3e319cbfda81c850bb79f01693\` — all wallets\n` +
      `\`/watch 0x4ff1931f0a1c0c3e319cbfda81c850bb79f01693 karlkestis\` — one group`,
      { parse_mode: "Markdown" }
    );
  }

  const id = uuidv4();
  const calldata = buildMintPublicCalldata(contract);

  await addWatch({
    id,
    nftContract: contract.toLowerCase(),
    group: group || null,
    calldata,
    active: true,
    createdAt: Date.now(),
  });

  const target = group ? `group *${group}*` : "all wallets";
  await ctx.reply(
    `👁 *Watch Active!*\n\n` +
    `Contract: \`${contract}\`\n` +
    `Wallets: ${target}\n\n` +
    `Polling every 30s. Will auto-mint the moment public drop goes live.\n\n` +
    `ID: \`${id.slice(0, 8)}\` — use /watches to manage`,
    { parse_mode: "Markdown" }
  );
});

bot.command("watches", async (ctx) => {
  const watches = getWatches();
  if (watches.length === 0) {
    return ctx.reply("No active watches.\n\nUse `/watch <contract>` to set one up.", { parse_mode: "Markdown" });
  }

  const lines = watches.map((w) => {
    const status = w.active ? "👁 Active" : "✅ Fired";
    const target = w.group ? `group: ${w.group}` : "all wallets";
    const date = new Date(w.createdAt).toLocaleDateString();
    return `${status} | \`${w.nftContract.slice(0, 10)}...\` | ${target} | ${date}\nID: \`${w.id.slice(0, 8)}\``;
  });

  await ctx.reply(
    `*Drop Watches (${watches.length})*\n\n${lines.join("\n\n")}\n\nUse \`/unwatch <id>\` to cancel`,
    { parse_mode: "Markdown" }
  );
});

bot.command("unwatch", async (ctx) => {
  const input = ctx.match?.trim();
  if (!input) {
    return ctx.reply("Usage: `/unwatch <id>`\n\nGet the ID from /watches", { parse_mode: "Markdown" });
  }

  const watches = getWatches();
  const match = watches.find((w) => w.id.startsWith(input) || w.id === input);

  if (!match) {
    return ctx.reply(`❌ No watch found with ID \`${input}\`\n\nUse /watches to list them`, { parse_mode: "Markdown" });
  }

  await removeWatch(match.id);
  await ctx.reply(`🗑 Watch removed for \`${match.nftContract}\``, { parse_mode: "Markdown" });
});

// ─── Sweep Watcher ────────────────────────────────────────────────────────────

bot.command("watchsweep", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/) || [];
  const wallet = parts[0];

  if (!wallet || !isValidAddress(wallet)) {
    return ctx.reply(
      `*Whale Sweep Watcher*\n\n` +
      `Fires an alert when a wallet sweeps ≥N NFTs from the same collection within 5 minutes.\n\n` +
      `Usage: \`/watchsweep <wallet> [name] [threshold]\`\n\n` +
      `Examples:\n` +
      `\`/watchsweep 0xdbd4...c495\` — defaults: name=wallet, threshold=3\n` +
      `\`/watchsweep 0xdbd4...c495 TMA 5\` — alert when TMA sweeps 5+ from one collection`,
      { parse_mode: "Markdown" }
    );
  }

  // Parse optional name and threshold
  // If last part is a number, treat as threshold
  let name = null;
  let threshold = 3;
  if (parts.length >= 3 && !isNaN(parseInt(parts[parts.length - 1]))) {
    threshold = parseInt(parts[parts.length - 1]);
    name = parts.slice(1, -1).join(" ") || null;
  } else if (parts.length >= 2) {
    name = parts.slice(1).join(" ");
  }

  const addr = wallet.toLowerCase();
  const existing = getSweepWatchers().find(w => w.wallet === addr);
  if (existing) {
    return ctx.reply(`Already watching \`${addr}\` for sweeps.\n\nUse /sweepwatches to manage.`, { parse_mode: "Markdown" });
  }

  // Seed lastBlock to current block so we don't replay history
  let startBlock = "latest";
  try {
    const alchemy = getAlchemy();
    const blockNum = await alchemy.core.getBlockNumber();
    startBlock = "0x" + blockNum.toString(16);
  } catch (_) { /* fall back to "latest" */ }

  const id = uuidv4();
  await addSweepWatcher({
    id,
    wallet: addr,
    name: name || (addr.slice(0, 6) + "..." + addr.slice(-4)),
    threshold,
    lastBlock: startBlock,
    createdAt: Date.now(),
  });

  await ctx.reply(
    `👁 *Sweep Watcher Active!*\n\n` +
    `Wallet: \`${addr}\`\n` +
    `Name: ${name || "—"}\n` +
    `Alert threshold: ${threshold} NFTs from same collection in 5 min\n\n` +
    `ID: \`${id.slice(0, 8)}\` — use /sweepwatches to manage`,
    { parse_mode: "Markdown" }
  );
});

bot.command("sweepwatches", async (ctx) => {
  const watchers = getSweepWatchers();
  if (watchers.length === 0) {
    return ctx.reply(
      "No sweep watchers active.\n\nUse `/watchsweep <wallet>` to add one.",
      { parse_mode: "Markdown" }
    );
  }

  const lines = watchers.map(w => {
    const date = new Date(w.createdAt).toLocaleDateString();
    return (
      `👁 *${w.name}*\n` +
      `Wallet: \`${w.wallet}\`\n` +
      `Threshold: ${w.threshold} NFTs | Added: ${date}\n` +
      `ID: \`${w.id.slice(0, 8)}\``
    );
  });

  await ctx.reply(
    `*Sweep Watchers (${watchers.length})*\n\n` +
    lines.join("\n\n─────────────────\n\n") +
    `\n\nUse \`/unsweepwatch <id>\` to remove`,
    { parse_mode: "Markdown" }
  );
});

bot.command("unsweepwatch", async (ctx) => {
  const input = ctx.match?.trim();
  if (!input) {
    return ctx.reply("Usage: `/unsweepwatch <id>`\n\nGet the ID from /sweepwatches", { parse_mode: "Markdown" });
  }

  const watchers = getSweepWatchers();
  const match = watchers.find(w => w.id.startsWith(input) || w.id === input);
  if (!match) {
    return ctx.reply(`❌ No sweep watcher found with ID \`${input}\`\n\nUse /sweepwatches to list them`, { parse_mode: "Markdown" });
  }

  await removeSweepWatcher(match.id);
  await ctx.reply(`🗑 Sweep watcher removed for *${match.name}* (\`${match.wallet}\`)`, { parse_mode: "Markdown" });
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

// ─── Mint History ─────────────────────────────────────────────────────────────

bot.command("history", async (ctx) => {
  const log = getMintLog();

  if (log.length === 0) {
    return ctx.reply("No mints logged yet. History starts recording from now.");
  }

  // Optional page number: /history 2
  const page = Math.max(1, parseInt(ctx.match?.trim() || "1") || 1);
  const PAGE_SIZE = 10;
  const total = log.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Most recent first
  const reversed = [...log].reverse();
  const start = (page - 1) * PAGE_SIZE;
  const slice = reversed.slice(start, start + PAGE_SIZE);

  if (slice.length === 0) {
    return ctx.reply(`No entries on page ${page}. There are ${totalPages} page(s).`);
  }

  const lines = slice.map((entry, i) => {
    const num = start + i + 1;
    const date = new Date(entry.timestamp).toISOString().slice(0, 16).replace("T", " ");
    const eth = entry.ethSpent > 0 ? `${entry.ethSpent.toFixed(5)} ETH` : "free";
    return (
      `*#${num}* — ${date} UTC\n` +
      `Contract: \`${shortAddr(entry.contract)}\`\n` +
      `Wallet: \`${shortAddr(entry.wallet)}\`\n` +
      `Spent: ${eth}\n` +
      `[View Tx](https://etherscan.io/tx/${entry.txHash})`
    );
  });

  const kb = new InlineKeyboard();
  if (page > 1) kb.text(`◀️ Page ${page - 1}`, `history_${page - 1}`);
  if (page < totalPages) kb.text(`Page ${page + 1} ▶️`, `history_${page + 1}`);

  await ctx.reply(
    `📋 *Mint History* (${total} total — page ${page}/${totalPages})\n\n` +
    lines.join("\n\n─────────────────\n\n"),
    { parse_mode: "Markdown", reply_markup: kb, disable_web_page_preview: true }
  );
});

bot.callbackQuery(/^history_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match[1]);
  const log = getMintLog();
  const PAGE_SIZE = 10;
  const total = log.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const reversed = [...log].reverse();
  const start = (page - 1) * PAGE_SIZE;
  const slice = reversed.slice(start, start + PAGE_SIZE);

  const lines = slice.map((entry, i) => {
    const num = start + i + 1;
    const date = new Date(entry.timestamp).toISOString().slice(0, 16).replace("T", " ");
    const eth = entry.ethSpent > 0 ? `${entry.ethSpent.toFixed(5)} ETH` : "free";
    return (
      `*#${num}* — ${date} UTC\n` +
      `Contract: \`${shortAddr(entry.contract)}\`\n` +
      `Wallet: \`${shortAddr(entry.wallet)}\`\n` +
      `Spent: ${eth}\n` +
      `[View Tx](https://etherscan.io/tx/${entry.txHash})`
    );
  });

  const kb = new InlineKeyboard();
  if (page > 1) kb.text(`◀️ Page ${page - 1}`, `history_${page - 1}`);
  if (page < totalPages) kb.text(`Page ${page + 1} ▶️`, `history_${page + 1}`);

  await ctx.editMessageText(
    `📋 *Mint History* (${total} total — page ${page}/${totalPages})\n\n` +
    lines.join("\n\n─────────────────\n\n"),
    { parse_mode: "Markdown", reply_markup: kb, disable_web_page_preview: true }
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
  onStart: async () => {
    console.log("[Bot] Online and watching");
    try { await bot.api.setMyCommands([
      // Dashboard
      { command: "start",           description: "Welcome message" },
      { command: "status",          description: "Live bot dashboard" },
      { command: "commands",        description: "Full command list" },
      // Whale tracking
      { command: "track",           description: "Track a whale wallet" },
      { command: "untrack",         description: "Stop tracking a wallet" },
      { command: "tracked",         description: "List tracked wallets" },
      { command: "whalestats",      description: "Whale daily on-chain activity" },
      // Auto-mint
      { command: "setmaxmint",      description: "Set max mint price in USD" },
      { command: "togglefreemints", description: "Allow / block free mints" },
      { command: "togglecatchall",  description: "Catch all whale contract calls" },
      // Filters
      { command: "mintfilters",     description: "View whitelist & blacklist" },
      { command: "whitelist",       description: "Only auto-mint this contract" },
      { command: "unwhitelist",     description: "Remove contract from whitelist" },
      { command: "blacklist",       description: "Never auto-mint this contract" },
      { command: "unblacklist",     description: "Remove contract from blacklist" },
      // Manual mint
      { command: "mint",            description: "Fire a manual mint now" },
      // Wallets
      { command: "wallets",         description: "List all sub-wallets with balances" },
      { command: "addwallet",       description: "Add a sub-wallet" },
      { command: "removewallet",    description: "Remove a sub-wallet" },
      { command: "checkgas",        description: "Show wallets with low gas" },
      { command: "distribute",      description: "Send ETH to wallets or group" },
      { command: "sweepgas",        description: "Pull all ETH back to main wallet" },
      { command: "sweepnfts",       description: "Sweep NFTs to main wallet" },
      // Groups
      { command: "creategroup",     description: "Create a wallet group" },
      { command: "groups",          description: "List all groups" },
      { command: "groupwallets",    description: "List wallets in a group" },
      { command: "groupbalance",    description: "Show balances for a group" },
      { command: "groupprivatekey", description: "Export private keys for a group" },
      { command: "deletegroup",     description: "Delete a group" },
      // Scheduled mints
      { command: "schedule",        description: "Schedule a mint" },
      { command: "jobs",            description: "View pending scheduled mints" },
      // History & profits
      { command: "history",         description: "Full mint log (paginated)" },
      { command: "profits",         description: "P&L tracker with floor prices" },
      // Price alerts
      { command: "setalert",        description: "Alert when floor hits target ETH" },
      { command: "removealert",     description: "Remove a price alert" },
      { command: "alerts",          description: "List all active price alerts" },
      // Drop watcher
      { command: "watch",           description: "Watch a SeaDrop contract for drop" },
      { command: "watches",         description: "List active drop watchers" },
      { command: "unwatch",         description: "Remove a drop watcher" },
      // Settings
      { command: "setalertchat",    description: "Set this chat as the alert channel" },
      // Sweep watcher
      { command: "watchsweep",      description: "Alert when a wallet sweeps a collection" },
      { command: "sweepwatches",    description: "List active sweep watchers" },
      { command: "unsweepwatch",    description: "Remove a sweep watcher" },
    ]); console.log("[Bot] Commands registered with Telegram");
    } catch (e) { console.warn("[Bot] setMyCommands failed:", e.message); }
  },
});

// Graceful shutdown for Railway restarts
process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
