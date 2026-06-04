import "dotenv/config";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { ethers } from "ethers";
import { initDb, addTracked, removeTracked, getTracked, getSettings, updateSettings, createGroup, deleteGroup, getGroups, getGroupWallets, addToWhitelist, removeFromWhitelist, addToBlacklist, removeFromBlacklist, getMintLog, addWatch, removeWatch, getWatches, addPriceAlert, removePriceAlert, getPriceAlerts, addSweepWatcher, removeSweepWatcher, getSweepWatchers } from "./storage.js";
import { initPriceAlerts, getFloorPrice as getAlertFloorPrice } from "./priceAlerts.js";
import { addWallet, deleteWallet, listWallets, distributeGas, sweepGas, sweepNFTs, getGroupPrivateKeys } from "./wallets.js";
import { addMintWallet, removeMintWallet, listMintWallets, getMintSigners } from "./wallets.js";
import { initTracker, startTracking, restartTracking, getAlchemy, getTrackerState, setTrackerAlertFn } from "./tracker.js";
import { initMoralisStream, addToMoralisStream, removeFromMoralisStream } from "./moralisStream.js";
import { initCopyMint, resolveApproval, resolveIdSelection, setIdSelectionFn, executeManualMint, executePerWalletMint } from "./copymint.js";
import { initScheduler, createJob, cancelJob, getPendingJobs } from "./scheduler.js";
import { initWatcher, startWatcher, buildMintPublicCalldata } from "./watcher.js";
import { initSweepWatcher } from "./sweepWatcher.js";
import { initDailyDigest } from "./dailyDigest.js";
import { initSalesWatcher } from "./salesWatcher.js";
import { initSeadropDetector } from "./seadropDetector.js";
import { initNewCollectionWatcher } from "./newCollectionWatcher.js";
import { initMintFloorTracker } from "./mintFloorTracker.js";
import { getContractInfo, massListNFTs } from "./listing.js";
import { fetchABI, findBestMintFn, readMintPrice, buildMintCalldata, mintFnSignature } from "./contractMinter.js";
import { analyzeLink, classifyMintType, findAvailableTokenIds } from "./linkAnalyzer.js";
import { inspectMint, buildAllowlistCalldata, getAllowlistProof, phaseStatus, fmtUTC, humanDuration, resolveSeadropAllowlistBatch } from "./mintInspector.js";

const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
import { initSniper, scheduleSnipe, listSnipes, cancelSnipe } from "./sniper.js";
import { computeGas, GAS_TIERS, gweiOf } from "./gas.js";

// Gas + private-send opts for a manual /inspect fire, using the configured tier
async function inspectFireOpts(signers) {
  const s = getSettings();
  const gas = await computeGas(provider, s.gasTier || "fast", s.gasCeilingGwei || 200);
  const sendVia = s.privateSnipe ? flashbotsProvider : undefined;
  return { signers, gas, sendVia };
}
import { WHALE_SEED } from "./whale-meta.js";
import { v4 as uuidv4 } from "uuid";
import { initBlockScanner } from "./blockScanner.js";
import { initDaemonSniper, runDaemonSnipe, runDaemonWrap, detectPool, detectTax, detectWrapFunction, addSnipeWallet, removeSnipeWallet, clearSnipeWallets, getSnipeWalletAddresses } from "./daemonSniper.js";

// ─── Init ────────────────────────────────────────────────────────────────────

await initDb();

const bot = new Bot(process.env.BOT_TOKEN);
// Dedicated Alchemy RPC for low-latency reads + sends; fall back to public node if no key
const RPC_URL = process.env.ALCHEMY_API_KEY
  ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : "https://ethereum.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);
// Flashbots Protect — private mempool, no gas paid on reverted/failed mints, front-run resistant
const flashbotsProvider = new ethers.JsonRpcProvider("https://rpc.flashbots.net/fast");
const mainSigner = new ethers.Wallet(process.env.MAIN_PRIVATE_KEY, provider);
const MAIN_ADDRESS = await mainSigner.getAddress();
console.log(`[Init] RPC: ${process.env.ALCHEMY_API_KEY ? "Alchemy (dedicated)" : "publicnode (fallback)"}`);

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

// Seed whale wallets on startup — adds any missing ones without touching existing
const tracked = getTracked();
let seeded = 0;
for (const addr of WHALE_SEED) {
  if (!tracked.includes(addr.toLowerCase())) {
    await addTracked(addr.toLowerCase());
    seeded++;
  }
}
if (seeded > 0) console.log(`[Seed] Added ${seeded} new whale wallet(s) to tracked list`);

// Init subsystems
if (process.env.MORALIS_API_KEY) {
  console.log("[Bot] MORALIS_API_KEY found — using Moralis Streams tracker");
  await initMoralisStream();
} else {
  initTracker(process.env.ALCHEMY_API_KEY);
  setTrackerAlertFn(notify);
  await startTracking();
}
await initCopyMint(provider, mainSigner, notify, askApproval);

async function askIdSelection({ mintId, nftAddr, available, total, minted, allAvailable }) {
  const chatId = getSettings().alertChatId || process.env.ALERT_CHAT_ID;
  if (!chatId) return;
  const kb = new InlineKeyboard();
  available.forEach((id, i) => {
    kb.text(`#${id}`, `id_pick_${mintId}_${id}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  if (available.length % 3 !== 0) kb.row();
  kb.text("🔢 Custom ID", `id_custom_${mintId}`);
  await bot.api.sendMessage(
    chatId,
    `🎨 *ID-Based Mint*\n\n` +
    `Contract: \`${nftAddr}\`\n` +
    `Available: *${allAvailable.toLocaleString()}* IDs${total ? ` / ${total.toLocaleString()} total` : ""}\n\n` +
    `Pick a token ID for main wallet.\nSub-wallets auto-assign from remaining.\n` +
    `_⏰ Times out in 2 min_`,
    { parse_mode: "Markdown", reply_markup: kb }
  );
}
setIdSelectionFn(askIdSelection);

initScheduler(notify);
initWatcher(provider, notify);
initSniper(provider, notify, flashbotsProvider);
initPriceAlerts(notify);
initSweepWatcher(notify);
initDailyDigest(notify);
initSalesWatcher(notify);
initSeadropDetector(notify);
initNewCollectionWatcher(notify);
initMintFloorTracker(notify);
initDaemonSniper(provider, mainSigner);
startWatcher();
if (!process.env.MORALIS_API_KEY) await startTracking();
// Block scanner runs always — catches every whale mint regardless of Moralis stream status
initBlockScanner().catch(e => console.warn("[BlockScanner] Init failed:", e.message));

// ─── Helpers ────────────────────────────────────────────────────────────────

function isValidAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function shortAddr(addr) {
  return addr;
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

  const ws = getTrackerState();
  const wsMin = Math.floor(ws.staleSeconds / 60);
  const wsSec = ws.staleSeconds % 60;
  const wsAge = wsMin > 0 ? `${wsMin}m ${wsSec}s ago` : `${wsSec}s ago`;
  const wsIcon = ws.staleSeconds < 300 ? on : ws.staleSeconds < 900 ? "🟡" : off;

  return (
    `✅ *Status Update*\n\n` +
    `*Modules:*\n` +
    `Tracker: ${tracked.length > 0 ? on : off}\n` +
    `WebSocket: ${wsIcon} last event ${wsAge}\n` +
    `Auto-Mint: ${settings.autoMint ? on + " ON" : off + " OFF"}\n` +
    `MEV Shield: ${settings.mevShield ? on + " ON" : off + " OFF"}\n` +
    `Max Mint: $${settings.maxMintUsd || "2.10"} USD\n` +
    `Free Mints: ${settings.allowFreeMints !== false ? on + " ON" : off + " OFF"}\n` +
    `Catch-All: ${settings.catchAll ? "⚡ ON" : off + " OFF (known selectors only)"}\n\n` +
    `*Filters:*\n` +
    `Whitelist: ${wl.length > 0 ? `${wl.length} contract(s)` : "All"}\n` +
    `Blacklist: ${bl.length > 0 ? `${bl.length} blocked` : "None"}\n\n` +
    `*Network:*\n` +
    `Tracker Mode: ${process.env.MORALIS_API_KEY ? "Moralis Streams (webhook)" : "Alchemy WebSocket"}\n` +
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
    `/topup [usd] [group] — show how much ETH each wallet needs to reach a USD target (default $0.30)\n` +
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
    `/toggleautomint — enable/disable copy-minting\n` +
    `/togglefreemints — allow/block free mints\n` +
    `/togglecatchall — fire on ANY whale contract call (catches unknown mints)\n` +
    `/profits [contract] — mint profit tracker\n` +
    `/volume [7d] — volume tracker for minted contracts\n` +
    `/history [page] — full mint transaction history\n` +
    `/schedule — schedule a mint\n` +
    `/jobs — view scheduled mints\n` +
    `/setmaxmint <usd> — set max copy-mint price in USD\n` +
    `/setalertchat — set this chat as alert chat\n` +
    `/checkca <contract> — scan wallets for NFT + floor price\n` +
    `/list <range|group> <contract> <price> — mass list NFTs on OpenSea`,
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
    `/toggleautomint — enable/disable copy-minting\n` +
    `/togglefreemints — allow/block free mints\n` +
    `/togglecatchall — catch ALL whale contract calls\n\n` +

    `*🔍 Filters*\n` +
    `/mintfilters — view whitelist & blacklist\n` +
    `/whitelist <contract> — only auto-mint this contract\n` +
    `/unwhitelist <contract> — remove from whitelist\n` +
    `/blacklist <contract> — never auto-mint this contract\n` +
    `/unblacklist <contract> — remove from blacklist\n\n` +

    `*🖐 Manual Mint*\n` +
    `/sniff <contract> [group] [value] — auto-grab calldata + mint instantly\n` +
    `/mint <contract> [group] [calldata] [value] — fire mint now\n` +
    `/decode <contract> — get mint function selectors\n\n` +

    `*💼 Wallets*\n` +
    `/wallets — list all sub-wallets with balances\n` +
    `/addwallet <privkey> — add a sub-wallet\n` +
    `/removewallet <address> — remove a sub-wallet\n` +
    `/checkgas [min_eth] — show wallets with low gas\n` +
    `/topup [usd] [group] — show how much ETH each wallet needs to reach a USD target (default $0.30)\n` +
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
    `/profits [contract] — P&L tracker with floor prices\n` +
    `/volume [7d] — volume tracker for minted contracts, sorted by 24h (or 7d) vol\n\n` +

    `*🔔 Price Alerts*\n` +
    `/setalert <contract> <name> <price> — alert when floor hits target ETH\n` +
    `/removealert <contract> — remove an alert\n` +
    `/alerts — list all active alerts\n\n` +

    `*⚙️ Settings*\n` +
    `/setalertchat — set this chat as the alert channel\n\n` +

    `*🏷️ OpenSea Listing*\n` +
    `/checkca <contract> — scan wallets for NFT balance + floor price\n` +
    `/list <range|group> <contract> <price> — mass list NFTs at price (ETH)`,
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
  if (process.env.MORALIS_API_KEY) {
    await addToMoralisStream(address.toLowerCase());
  } else {
    await restartTracking();
  }
  await ctx.reply(`🐋 Tracking \`${shortAddr(address)}\``, { parse_mode: "Markdown" });
});

bot.command("untrack", async (ctx) => {
  const address = ctx.match?.trim();
  if (!address || !isValidAddress(address)) {
    return ctx.reply("Usage: /untrack 0xAddress");
  }
  await removeTracked(address);
  if (process.env.MORALIS_API_KEY) {
    await removeFromMoralisStream(address.toLowerCase());
  } else {
    await restartTracking();
  }
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

bot.command("trackerstate", async (ctx) => {
  const ws = getTrackerState();
  const tracked = getTracked();
  const wsMin = Math.floor(ws.staleSeconds / 60);
  const wsSec = ws.staleSeconds % 60;
  const wsAge = wsMin > 0 ? `${wsMin}m ${wsSec}s ago` : `${wsSec}s ago`;
  const wsIcon = ws.staleSeconds < 300 ? "🟢" : ws.staleSeconds < 900 ? "🟡" : "🔴";

  await ctx.reply(
    `*Tracker State*\n\n` +
    `WebSocket: ${wsIcon} last event *${wsAge}*\n` +
    `Subscription: ${ws.subscriptionActive ? "🟢 active" : "🔴 not active"}\n` +
    `Tracked whales: ${tracked.length}\n\n` +
    (ws.staleSeconds > 900
      ? `⚠️ No WS events in ${wsMin}m — watchdog should restart soon. If still silent after 5 min, use /restarttracker.`
      : ws.staleSeconds > 300
      ? `🟡 Quiet for ${wsMin}m — whales may just not be minting.`
      : `✅ Connection healthy.`),
    { parse_mode: "Markdown" }
  );
});

bot.command("restarttracker", async (ctx) => {
  await restartTracking();
  await ctx.reply("🔄 Tracker restarted — WebSocket subscriptions rebuilt.");
});

// ─── Whale Daily Activity ─────────────────────────────────────────────────────

async function fetchWhaleActivity(address, dateStr) {
  const alchemy = getAlchemy();
  if (!alchemy) throw new Error("Whale activity stats require Alchemy — not available in Moralis mode.");

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

  // Fetch current floor to determine alert direction
  const currentFloor = await getAlertFloorPrice(contract.toLowerCase());
  const direction = (currentFloor !== null && targetPrice < currentFloor) ? "below" : "above";
  const directionLabel = direction === "below" ? "drops to or below" : "rises to or above";

  await addPriceAlert({
    id: uuidv4Alert(),
    contract: contract.toLowerCase(),
    name,
    targetPrice,
    direction,
    lastFiredAt: null,
    createdAt: Date.now(),
  });
  const floorNote = currentFloor !== null ? `\nCurrent floor: *${currentFloor.toFixed(4)} ETH*` : "\nCurrent floor: *no listings yet*";
  await ctx.reply(`✅ Alert set!\nI'll ping you when *${name}* floor ${directionLabel} *${targetPrice} ETH*${floorNote}`, { parse_mode: "Markdown" });
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
const pendingCustomId = new Map(); // chatId → mintId

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

bot.command("toggleautomint", async (ctx) => {
  const settings = getSettings();
  await updateSettings({ autoMint: !settings.autoMint });
  const now = !settings.autoMint;
  await ctx.reply(
    `${now ? "⚡" : "🔴"} *Auto-Mint: ${now ? "ENABLED" : "DISABLED"}*\n\n` +
    (now
      ? `Bot will now automatically copy-mint when a tracked whale mints.`
      : `Bot will send alerts only — no automatic minting.`),
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

    const MINT_LIKE = ["mint", "claim", "purchase", "free", "public"];
    for (const tx of json.result) {
      if (tx.to?.toLowerCase() !== contract.toLowerCase()) continue;
      if (tx.isError !== "0") continue;
      const input = tx.input || "";
      if (input.length < 10 || input === "0x") continue;
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

      // Fallback: return full raw calldata from any successful tx with a mint-like method
      // (covers custom selectors like scatter.art's 0x4a21a2df)
      return { calldata: input, sig: selector, qty: null, autoDetected: true, rawSniff: true };
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

// ─── Mint From Contract (ABI auto-detect) ────────────────────────────────────

bot.command("mintca", async (ctx) => {
  const input = ctx.match?.trim();
  if (!input) {
    return ctx.reply(
      `*Mint From Contract*\n\n` +
      `Fetches ABI from Etherscan, auto-detects the mint function and price, then fires on all wallets (or a group).\n\n` +
      `Usage: \`/mintca <contract> [group] [qty]\`\n\n` +
      `Examples:\n` +
      `\`/mintca 0xContract\` — 1 mint per wallet, all wallets\n` +
      `\`/mintca 0xContract mine 5\` — 5 mints per wallet, group "mine"`,
      { parse_mode: "Markdown" }
    );
  }

  const args = input.split(/\s+/);
  let contract = null, group = null, qty = 1;

  for (const arg of args) {
    if (/^0x[0-9a-fA-F]{40}$/.test(arg) && !contract) {
      contract = arg;
    } else if (/^\d+$/.test(arg)) {
      qty = Math.max(1, parseInt(arg));
    } else if (/^[a-zA-Z0-9_-]+$/.test(arg)) {
      group = arg;
    }
  }

  if (!contract) {
    return ctx.reply("❌ Provide a valid contract address.\n\nUsage: `/mintca 0xContract [group] [qty]`", { parse_mode: "Markdown" });
  }

  await ctx.reply(`🔍 Reading contract \`${contract}\`...`, { parse_mode: "Markdown" });

  const apiKey = process.env.ETHERSCAN_API_KEY;
  const abi = await fetchABI(contract, apiKey);
  const mintFn = findBestMintFn(abi);
  const priceEth = await readMintPrice(provider, contract, abi);
  const walletAddr = await mainSigner.getAddress();

  // Build calldata from ABI; fall back to tx-sniff if ABI unavailable
  let calldata = mintFn ? buildMintCalldata(mintFn, qty, walletAddr) : null;
  let fnSig = mintFn ? mintFnSignature(mintFn) : null;
  let abiSource = abi ? "Etherscan ABI" : "tx history";

  if (!calldata) {
    const detected = await autoDetectCalldata(contract, qty);
    if (detected) {
      calldata = detected.calldata;
      fnSig = detected.sig;
      abiSource = "tx history (unverified)";
    }
  }

  if (!calldata) {
    return ctx.reply(
      `❌ *Could not detect mint function.*\n\n` +
      (abi
        ? `Contract is verified but no standard mint function found.`
        : `Contract is not verified on Etherscan and no matching txs found.`) +
      `\n\nTry \`/decode ${contract}\` to inspect manually, then use \`/mint\`.`,
      { parse_mode: "Markdown" }
    );
  }

  const isFree = priceEth === "0";
  const totalEth = isFree ? 0 : parseFloat(priceEth) * qty;
  const totalEthStr = totalEth.toFixed(6);

  await ctx.reply(
    `⚡ *Contract Mint Firing...*\n\n` +
    `Contract: \`${contract}\`\n` +
    `Function: \`${fnSig}\`\n` +
    `Qty per wallet: ${qty}\n` +
    `Price: ${isFree ? "🆓 FREE" : `${priceEth} ETH × ${qty} = ${totalEthStr} ETH`}\n` +
    `Wallets: ${group ? `group *${group}*` : "all sub-wallets"}\n` +
    `Source: ${abiSource}`,
    { parse_mode: "Markdown" }
  );

  try {
    const { succeeded, failed, skipped, total } = await executeManualMint(
      contract,
      calldata,
      isFree ? "0" : totalEthStr,
      group || null
    );
    await ctx.reply(
      `✅ *Contract Mint Complete!*\n\n` +
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

// ─── Analyze Link & Auto-Mint ─────────────────────────────────────────────────

// Pending link-mint state: uuid → { contract, selector, sig, mintFn, priceEth, mintType, qty, group, tokenIds }
const pendingLinkMints = new Map();

bot.command("analyzelink", async (ctx) => {
  const input = (ctx.match?.trim() || "");
  if (!input) {
    return ctx.reply(
      `*Analyze Link & Mint*\n\n` +
      `Paste any NFT mint page URL. The bot will find the contract, decode the mint format, and fire across your wallets.\n\n` +
      `Usage: \`/analyzelink <url> [group] [qty]\`\n\n` +
      `Examples:\n` +
      `\`/analyzelink https://mint.example.xyz\`\n` +
      `\`/analyzelink https://mint.example.xyz mine 2\``,
      { parse_mode: "Markdown" }
    );
  }

  const parts = input.split(/\s+/);
  const url = parts[0];
  let group = null, qty = 1;
  for (const p of parts.slice(1)) {
    if (/^\d+$/.test(p)) qty = Math.max(1, parseInt(p));
    else group = p;
  }

  if (!/^https?:\/\/.+/.test(url)) {
    return ctx.reply("❌ Provide a valid URL starting with http:// or https://");
  }

  const statusMsg = await ctx.reply(`🔍 Fetching \`${url}\`...`, { parse_mode: "Markdown" });

  let analysis;
  try {
    analysis = await analyzeLink(url, provider, process.env.ETHERSCAN_API_KEY);
  } catch (err) {
    return ctx.reply(`❌ Analysis failed: ${err.message}`);
  }

  const best = analysis.best;
  if (!best) {
    return ctx.reply(
      `❌ *No mintable contract found.*\n\n` +
      `Found ${analysis.allFound} address(es) on the page but none matched an NFT contract or known mint pattern.\n\n` +
      `Try \`/mintca\` with the contract address directly if you have it.`,
      { parse_mode: "Markdown" }
    );
  }

  // For tokenId-type mints, probe for available IDs now
  let tokenIds = [];
  if (best.mintType === "tokenId") {
    await bot.api.editMessageText(ctx.chat.id, statusMsg.message_id,
      `🔍 Scanning for available token IDs on \`${best.contract}\`...`, { parse_mode: "Markdown" });
    tokenIds = await findAvailableTokenIds(provider, best.contract, 150);
  }

  const id = Math.random().toString(36).slice(2, 10);
  pendingLinkMints.set(id, {
    contract: best.contract,
    selector: best.selector,
    sig: best.sig,
    mintFn: best.mintFn,
    priceEth: best.priceEth,
    mintType: best.mintType,
    qty,
    group,
    tokenIds,
    url,
  });

  // Auto-expire after 10 minutes
  setTimeout(() => pendingLinkMints.delete(id), 10 * 60 * 1000);

  const isFree = best.priceEth === "0";
  const priceStr = isFree ? "🆓 FREE" : `${best.priceEth} ETH`;
  const typeEmoji = { noarg: "🔘", quantity: "🔢", tokenId: "🎟️", unknown: "❓" }[best.mintType] || "❓";

  let summary =
    `🔗 *Link Analysis Complete*\n\n` +
    `URL: ${url}\n` +
    `Contract: \`${best.contract}\`\n` +
    `Verified: ${best.hasAbi ? "✅" : "❌ unverified"}\n` +
    `Mint fn: \`${best.sig || best.selector || "unknown"}\`\n` +
    `Type: ${typeEmoji} ${best.mintType}\n` +
    `Price: ${priceStr}\n` +
    `Source: ${best.source || "unknown"}\n`;

  if (best.mintType === "tokenId") {
    if (tokenIds.length === 0) {
      summary += `\n⚠️ Could not find any available token IDs — contract may be sold out or use a non-standard ID scheme.`;
    } else {
      summary += `\n🎟️ Found *${tokenIds.length}* available token IDs (will assign 1 per wallet)`;
    }
  }

  if (!best.sig && !best.selector) {
    summary += `\n\n⚠️ Could not decode mint format. Try \`/mintca ${best.contract}\` or check Etherscan for the contract.`;
    return ctx.reply(summary, { parse_mode: "Markdown" });
  }

  if (best.mintType === "tokenId" && tokenIds.length === 0) {
    return ctx.reply(summary, { parse_mode: "Markdown" });
  }

  const kb = new InlineKeyboard()
    .text("🚀 Mint — All Wallets", `lm_all_${id}`)
    .text("🎯 Mint — Group", `lm_grp_${id}`)
    .row()
    .text("❌ Cancel", `lm_cancel_${id}`);

  await ctx.reply(summary, { parse_mode: "Markdown", reply_markup: kb });
});

// Mint all wallets
bot.callbackQuery(/^lm_all_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const job = pendingLinkMints.get(id);
  if (!job) return ctx.answerCallbackQuery("❌ Expired — run /analyzelink again.");
  await ctx.answerCallbackQuery("Minting...");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  await _fireLinkMint(ctx, job, null);
});

// Show group picker
bot.callbackQuery(/^lm_grp_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const job = pendingLinkMints.get(id);
  if (!job) return ctx.answerCallbackQuery("❌ Expired.");
  await ctx.answerCallbackQuery();

  const groups = getGroups();
  if (!groups || groups.length === 0) {
    return ctx.reply("❌ No groups configured. Use /creategroup first.");
  }

  const kb = new InlineKeyboard();
  groups.forEach((g, i) => {
    kb.text(g.name, `lm_g_${id}_${g.name}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  kb.row().text("❌ Cancel", `lm_cancel_${id}`);

  await ctx.reply("Which group?", { reply_markup: kb });
});

// Mint specific group
bot.callbackQuery(/^lm_g_([^_]+)_(.+)$/, async (ctx) => {
  const groupName = ctx.match[1];
  const id = ctx.match[2];
  const job = pendingLinkMints.get(id);
  if (!job) return ctx.answerCallbackQuery("❌ Expired.");
  await ctx.answerCallbackQuery(`Minting group: ${groupName}`);
  await _fireLinkMint(ctx, job, groupName);
});

// Cancel
bot.callbackQuery(/^lm_cancel_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  pendingLinkMints.delete(id);
  await ctx.answerCallbackQuery("Cancelled.");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });
});

async function _fireLinkMint(ctx, job, groupOverride) {
  const { contract, selector, sig, mintFn, priceEth, mintType, qty, tokenIds, url } = job;
  const group = groupOverride ?? job.group;
  const isFree = priceEth === "0";
  const valueEth = isFree ? "0" : (parseFloat(priceEth) * qty).toFixed(6);

  await ctx.reply(
    `⚡ *Firing Link Mint...*\n\n` +
    `Contract: \`${contract}\`\n` +
    `Fn: \`${sig || selector}\`\n` +
    `Type: ${mintType} | Price: ${isFree ? "FREE" : `${priceEth} ETH`}\n` +
    `Wallets: ${group ? `group *${group}*` : "all sub-wallets"}`,
    { parse_mode: "Markdown" }
  );

  try {
    let result;

    if (mintType === "tokenId" && tokenIds.length > 0) {
      // Each wallet gets its own token ID — build per-wallet calldata
      const mintSig = sig || "mint(uint256)";
      const iface = new ethers.Interface([`function ${mintSig}`]);
      const fnName = mintSig.split("(")[0];

      let idIndex = 0;
      const calldataFn = (address) => {
        if (idIndex >= tokenIds.length) return null;
        const tokenId = tokenIds[idIndex++];
        try {
          return iface.encodeFunctionData(fnName, [tokenId]);
        } catch {
          // fallback: raw encode
          return selector + tokenId.toString(16).padStart(64, "0");
        }
      };
      result = await executePerWalletMint(contract, calldataFn, valueEth, group);
    } else {
      // Quantity or no-arg — single calldata for all wallets
      let calldata;
      if (mintType === "noarg" || !selector) {
        calldata = selector || "0x1249c58b";
      } else if (mintFn) {
        calldata = buildMintCalldata(mintFn, qty, mainSigner.address) || selector;
      } else {
        // Re-encode qty into last word of selector if it's a known qty selector
        const QTY_SIGS = ["0xa0712d68", "0x379607f5", "0x3b4c4b25", "0x61a503b0", "0xefef39a1"];
        if (QTY_SIGS.includes(selector)) {
          calldata = selector + qty.toString(16).padStart(64, "0");
        } else {
          calldata = selector; // raw selector, use as-is
        }
      }
      result = await executeManualMint(contract, calldata, valueEth, group);
    }

    await ctx.reply(
      `✅ *Link Mint Complete!*\n\n` +
      `✅ Succeeded: ${result.succeeded}\n` +
      `❌ Failed: ${result.failed}\n` +
      `⏭️ Skipped (low balance): ${result.skipped}\n` +
      `📊 Total wallets: ${result.total}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(`❌ Mint failed: ${err.message}`);
  }
}

// ─── Inspect: paste link/CA → phase-aware mint options ───────────────────────

// id → { contract, abi, publicMintFn, allowlistMintFn, phases, qualified:Map<addr,proof>, ... }
const pendingInspect = new Map();

function inspectWallets() {
  // Dedicated /inspect mint pool (max 20), separate from the 100 copy-minter sub-wallets
  return listMintWallets();
}

bot.command("inspect", async (ctx) => {
  const input = (ctx.match?.trim() || "");
  if (!input) {
    return ctx.reply(
      `*🔍 Inspect & Mint*\n\n` +
      `Paste a contract address, Etherscan/OpenSea link, or a project's mint-site URL. ` +
      `I'll find the contract, detect the live phase (public vs allowlist), read the price, ` +
      `and — for allowlists — pull your merkle proof so you can mint the spots you earned.\n\n` +
      `Usage: \`/inspect <link-or-contract>\`\n\n` +
      `Tip: for allowlist mints, paste the *mint-site URL* (not just the CA) so I can find the proof.`,
      { parse_mode: "Markdown" }
    );
  }

  await ctx.reply(`🔍 Inspecting...\n\`${input}\``, { parse_mode: "Markdown" });

  let report;
  try {
    report = await inspectMint(input, provider, {
      etherscanApiKey: process.env.ETHERSCAN_API_KEY,
      openseaApiKey: process.env.OPENSEA_API_KEY,
    });
  } catch (err) {
    return ctx.reply(`❌ ${err.message}`);
  }

  // Pre-compute allowlist proofs for every wallet (if there's an allowlist + a source)
  const qualified = new Map();
  let proofVia = null;
  const hasAllowFn = !!report.allowlistMintFn;
  const hasSources = report.allowlistSources.apiPaths.length + report.allowlistSources.jsonPaths.length > 0;

  if (hasAllowFn && hasSources) {
    const cache = { lists: new Map() };
    await ctx.reply(`🔑 Allowlist detected — checking which of your ${inspectWallets().length} wallets qualify...`);
    for (const addr of inspectWallets()) {
      const got = await getAllowlistProof(addr, report.allowlistSources, cache);
      if (got) { qualified.set(addr.toLowerCase(), got.proof); proofVia = got.via; }
    }
  }

  const id = Math.random().toString(36).slice(2, 10);
  setTimeout(() => pendingInspect.delete(id), 15 * 60 * 1000);

  // Build the report card
  const phaseLine = (label, p) => {
    if (!p.exists) return `${label}: ❔ not detected`;
    const dot = p.active ? "🟢 LIVE" : "🔴 closed";
    const price = p.price === "0" ? "FREE" : `${p.price} ETH`;
    return `${label}: ${dot} · ${price}`;
  };

  let card =
    `🔗 *Inspection Complete*\n\n` +
    `Contract: \`${report.contract}\`\n` +
    `NFT: ${report.isNFT ? "✅" : "⚠️ not ERC721/1155"} · Verified: ${report.hasAbi ? "✅" : "❌"}\n` +
    `Source: ${report.kind}\n\n` +
    `*Phases*\n` +
    `${phaseLine("🌐 Public", report.phases.public)}\n` +
    `${phaseLine("🔑 Allowlist", report.phases.allowlist)}\n`;

  if (report.publicSig) card += `\nPublic fn: \`${report.publicSig}\``;
  if (report.allowlistSig) card += `\nAllowlist fn: \`${report.allowlistSig}\``;

  // SeaDrop on-chain schedule (Proof-style: exact price + open times, works pre-launch)
  const sd = report.seadrop;
  let snipeStart = null;        // public-phase snipe target
  let alSnipe = null;           // allowlist snipe payload { startTime, entries, feeRecipient, price }
  if (sd?.isSeadrop && sd.public) {
    const st = phaseStatus(sd.public.startTime, sd.public.endTime);
    const dot = st.state === "live" ? "🟢" : st.state === "ended" ? "⚫" : "🔵";
    const priceStr = sd.public.price === "0" ? "FREE" : `${sd.public.price} ETH`;
    card += `\n\n📅 *OpenSea Drop Schedule*\n` +
      `${dot} PUBLIC — ${priceStr} · ${st.label}`;
    if (sd.public.startTime) card += `\n   ⏰ ${fmtUTC(sd.public.startTime)}`;
    if (sd.public.maxPerWallet) card += ` · max ${sd.public.maxPerWallet}/wallet`;
    if (st.state !== "ended") snipeStart = sd.public.startTime;
  }

  // SeaDrop allowlist (mintAllowList) — resolve the merkle proof + mintParams for the pool wallets
  if (sd?.isSeadrop && sd.allowlist && inspectWallets().length > 0) {
    await ctx.reply(`🌳 Allowlist (merkle) detected — fetching the on-chain allowlist + your proofs...`);
    let res;
    try {
      res = await resolveSeadropAllowlistBatch(getAlchemy(), report.contract, inspectWallets());
    } catch (err) {
      res = { error: "exception", entries: {} };
    }
    const n = Object.keys(res.entries || {}).length;
    if (n > 0) {
      const mp = res.mintParams; // [price, maxPerWallet, start, end, ...]
      const alStart = Number(mp[2]);
      const alEnd = Number(mp[3]);
      const alPriceEth = ethers.formatEther(BigInt(mp[0]));
      const ast = phaseStatus(alStart, alEnd);
      const adot = ast.state === "live" ? "🟢" : ast.state === "ended" ? "⚫" : "⚪";
      card += `\n${adot} ALLOWLIST — ${alPriceEth === "0.0" ? "FREE" : `${alPriceEth} ETH`} · ${ast.label}`;
      if (alStart) card += `\n   ⏰ ${fmtUTC(alStart)} · ✅ ${n}/${inspectWallets().length} wallets qualify`;
      if (ast.state !== "ended") {
        alSnipe = { startTime: alStart, entries: res.entries, feeRecipient: OPENSEA_FEE_RECIPIENT, price: alPriceEth };
      }
    } else {
      const why = res.error === "encrypted" ? "OpenSea-encrypted (grab proof from OS UI)"
        : res.error === "not_on_list" ? "none of your wallets are on it"
        : res.error === "no_uri" ? "no public allowlist URI found"
        : "couldn't fetch the allowlist";
      card += `\n⚪ ALLOWLIST — merkle root set, but ${why}`;
    }
  } else if (sd?.allowlist) {
    card += `\n⚪ ALLOWLIST — merkle root set (add mint-pool wallets to check your proofs)`;
  }

  if (inspectWallets().length === 0) {
    card += `\n\n⚠️ *Mint pool is empty* — add wallets with /addmintwallet before you can fire.`;
  } else {
    card += `\n\n🎯 Mint pool: ${inspectWallets().length}/20 wallets`;
  }

  if (hasAllowFn) {
    if (qualified.size > 0) {
      card += `\n\n✅ *${qualified.size}/${inspectWallets().length} wallets on the allowlist* (proof via ${proofVia})`;
    } else if (hasSources) {
      card += `\n\n⚠️ Found an allowlist but *none of your wallets have a valid proof*.`;
    } else {
      card += `\n\n⚠️ Allowlist mint exists but I couldn't find a proof source. Paste the *mint-site URL* (not just the CA).`;
    }
  }

  // Stash everything the buttons need (incl. the snipe start times)
  pendingInspect.set(id, { ...report, qualified, qty: 1, snipeStart, alSnipe });

  // Buttons
  const kb = new InlineKeyboard();
  if (snipeStart) {
    kb.text("🚀 Snipe public open", `insp_snipe_${id}`).row();
  }
  if (alSnipe) {
    kb.text("🌳 Snipe allowlist open", `insp_alsnipe_${id}`).row();
  }
  if (report.publicMintFn) {
    kb.text("🌐 Public ×1", `insp_pub_${id}_1`).text("🌐 Public ×3", `insp_pub_${id}_3`).row();
  }
  if (hasAllowFn && qualified.size > 0) {
    kb.text("🔑 Allowlist ×1", `insp_al_${id}_1`).text("🔑 Allowlist ×max", `insp_al_${id}_0`).row();
  }
  kb.text("❌ Cancel", `insp_cancel_${id}`);

  await ctx.reply(card, { parse_mode: "Markdown", reply_markup: kb });
});

bot.callbackQuery(/^insp_cancel_(.+)$/, async (ctx) => {
  pendingInspect.delete(ctx.match[1]);
  await ctx.answerCallbackQuery("Cancelled.");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });
});

// Mint the moment it opens — arm a SeaDrop snipe at the public-phase start time
bot.callbackQuery(/^insp_snipe_(.+)$/, async (ctx) => {
  const job = pendingInspect.get(ctx.match[1]);
  if (!job) return ctx.answerCallbackQuery("❌ Expired — run /inspect again.");
  if (!job.snipeStart) return ctx.answerCallbackQuery("❌ No open time to snipe.");
  if (inspectWallets().length === 0) return ctx.answerCallbackQuery("❌ Mint pool empty — /addmintwallet first.");
  await ctx.answerCallbackQuery("Arming snipe...");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });

  try {
    const snipe = await scheduleSnipe({
      nftContract: job.contract,
      qty: 1,
      startTime: job.snipeStart,
      label: job.contract.slice(0, 10),
    });
    const now = Math.floor(Date.now() / 1000);
    const when = snipe.startTime > now ? `in ${humanDuration(snipe.startTime - now)} (${fmtUTC(snipe.startTime)})` : "now";
    await ctx.reply(
      `🎯 *Snipe armed!*\n\n` +
      `Contract: \`${job.contract}\`\n` +
      `Fires: ${when}\n` +
      `From: ${inspectWallets().length} mint-pool wallets\n\n` +
      `I'll poll fast near the open and fire the instant it's live. View with /snipes.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(`❌ Couldn't arm snipe: ${err.message}`);
  }
});

// Snipe the allowlist (mintAllowList) open — fires per-wallet with each wallet's proof
bot.callbackQuery(/^insp_alsnipe_(.+)$/, async (ctx) => {
  const job = pendingInspect.get(ctx.match[1]);
  if (!job) return ctx.answerCallbackQuery("❌ Expired — run /inspect again.");
  if (!job.alSnipe) return ctx.answerCallbackQuery("❌ No allowlist to snipe.");
  await ctx.answerCallbackQuery("Arming allowlist snipe...");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });

  try {
    const snipe = await scheduleSnipe({
      nftContract: job.contract,
      qty: 1,
      startTime: job.alSnipe.startTime,
      label: `${job.contract.slice(0, 8)} AL`,
      mode: "allowlist",
      feeRecipient: job.alSnipe.feeRecipient,
      entries: job.alSnipe.entries,
    });
    const now = Math.floor(Date.now() / 1000);
    const when = snipe.startTime > now ? `in ${humanDuration(snipe.startTime - now)} (${fmtUTC(snipe.startTime)})` : "now";
    const qn = Object.keys(job.alSnipe.entries).length;
    await ctx.reply(
      `🌳 *Allowlist snipe armed!*\n\n` +
      `Contract: \`${job.contract}\`\n` +
      `Fires: ${when}\n` +
      `Qualifying wallets: ${qn}\n` +
      `Price: ${job.alSnipe.price} ETH\n\n` +
      `Each wallet fires with its own merkle proof the instant the allowlist opens. /snipes to view.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(`❌ Couldn't arm allowlist snipe: ${err.message}`);
  }
});

// Public mint: insp_pub_<id>_<qty>
bot.callbackQuery(/^insp_pub_([^_]+)_(\d+)$/, async (ctx) => {
  const job = pendingInspect.get(ctx.match[1]);
  if (!job) return ctx.answerCallbackQuery("❌ Expired — run /inspect again.");
  const qty = Math.max(1, parseInt(ctx.match[2]));
  await ctx.answerCallbackQuery("Firing public mint...");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });

  const calldata = buildMintCalldata(job.publicMintFn, qty, MAIN_ADDRESS);
  if (!calldata) return ctx.reply("❌ Couldn't encode the public mint calldata for this contract.");

  const price = job.phases.public.price;
  const valueEth = price === "0" ? "0" : (parseFloat(price) * qty).toFixed(6);

  await ctx.reply(
    `⚡ *Public Mint Firing*\n\nContract: \`${job.contract}\`\n` +
    `Fn: \`${job.publicSig}\` · Qty: ${qty}\n` +
    `Price: ${price === "0" ? "FREE" : `${valueEth} ETH total/wallet`}`,
    { parse_mode: "Markdown" }
  );
  try {
    const r = await executeManualMint(job.contract, calldata, valueEth, null, await inspectFireOpts(getMintSigners(provider)));
    await ctx.reply(`✅ Done — ✅ ${r.succeeded} · ❌ ${r.failed} · ⏭️ ${r.skipped} · 📊 ${r.total}`);
  } catch (err) {
    await ctx.reply(`❌ Mint failed: ${err.message}`);
  }
});

// Allowlist mint: insp_al_<id>_<qty>  (qty 0 = max → use 1 here, contracts cap anyway)
bot.callbackQuery(/^insp_al_([^_]+)_(\d+)$/, async (ctx) => {
  const job = pendingInspect.get(ctx.match[1]);
  if (!job) return ctx.answerCallbackQuery("❌ Expired — run /inspect again.");
  if (job.qualified.size === 0) return ctx.answerCallbackQuery("❌ No qualifying wallets.");
  const qty = Math.max(1, parseInt(ctx.match[2]) || 1);
  await ctx.answerCallbackQuery("Firing allowlist mint...");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });

  const price = job.phases.allowlist.price;
  const valueEth = price === "0" ? "0" : (parseFloat(price) * qty).toFixed(6);

  // Per-wallet calldata: inject each wallet's own proof; non-qualifying wallets return null (skipped)
  const calldataFn = (address) => {
    const proof = job.qualified.get(address.toLowerCase());
    if (!proof) return null;
    return buildAllowlistCalldata(job.allowlistMintFn, qty, address, proof);
  };

  await ctx.reply(
    `🔑 *Allowlist Mint Firing*\n\nContract: \`${job.contract}\`\n` +
    `Fn: \`${job.allowlistSig}\` · Qty: ${qty}\n` +
    `Qualifying wallets: ${job.qualified.size}\n` +
    `Price: ${price === "0" ? "FREE" : `${valueEth} ETH total/wallet`}`,
    { parse_mode: "Markdown" }
  );
  try {
    const r = await executePerWalletMint(job.contract, calldataFn, valueEth, null, await inspectFireOpts(getMintSigners(provider)));
    await ctx.reply(`✅ Done — ✅ ${r.succeeded} · ❌ ${r.failed} · ⏭️ ${r.skipped} · 📊 ${r.total}`);
  } catch (err) {
    await ctx.reply(`❌ Allowlist mint failed: ${err.message}`);
  }
});

// ─── Mint Pool Wallets (dedicated /inspect pool, max 20) ─────────────────────

// chatId → true while waiting for a pasted private key
const pendingMintWalletPk = new Set();

bot.command("mintwallets", async (ctx) => {
  const addrs = listMintWallets();
  if (addrs.length === 0) {
    return ctx.reply(
      `*🎯 Mint Pool — empty*\n\n` +
      `These are the wallets \`/inspect\` mints from (separate from your 100 copy-minter wallets).\n\n` +
      `Add one with /addmintwallet — max 20.`,
      { parse_mode: "Markdown" }
    );
  }
  const list = addrs.map((a, i) => `${i + 1}. \`${a}\``).join("\n");
  await ctx.reply(
    `*🎯 Mint Pool (${addrs.length}/20)*\n\n${list}\n\n` +
    `Add: /addmintwallet · Remove: /removemintwallet <address>`,
    { parse_mode: "Markdown" }
  );
});

bot.command("addmintwallet", async (ctx) => {
  if (listMintWallets().length >= 20) {
    return ctx.reply("❌ Mint pool is full (20/20). Remove one first with /removemintwallet.");
  }
  const arg = ctx.match?.trim();
  // Allow inline: /addmintwallet 0xPRIVATEKEY (will be deleted immediately)
  if (arg && /^0x[0-9a-fA-F]{64}$/.test(arg)) {
    return _addMintWalletFromPk(ctx, arg);
  }
  pendingMintWalletPk.add(ctx.chat.id);
  await ctx.reply(
    `🔑 *Add Mint Wallet*\n\n` +
    `Paste the *private key* of the wallet you want to mint from.\n\n` +
    `⚠️ I'll store it encrypted and *delete your message* right away so the key doesn't sit in this chat. ` +
    `Send /cancel to abort.`,
    { parse_mode: "Markdown" }
  );
});

async function _addMintWalletFromPk(ctx, pk) {
  // Wipe the message holding the raw key ASAP
  try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch {}
  pendingMintWalletPk.delete(ctx.chat.id);
  try {
    const address = await addMintWallet(pk);
    await ctx.reply(
      `✅ *Mint wallet added*\n\n\`${address}\`\n\nPool: ${listMintWallets().length}/20`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  }
}

bot.command("removemintwallet", async (ctx) => {
  const addr = ctx.match?.trim();
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return ctx.reply("Usage: `/removemintwallet 0xAddress`", { parse_mode: "Markdown" });
  }
  await removeMintWallet(addr);
  await ctx.reply(`🗑 Removed \`${addr}\` from the mint pool. Now ${listMintWallets().length}/20.`, { parse_mode: "Markdown" });
});

// ─── /mint — friendly entry point ────────────────────────────────────────────

bot.command("mint", async (ctx) => {
  await ctx.reply(
    `🏗 *Mint*\n\n` +
    `Just paste an *OpenSea link* or *contract address* and I'll figure it out — read the drop, ` +
    `detect public vs allowlist, pull the schedule, and let you fire or snipe.\n\n` +
    `• *OpenSea / SeaDrop drop* — I read the on-chain schedule (price + exact open time) and can ` +
    `🚀 *mint the moment it opens*.\n` +
    `• *Custom contract or mint site* — paste the URL; I deep-read it for the contract + merkle proof.\n` +
    `• *Allowlist* — paste the mint-site URL so I can find your proof.\n\n` +
    `➡️ Send: \`/inspect <link-or-contract>\`\n` +
    `🎯 Mint pool: ${listMintWallets().length}/20 · /mintwallets to manage · /snipes for armed snipes`,
    { parse_mode: "Markdown" }
  );
});

bot.command("snipes", async (ctx) => {
  const snipes = listSnipes();
  if (snipes.length === 0) {
    return ctx.reply("🎯 No armed snipes. Run /inspect on an upcoming OpenSea drop and tap *Mint the moment it opens*.", { parse_mode: "Markdown" });
  }
  const now = Math.floor(Date.now() / 1000);
  const lines = snipes.map((s) => {
    const when = s.startTime > now ? `opens in ${humanDuration(s.startTime - now)}` : "live window";
    return `• \`${s.nftContract}\`\n   ${s.status} · ${when} · ${fmtUTC(s.startTime)}\n   cancel: /cancelsnipe ${s.id}`;
  }).join("\n");
  await ctx.reply(`🎯 *Armed Snipes (${snipes.length})*\n\n${lines}`, { parse_mode: "Markdown" });
});

bot.command("cancelsnipe", async (ctx) => {
  const id = ctx.match?.trim();
  if (!id) return ctx.reply("Usage: `/cancelsnipe <id>` (see /snipes)", { parse_mode: "Markdown" });
  await cancelSnipe(id);
  await ctx.reply(`🛑 Snipe \`${id}\` cancelled.`, { parse_mode: "Markdown" });
});

// ─── Execution speed: gas tier + private mempool ─────────────────────────────

bot.command("gas", async (ctx) => {
  const arg = (ctx.match?.trim() || "").toLowerCase();
  const s = getSettings();

  if (arg.startsWith("ceiling")) {
    const n = parseInt(arg.split(/\s+/)[1], 10);
    if (isNaN(n) || n < 10) return ctx.reply("Usage: `/gas ceiling 150` (gwei, min 10)", { parse_mode: "Markdown" });
    await updateSettings({ gasCeilingGwei: n });
    return ctx.reply(`🧢 Gas ceiling set to *${n} gwei*.`, { parse_mode: "Markdown" });
  }
  if (["normal", "fast", "war"].includes(arg)) {
    await updateSettings({ gasTier: arg });
    return ctx.reply(`${GAS_TIERS[arg].emoji} Default gas tier set to *${arg}* for /inspect fires. (Snipes always use 🔥 war.)`, { parse_mode: "Markdown" });
  }

  // Show current state + live base fee
  let baseStr = "?";
  try {
    const g = await computeGas(provider, "normal", s.gasCeilingGwei || 200);
    baseStr = gweiOf(g.baseFee);
  } catch {}
  const tier = s.gasTier || "fast";
  await ctx.reply(
    `⛽ *Gas Settings*\n\n` +
    `Live base fee: ~${baseStr} gwei\n` +
    `Default tier (/inspect): ${GAS_TIERS[tier].emoji} *${tier}* (tip ${GAS_TIERS[tier].tipGwei} gwei)\n` +
    `Snipe tier: 🔥 *war* (tip ${GAS_TIERS.war.tipGwei} gwei) — always\n` +
    `Ceiling: 🧢 ${s.gasCeilingGwei || 200} gwei\n` +
    `Private send: ${s.privateSnipe ? "🛡 ON (Flashbots)" : "🌐 OFF (public mempool)"}\n\n` +
    `Set: \`/gas war\` · \`/gas fast\` · \`/gas normal\` · \`/gas ceiling 150\`\n` +
    `Toggle private: /privatesnipe`,
    { parse_mode: "Markdown" }
  );
});

bot.command("privatesnipe", async (ctx) => {
  const s = getSettings();
  const next = !s.privateSnipe;
  await updateSettings({ privateSnipe: next });
  await ctx.reply(
    next
      ? `🛡 *Private send ON.* Fires route through Flashbots Protect — no gas on failed mints, front-run resistant. ` +
        `Trade-off: may land a block or two later than an aggressive public tx.`
      : `🌐 *Private send OFF.* Fires go to the public mempool (faster inclusion, but you pay gas on failures and can be front-run).`,
    { parse_mode: "Markdown" }
  );
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
            `🔍 *Mint Functions — \`${contract}\`*\n\n${lines}\n\n` +
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
      `❌ Couldn't identify mint functions on \`${contract}\`\n\n` +
      `Try checking Etherscan manually for the Input Data on a recent tx.\n\n` +
      `Add ETHERSCAN_API_KEY to Railway env for verified contract support.`,
      { parse_mode: "Markdown" }
    );
  }

  const lines = hits.map(h => `\`${h.selector}\` — *${h.sig}* ${h.status}`).join("\n");
  await ctx.reply(
    `🔍 *Selector Probe — \`${contract}\`*\n\n${lines}\n\n` +
    `Use: \`/mint ${contract} [group] <selector> [value]\``,
    { parse_mode: "Markdown" }
  );
});

// ─── Sniff & Mint ─────────────────────────────────────────────────────────────

bot.command("sniff", async (ctx) => {
  const parts = (ctx.match?.trim() || "").split(/\s+/);
  const contract = parts[0];
  const group = parts[1] && !/^\d*\.?\d+$/.test(parts[1]) ? parts[1] : null;
  const value = parts[group ? 2 : 1] || "0";

  if (!contract || !isValidAddress(contract)) {
    return ctx.reply(
      `*Sniff & Mint*\n\n` +
      `Grabs calldata from the most recent successful mint tx on a contract, then fires on your wallets immediately.\n\n` +
      `Usage: \`/sniff <contract> [group] [value_eth]\`\n\n` +
      `Examples:\n` +
      `\`/sniff 0xContract\` — sniff + mint all wallets\n` +
      `\`/sniff 0xContract karlkestis\` — sniff + mint group\n` +
      `\`/sniff 0xContract karlkestis 0.05\` — with ETH value`,
      { parse_mode: "Markdown" }
    );
  }

  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return ctx.reply("❌ ETHERSCAN_API_KEY not set.");

  await ctx.reply(`🔍 Sniffing recent txs on \`${shortAddr(contract)}\`...`, { parse_mode: "Markdown" });

  try {
    const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${contract}&sort=desc&page=1&offset=50&apikey=${apiKey}`;
    const res = await fetch(url);
    const json = await res.json();

    if (json.status !== "1" || !Array.isArray(json.result)) {
      return ctx.reply("❌ Etherscan returned no transactions. Contract may be too new or address is wrong.");
    }

    const successfulMints = json.result.filter(tx =>
      tx.to?.toLowerCase() === contract.toLowerCase() &&
      tx.isError === "0" &&
      tx.input?.length > 10 &&
      tx.input !== "0x"
    );

    if (!successfulMints.length) {
      return ctx.reply("❌ No successful txs found yet. Either no one has minted or the mint hasn't started.");
    }

    const best = successfulMints[0];
    const calldata = best.input;
    const selector = calldata.slice(0, 10);
    const target = group ? `group *${group}*` : "all sub-wallets";

    await ctx.reply(
      `✅ *Calldata sniffed!*\n\n` +
      `Selector: \`${selector}\`\n` +
      `From tx: \`${best.hash.slice(0, 18)}...\`\n` +
      `Wallets: ${target}\n` +
      `Value: ${value} ETH each\n\n` +
      `⚡ Firing mint...`,
      { parse_mode: "Markdown" }
    );

    const { succeeded, failed, skipped, total } = await executeManualMint(contract, calldata, value, group || null);
    await ctx.reply(
      `✅ *Sniff & Mint Complete!*\n\n` +
      `✅ Succeeded: ${succeeded}\n` +
      `❌ Failed: ${failed}\n` +
      `⏭️ Skipped (low balance): ${skipped}\n` +
      `📊 Total wallets: ${total}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(`❌ Sniff failed: ${err.message}`);
  }
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
    return `${status} | \`${w.nftContract}\` | ${target} | ${date}\nID: \`${w.id.slice(0, 8)}\``;
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
    const blockNum = await provider.getBlockNumber();
    startBlock = "0x" + blockNum.toString(16);
  } catch (_) { /* fall back to "latest" */ }

  const id = uuidv4();
  await addSweepWatcher({
    id,
    wallet: addr,
    name: name || addr,
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

// ─── Top-Up Calculator ────────────────────────────────────────────────────────

bot.command("topup", async (ctx) => {
  const raw = ctx.match?.trim() || "";
  const parts = raw.split(/\s+/);

  // Parse: /topup [usd] [group] — either order, group is non-numeric
  let targetUsd = 0.3;
  let groupName = null;
  for (const part of parts) {
    const num = parseFloat(part.replace(/[^\d.]/g, ""));
    if (!isNaN(num) && num > 0) targetUsd = num;
    else if (part.length > 0) groupName = part.toLowerCase();
  }

  // Resolve wallets — group or all
  let walletAddresses;
  let scopeLabel;
  if (groupName) {
    const groupWallets = getGroupWallets(groupName);
    if (!groupWallets || groupWallets.length === 0) {
      return ctx.reply(`❌ Group *${groupName}* not found or empty.`, { parse_mode: "Markdown" });
    }
    walletAddresses = groupWallets.map(w => w.address);
    scopeLabel = `group *${groupName}*`;
  } else {
    walletAddresses = listWallets();
    scopeLabel = "all wallets";
  }

  if (walletAddresses.length === 0) return ctx.reply("No sub-wallets configured.");

  await ctx.reply(`🔍 Fetching balances + ETH price for ${scopeLabel}...`, { parse_mode: "Markdown" });

  let ethPrice = 2000;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const d = await r.json();
    ethPrice = d.ethereum.usd ?? 2000;
  } catch { /* use fallback */ }

  const targetEth = targetUsd / ethPrice;

  // Batch balance fetches 10 at a time to avoid rate limits
  const results = [];
  for (let i = 0; i < walletAddresses.length; i += 10) {
    const batch = walletAddresses.slice(i, i + 10);
    const batchResults = await Promise.all(
      batch.map(async (addr, j) => {
        try {
          const bal = await provider.getBalance(addr);
          const eth = parseFloat(ethers.formatEther(bal));
          return { index: i + j + 1, address: addr, eth };
        } catch {
          return { index: i + j + 1, address: addr, eth: 0 };
        }
      })
    );
    results.push(...batchResults);
  }

  const needsTopup = results.filter(w => w.eth < targetEth);
  const alreadyFunded = results.length - needsTopup.length;

  if (needsTopup.length === 0) {
    return ctx.reply(
      `✅ All ${results.length} wallets in ${scopeLabel} already have ≥ $${targetUsd} (${targetEth.toFixed(6)} ETH @ $${ethPrice.toFixed(0)})\n\nNothing to do.`,
      { parse_mode: "Markdown" }
    );
  }

  const totalNeededEth = needsTopup.reduce((sum, w) => sum + Math.max(0, targetEth - w.eth), 0);
  const totalNeededUsd = totalNeededEth * ethPrice;
  const distributeCmd = groupName
    ? `/distribute ${totalNeededEth.toFixed(6)} ${groupName}`
    : `/distribute ${totalNeededEth.toFixed(6)}`;

  // Build list — split into chunks if too long
  const lines = needsTopup.map(w => {
    const currentUsd = (w.eth * ethPrice).toFixed(3);
    const neededEth = Math.max(0, targetEth - w.eth);
    const neededUsd = (neededEth * ethPrice).toFixed(3);
    return `#${w.index} \`${w.address}\` — $${currentUsd} → need +$${neededUsd} (+${neededEth.toFixed(6)} ETH)`;
  });

  const CHUNK = 30;
  for (let i = 0; i < lines.length; i += CHUNK) {
    const chunk = lines.slice(i, i + CHUNK);
    const isLast = i + CHUNK >= lines.length;
    const footer = isLast
      ? `\n\n📊 *Summary*\n` +
        `• ETH price: $${ethPrice.toFixed(0)}\n` +
        `• Target per wallet: $${targetUsd} (${targetEth.toFixed(6)} ETH)\n` +
        `• Scope: ${scopeLabel}\n` +
        `• Wallets needing top-up: ${needsTopup.length}/${results.length}\n` +
        `• Already funded: ${alreadyFunded}\n` +
        `• Total ETH needed: ${totalNeededEth.toFixed(6)} ETH (~$${totalNeededUsd.toFixed(2)})\n\n` +
        `_Run \`${distributeCmd}\` to fund all at once_`
      : "";
    await ctx.reply(`💰 *Top-Up to $${targetUsd}* (${scopeLabel}${i > 0 ? " cont." : ""})\n\n${chunk.join("\n")}${footer}`, { parse_mode: "Markdown" });
  }
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

// ─── Volume Tracker ───────────────────────────────────────────────────────────

async function fetchVolumeStats(contracts) {
  const BATCH = 20;
  const results = {};

  for (let i = 0; i < contracts.length; i += BATCH) {
    const chunk = contracts.slice(i, i + BATCH);
    const params = chunk.map(c => `contract=${c}`).join("&");
    try {
      const res = await fetch(
        `https://api.reservoir.tools/collections/v7?${params}&limit=${BATCH}`,
        { headers: { accept: "application/json" } }
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const col of data?.collections || []) {
        const ca = (col.primaryContract || col.id || "").toLowerCase();
        if (!ca) continue;
        results[ca] = {
          name: col.name || ca,
          volume24h: Number(col.volume?.["1day"] ?? 0),
          volume7d: Number(col.volume?.["7day"] ?? 0),
          sales24h: Number(col.salesCount?.["1day"] ?? 0),
          floor: col.floorAsk?.price?.amount?.native ?? null,
        };
      }
    } catch (e) {
      console.error(`[Volume] Reservoir error: ${e.message}`);
    }
  }

  return results;
}

bot.command("volume", async (ctx) => {
  const arg = ctx.match?.trim()?.toLowerCase();
  const sortBy7d = arg === "7d";

  const log = getMintLog();
  if (log.length === 0) {
    return ctx.reply("No mints recorded yet.");
  }

  const uniqueContracts = [...new Set(log.map(e => e.contract?.toLowerCase()).filter(Boolean))];
  if (uniqueContracts.length === 0) {
    return ctx.reply("No contracts in mint log.");
  }

  await ctx.reply(`📈 Fetching volume data for ${uniqueContracts.length} contract(s)...`);

  const stats = await fetchVolumeStats(uniqueContracts);

  const enriched = uniqueContracts
    .map(ca => ({ ca, ...(stats[ca] || { name: ca, volume24h: 0, volume7d: 0, sales24h: 0, floor: null }) }))
    .sort((a, b) => sortBy7d ? b.volume7d - a.volume7d : b.volume24h - a.volume24h)
    .slice(0, 10);

  const lines = enriched.map((col, idx) => {
    const floor = col.floor != null ? `${Number(col.floor).toFixed(4)} ETH` : "—";
    const vol24 = col.volume24h > 0 ? `${col.volume24h.toFixed(2)} ETH` : "—";
    const vol7 = col.volume7d > 0 ? `${col.volume7d.toFixed(2)} ETH` : "—";
    return (
      `*#${idx + 1} ${col.name}*\n` +
      `\`${col.ca}\`\n` +
      `24h Vol: ${vol24} | 24h Sales: ${col.sales24h}\n` +
      `7d Vol: ${vol7} | Floor: ${floor}`
    );
  });

  const sortLabel = sortBy7d ? "7-day" : "24h";
  await ctx.reply(
    `📈 *Volume Tracker* — ${uniqueContracts.length} contract(s) minted\n` +
    `_Sorted by ${sortLabel} volume — showing top ${enriched.length}_\n\n` +
    lines.join("\n\n─────────────────\n\n"),
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

// ─── OpenSea Mass Listing ─────────────────────────────────────────────────────

// /checkca <contract> — scan which wallets hold the NFT + fetch floor price
bot.command("checkca", async (ctx) => {
  const ca = ctx.match?.trim();
  if (!isValidAddress(ca)) {
    return ctx.reply("Usage: /checkca <contract_address>");
  }
  if (!process.env.OPENSEA_API_KEY) {
    return ctx.reply("❌ OPENSEA_API_KEY not set. Add it to Railway env vars.");
  }

  const scanning = await ctx.reply("🔍 Scanning wallets and fetching floor price...");

  try {
    const { collectionName, floorPrice, holdingWallets } = await getContractInfo(ca, provider, process.env.OPENSEA_API_KEY);

    const name  = collectionName || "Unknown Collection";
    const floor = floorPrice != null ? `${floorPrice} ETH` : "N/A";
    const total = listWallets().length;

    let walletLines = "";
    if (holdingWallets.length === 0) {
      walletLines = "_None of your wallets hold this NFT_";
    } else {
      walletLines = holdingWallets
        .map((w) => `• \`${shortAddr(w.address)}\` — ${w.count} NFT${w.count > 1 ? "s" : ""}`)
        .join("\n");
    }

    await ctx.api.editMessageText(
      scanning.chat.id,
      scanning.message_id,
      `📦 *${name}*\n` +
      `\`${ca}\`\n\n` +
      `Floor Price: *${floor}*\n` +
      `Wallets with NFT: *${holdingWallets.length}* / ${total}\n\n` +
      `${walletLines}\n\n` +
      (holdingWallets.length > 0
        ? `To list: \`/list <range|group> ${ca} <price_eth>\`\nExample: \`/list 1-${Math.min(holdingWallets.length, 5)} ${ca} ${floorPrice ?? "0.05"}\``
        : "_No wallets to list from._"),
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.api.editMessageText(
      scanning.chat.id,
      scanning.message_id,
      `❌ Error: ${err.message}`
    );
  }
});

// /list <range|group> <contract> <price_eth>       — range OR group
// /list <range> <group> <contract> <price_eth>     — range within a group
bot.command("list", async (ctx) => {
  const args = ctx.match?.trim().split(/\s+/);
  if (!args || args.length < 3) {
    return ctx.reply(
      "Usage:\n" +
      "`/list 1-5 0xabc...123 0.05` — wallets 1–5\n" +
      "`/list karlkestis 0xabc...123 0.05` — whole group\n" +
      "`/list 5-10 karlkestis 0xabc...123 0.05` — range within group",
      { parse_mode: "Markdown" }
    );
  }

  // Detect 4-arg form: <range> <group> <contract> <price>
  let rangeArg, groupArg, ca, priceStr;
  const rangeMatch4 = args[0].match(/^(\d+)-(\d+)$/);
  if (args.length >= 4 && rangeMatch4 && !isValidAddress(args[1])) {
    [rangeArg, groupArg, ca, priceStr] = args;
  } else {
    [rangeArg, ca, priceStr] = args; // 3-arg form — rangeArg is range or group
  }

  const priceEth = parseFloat((priceStr ?? "").replace(/[^\d.]/g, ""));

  if (!isValidAddress(ca)) {
    return ctx.reply("❌ Invalid contract address.");
  }
  if (isNaN(priceEth) || priceEth <= 0) {
    return ctx.reply("❌ Invalid price. Use ETH (e.g. 0.05).");
  }
  if (!process.env.OPENSEA_API_KEY) {
    return ctx.reply("❌ OPENSEA_API_KEY not set. Add it to Railway env vars.");
  }

  const allWallets = getSubWallets();
  let walletPool;
  let selectorLabel;

  if (groupArg) {
    // 4-arg: range within a specific group
    const groupWallets = getGroupWallets(groupArg);
    if (!groupWallets || groupWallets.length === 0) {
      return ctx.reply(`❌ No group named "${groupArg}".`);
    }
    const from = parseInt(rangeMatch4[1], 10);
    const to   = parseInt(rangeMatch4[2], 10);
    if (from < 1 || to < from || to > groupWallets.length) {
      return ctx.reply(`❌ Range ${rangeArg} is out of bounds for group "${groupArg}" (${groupWallets.length} wallets).`);
    }
    walletPool    = groupWallets.slice(from - 1, to);
    selectorLabel = `${groupArg} wallets ${from}–${to}`;
  } else {
    const rm = rangeArg.match(/^(\d+)-(\d+)$/);
    if (rm) {
      // 3-arg range form
      const from = parseInt(rm[1], 10);
      const to   = parseInt(rm[2], 10);
      if (from < 1 || to < from || to > allWallets.length) {
        return ctx.reply(`❌ Range ${rangeArg} is out of bounds (you have ${allWallets.length} wallets).`);
      }
      walletPool    = allWallets.slice(from - 1, to);
      selectorLabel = `wallets ${from}–${to}`;
    } else {
      // 3-arg group form
      const groupWallets = getGroupWallets(rangeArg);
      if (!groupWallets || groupWallets.length === 0) {
        return ctx.reply(`❌ No group named "${rangeArg}". Use a range like \`1-5\` or a group name.`);
      }
      walletPool    = groupWallets;
      selectorLabel = `group "${rangeArg}"`;
    }
  }

  const working = await ctx.reply(
    `⏳ Listing NFTs from *${selectorLabel}* (${walletPool.length} wallet(s)) at *${priceEth} ETH* each…\n_(approvals + signing may take a moment)_`,
    { parse_mode: "Markdown" }
  );

  try {
    const results = await massListNFTs(ca, walletPool, priceEth, provider, process.env.OPENSEA_API_KEY);

    const listed = results.filter((r) => r.status === "listed");
    const failed = results.filter((r) => r.status === "failed");
    const errOnly = results.filter((r) => r.status === "error");

    if (errOnly.length > 0) {
      return ctx.api.editMessageText(
        working.chat.id, working.message_id,
        `❌ ${errOnly[0].error}`
      );
    }

    let msg =
      `📋 *OpenSea Listing Results*\n\n` +
      `✅ Listed: *${listed.length}*   ❌ Failed: *${failed.length}*\n\n`;

    for (const r of results) {
      if (r.status === "listed") {
        msg += `✅ \`${shortAddr(r.address)}\` — Token #${r.tokenId} @ ${r.priceEth} ETH\n`;
      } else {
        const safeErr = (r.error ?? "unknown error").replace(/[_*`[\]()~>#+=|{}.!-]/g, " ").slice(0, 80);
        msg += `❌ \`${shortAddr(r.address ?? "unknown")}\` — ${safeErr}\n`;
      }
    }

    if (listed.length > 0) {
      msg += `\n[View on OpenSea](https://opensea.io/assets/ethereum/${ca})`;
    }

    await ctx.api.editMessageText(
      working.chat.id, working.message_id,
      msg,
      { parse_mode: "Markdown", disable_web_page_preview: true }
    );
  } catch (err) {
    await ctx.api.editMessageText(
      working.chat.id, working.message_id,
      `❌ ${err.message}`
    );
  }
});

// ─── DAEMON Sniper ────────────────────────────────────────────────────────────

// /daemonadd <address> — register a wallet for the snipe
bot.command("daemonadd", async (ctx) => {
  const address = ctx.match?.trim();
  if (!address || !isValidAddress(address)) {
    return ctx.reply("Usage: `/daemonadd 0xAddress`\n\nThe wallet must already be added to the bot as a sub-wallet.", { parse_mode: "Markdown" });
  }
  addSnipeWallet(address);
  const all = getSnipeWalletAddresses();
  await ctx.reply(
    `✅ Added \`${address}\` to DAEMON snipe list.\n\nTotal registered: *${all.length}*\n\nUse /daemonlist to view all.`,
    { parse_mode: "Markdown" }
  );
});

// /daemonremove <address> — remove a wallet from the snipe list
bot.command("daemonremove", async (ctx) => {
  const address = ctx.match?.trim();
  if (!address || !isValidAddress(address)) {
    return ctx.reply("Usage: `/daemonremove 0xAddress`", { parse_mode: "Markdown" });
  }
  removeSnipeWallet(address);
  await ctx.reply(`🗑 Removed \`${address}\` from snipe list.`, { parse_mode: "Markdown" });
});

// /daemonclear — wipe the whole snipe wallet list
bot.command("daemonclear", async (ctx) => {
  clearSnipeWallets();
  await ctx.reply("🗑 Snipe wallet list cleared.");
});

// /daemonlist — show registered wallets with balances
bot.command("daemonlist", async (ctx) => {
  const addrs = getSnipeWalletAddresses();
  if (addrs.length === 0) {
    return ctx.reply("No wallets registered yet.\n\nUse `/daemonadd 0xAddress` to add one.", { parse_mode: "Markdown" });
  }

  await ctx.reply(`🔍 Fetching balances for ${addrs.length} wallet(s)...`);

  const balances = await Promise.all(
    addrs.map(async (addr) => {
      try {
        const bal = await provider.getBalance(addr);
        const eth = parseFloat(ethers.formatEther(bal));
        const spend = eth * 0.5;
        return { addr, eth, spend };
      } catch {
        return { addr, eth: 0, spend: 0 };
      }
    })
  );

  const totalSpend = balances.reduce((s, w) => s + w.spend, 0);
  const lines = balances.map((w, i) =>
    `${i + 1}. \`${w.addr}\`\n    Balance: ${w.eth.toFixed(4)} ETH → will spend: *${w.spend.toFixed(4)} ETH* (50%)`
  );

  await ctx.reply(
    `💼 *DAEMON Snipe Wallets (${addrs.length})*\n\n` +
    lines.join("\n\n") + "\n\n" +
    `─────────────────\n` +
    `Total to spend at launch: *~${totalSpend.toFixed(4)} ETH*`,
    { parse_mode: "Markdown" }
  );
});

// /daemonsnipe <CA> — dry run then execute
bot.command("daemonsnipe", async (ctx) => {
  const tokenCA = ctx.match?.trim();

  if (!tokenCA || !isValidAddress(tokenCA)) {
    return ctx.reply(
      `*DAEMON Sniper*\n\n` +
      `Runs a dry run first \\(shows tax, slippage, per\\-wallet expected amounts\\), then buys 50% of each registered wallet's balance and wraps artifacts as ERC721\\.\n\n` +
      `Setup:\n` +
      `1\\. \`/daemonadd 0xAddress\` — register participating wallets\n` +
      `2\\. \`/daemonlist\` — verify balances\n` +
      `3\\. \`/daemonsnipe <CA>\` — fire when CA drops\n\n` +
      `\`/daemonclear\` to reset the wallet list\\.`,
      { parse_mode: "MarkdownV2" }
    );
  }

  const registered = getSnipeWalletAddresses();
  if (registered.length === 0) {
    return ctx.reply(
      `❌ No wallets registered.\n\nAdd wallets first:\n\`/daemonadd 0xAddress\``,
      { parse_mode: "Markdown" }
    );
  }

  runDaemonSnipe({ tokenCA, notify }).catch(err => {
    notify(`❌ *Snipe Error*\n\n${err.message}`);
  });

  await ctx.reply(
    `🎯 *DAEMON Snipe triggered!*\n\n` +
    `CA: \`${tokenCA}\`\n` +
    `Wallets: ${registered.length}\n` +
    `Spend: *50%* of each wallet's balance\n\n` +
    `_Dry run first → then buying → then wrapping..._`,
    { parse_mode: "Markdown" }
  );
});

bot.command("daemonwrap", async (ctx) => {
  const args = (ctx.match?.trim() || "").split(/\s+/).filter(Boolean);

  if (args.length === 0 || !isValidAddress(args[0])) {
    return ctx.reply(
      `*DAEMON Wrap*\n\n` +
      `Wraps artifacts as ERC721 on all wallets\\.\n\n` +
      `Usage:\n` +
      `\`/daemonwrap <CA>\` — auto\\-detect wrap fn\n` +
      `\`/daemonwrap <CA> 0xCALLDATA\` — provide selector manually`,
      { parse_mode: "MarkdownV2" }
    );
  }

  const tokenCA = args[0];
  const calldataArg = args.find(a => /^0x[0-9a-fA-F]{8,}$/.test(a) && a !== tokenCA) || null;

  runDaemonWrap({ tokenCA, calldata: calldataArg, notify }).catch(err => {
    notify(`❌ *Wrap Error*\n\n${err.message}`);
  });

  await ctx.reply(
    `🧊 Wrapping DAEMON artifacts on all wallets...\n\nCA: \`${tokenCA}\``,
    { parse_mode: "Markdown" }
  );
});

bot.command("daemoncheck", async (ctx) => {
  const ca = ctx.match?.trim();
  if (!ca || !isValidAddress(ca)) {
    return ctx.reply("Usage: `/daemoncheck <CA>`\n\nChecks pool type, fee, hooks address, tax rate, and wrap function.", { parse_mode: "Markdown" });
  }

  await ctx.reply(`🔍 Checking DAEMON setup for \`${ca}\`...`, { parse_mode: "Markdown" });

  const [pool, wrapFn] = await Promise.all([
    detectPool(ca),
    detectWrapFunction(ca).catch(() => null),
  ]);

  if (!pool) {
    return ctx.reply(`❌ No pool found yet (V3 or V4). CA may not have launched.`);
  }

  let taxInfo = "N/A (V4 pool)";
  if (pool.type === "v3") {
    const { tax, error } = await detectTax(ca, 0.1, pool.fee);
    taxInfo = tax !== null ? `${tax.toFixed(1)}%` : `Unknown (${error})`;
  }

  await ctx.reply(
    `📊 *DAEMON Pre-Launch Check*\n\n` +
    `Pool: *${pool.type.toUpperCase()}*\n` +
    `Fee: ${pool.fee / 10000}%\n` +
    (pool.type === "v4" ? `Hooks: \`${pool.hooks}\`\n` : "") +
    `Transfer Tax: ${taxInfo}\n\n` +
    `Wrap Function: ${wrapFn ? `\`${wrapFn.sig}\` (${wrapFn.source})` : "Not found yet"}\n\n` +
    `${pool && wrapFn ? "✅ Ready to snipe!" : "⏳ Waiting for contract verification to find wrap fn."}`,
    { parse_mode: "Markdown" }
  );
});

// ─── Text handler (schedule flow + fallback) ─────────────────────────────────

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();

  // Mint-wallet PK capture (check before the "/" guard so /cancel works, and delete raw keys fast)
  if (pendingMintWalletPk.has(chatId)) {
    if (text === "/cancel") {
      pendingMintWalletPk.delete(chatId);
      return ctx.reply("Cancelled — no wallet added.");
    }
    const pk = text.startsWith("0x") ? text : `0x${text}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      try { await ctx.api.deleteMessage(chatId, ctx.message.message_id); } catch {}
      return ctx.reply("❌ That's not a valid private key (need 64 hex chars). Try again or /cancel.");
    }
    return _addMintWalletFromPk(ctx, pk);
  }

  if (text.startsWith("/")) return; // handled by commands

  // Custom token ID input for ID-based mint selection
  if (pendingCustomId.has(chatId)) {
    const mintId = pendingCustomId.get(chatId);
    const parsed = parseInt(text, 10);
    if (isNaN(parsed) || parsed < 0) {
      return ctx.reply("⚠️ Invalid — enter a whole number (e.g. 420).");
    }
    pendingCustomId.delete(chatId);
    const resolved = resolveIdSelection(mintId, BigInt(parsed));
    if (resolved) {
      await ctx.reply(`✅ Token ID *#${parsed}* selected — minting now...`, { parse_mode: "Markdown" });
    } else {
      await ctx.reply("⏰ Timed out — the mint window expired.");
    }
    return;
  }

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

// ─── ID Selection Callbacks ───────────────────────────────────────────────────

bot.callbackQuery(/^id_pick_([^_]+)_(\d+)$/, async (ctx) => {
  const mintId = ctx.match[1];
  const tokenIdStr = ctx.match[2];
  const tokenId = BigInt(tokenIdStr);
  const resolved = resolveIdSelection(mintId, tokenId);
  if (resolved) {
    await ctx.editMessageText(
      ctx.message?.text + `\n\n✅ *#${tokenIdStr} selected — minting...*`,
      { parse_mode: "Markdown" }
    );
  } else {
    await ctx.editMessageText("⏰ Selection timed out.");
  }
  await ctx.answerCallbackQuery(`Minting #${tokenIdStr}!`);
});

bot.callbackQuery(/^id_custom_(.+)$/, async (ctx) => {
  const mintId = ctx.match[1];
  pendingCustomId.set(ctx.chat.id, mintId);
  await ctx.answerCallbackQuery("Send me the token ID");
  await ctx.reply("🔢 Enter the exact token ID (number) you want to mint:");
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
      { command: "toggleautomint",  description: "Enable / disable auto copy-minting" },
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
      { command: "mintca",          description: "Auto-detect mint fn + price from contract ABI, then mint" },
      { command: "analyzelink",     description: "Paste a mint site URL — bot finds contract + mints automatically" },
      { command: "mint",            description: "Mint entry point — paste an OpenSea link or contract" },
      { command: "inspect",         description: "Paste link/CA → detect phase + schedule + proof, then mint or snipe" },
      { command: "snipes",          description: "View armed 'mint the moment it opens' snipes" },
      { command: "gas",             description: "View/set gas tier + ceiling for fires (normal/fast/war)" },
      { command: "privatesnipe",    description: "Toggle Flashbots private mempool for fires" },
      { command: "mintwallets",     description: "List the dedicated /inspect mint pool (max 20)" },
      { command: "addmintwallet",   description: "Add a wallet to the mint pool (paste its private key)" },
      { command: "removemintwallet", description: "Remove a wallet from the mint pool" },
      // Wallets
      { command: "wallets",         description: "List all sub-wallets with balances" },
      { command: "addwallet",       description: "Add a sub-wallet" },
      { command: "removewallet",    description: "Remove a sub-wallet" },
      { command: "checkgas",        description: "Show wallets with low gas" },
      { command: "topup",           description: "Show how much ETH each wallet (or group) needs to reach a USD target" },
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
      { command: "volume",          description: "Volume tracker for minted contracts" },
      // Price alerts
      { command: "setalert",        description: "Alert when floor hits target ETH" },
      { command: "removealert",     description: "Remove a price alert" },
      { command: "alerts",          description: "List all active price alerts" },
      // Drop watcher
      { command: "watch",           description: "Watch a SeaDrop contract for drop" },
      { command: "watches",         description: "List active drop watchers" },
      { command: "unwatch",         description: "Remove a drop watcher" },
      // DAEMON Sniper
      { command: "daemonadd",       description: "Register a wallet for the DAEMON snipe" },
      { command: "daemonremove",    description: "Remove a wallet from the snipe list" },
      { command: "daemonlist",      description: "Show registered wallets + 50% spend preview" },
      { command: "daemonclear",     description: "Clear the DAEMON snipe wallet list" },
      { command: "daemonsnipe",     description: "Dry run + snipe DAEMON at launch + wrap as ERC721" },
      { command: "daemonwrap",      description: "Manually wrap DAEMON artifacts as ERC721" },
      { command: "daemoncheck",     description: "Pre-launch check: pool type, tax rate, wrap fn" },
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
