// Polls Nitter RSS for a Twitter account and alerts on new tweets

const TWITTER_HANDLE = "CAONHTAN1";
const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

const NITTER_INSTANCES = [
  "https://nitter.privacydev.net",
  "https://nitter.poast.org",
  "https://nitter.net",
  "https://nitter.1d4.us",
  "https://nitter.space",
];

const FREE_KEYWORDS = [
  "free mint", "free nft", "free drop", "free claim",
  "0 eth", "0eth", "freemint", "free wl", "free al",
  "no cost", "free", "gratis",
];

const PAID_KEYWORDS = [
  "paid", "price", "eth", "cost", " fee",
  "mint price", "public sale", "presale", "pre-sale",
  "0.0", "0.1", "0.2", "0.3", "0.4", "0.5",
];

const GENERAL_MINT_KEYWORDS = [
  "mint", "minting", "minted", "claim", "drop",
  "nft", "launch", "allowlist", "whitelist", "wl", "al",
  "open", "live", "0x",
];

const seenGuids = new Set();
let notifyFn = null;
let lastWorkingInstance = null;
let initialized = false;

function parseItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const guid    = extract(block, "guid");
    const title   = extractCdata(block, "title") || extract(block, "title");
    const link    = extract(block, "link");
    const pubDate = extract(block, "pubDate");
    const desc    = extractCdata(block, "description") || extract(block, "description") || "";
    if (guid && title) items.push({ guid, title, link, pubDate, desc });
  }
  return items;
}

function extract(xml, tag) {
  return (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml) || [])[1]?.trim();
}

function extractCdata(xml, tag) {
  return (new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i").exec(xml) || [])[1]?.trim();
}

function hasEmbeddedContent(desc) {
  // Check for URLs or quoted tweet blocks in the RSS description HTML
  const hasUrl = /https?:\/\//i.test(desc);
  const hasQuote = /class=["']?quote/i.test(desc) || /&gt;&gt;/i.test(desc);
  return hasUrl || hasQuote;
}

function classifyTweet(text, desc = "") {
  const lower = text.toLowerCase();
  const isFree = FREE_KEYWORDS.some(kw => lower.includes(kw));
  const isPaid = PAID_KEYWORDS.some(kw => lower.includes(kw));
  const isMint = GENERAL_MINT_KEYWORDS.some(kw => lower.includes(kw));

  if (isFree) return "free";
  if (isPaid) return "paid";
  if (isMint) return "mint";

  // No keywords — but check if there's an embedded link or quoted tweet
  if (hasEmbeddedContent(desc)) return "link";

  return null; // truly nothing — skip
}

async function fetchRss() {
  // Try last working instance first for speed
  const ordered = lastWorkingInstance
    ? [lastWorkingInstance, ...NITTER_INSTANCES.filter(i => i !== lastWorkingInstance)]
    : NITTER_INSTANCES;

  for (const instance of ordered) {
    try {
      const res = await fetch(`${instance}/${TWITTER_HANDLE}/rss`, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; NFTBot/1.0)" },
      });
      if (!res.ok) continue;
      const xml = await res.text();
      if (!xml.includes("<item>")) continue;
      lastWorkingInstance = instance;
      return xml;
    } catch {}
  }
  return null;
}

async function poll() {
  const xml = await fetchRss();
  if (!xml) {
    console.warn("[TwitterWatcher] All Nitter instances unreachable");
    return;
  }

  const items = parseItems(xml);

  // Seed on first run — don't alert for existing tweets
  if (!initialized) {
    items.forEach(i => seenGuids.add(i.guid));
    initialized = true;
    console.log(`[TwitterWatcher] Ready — tracking @${TWITTER_HANDLE}, seeded ${items.length} existing tweet(s) via ${lastWorkingInstance}`);
    return;
  }

  for (const item of items) {
    if (seenGuids.has(item.guid)) continue;
    seenGuids.add(item.guid);

    const type = classifyTweet(item.title, item.desc);
    if (!type) {
      console.log(`[TwitterWatcher] Skipped (no keywords, no links): ${item.title.slice(0, 60)}`);
      continue;
    }

    const badge =
      type === "free" ? "🆓 *FREE MINT*" :
      type === "paid" ? "💰 *PAID MINT*" :
      type === "link" ? "🔗 *Check This*" :
                        "🚨 *MINT ALERT*";

    const tweetUrl = item.link || `https://twitter.com/${TWITTER_HANDLE}`;

    const msg =
      `${badge} — @${TWITTER_HANDLE}\n\n` +
      `${item.title}\n\n` +
      `[View on Twitter](${tweetUrl})`;

    console.log(`[TwitterWatcher] [${type.toUpperCase()}] ${item.title.slice(0, 80)}`);
    if (notifyFn) await notifyFn(msg, null, "Markdown").catch(() => {});
  }
}

export function initTwitterWatcher(notify) {
  notifyFn = notify;
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
  console.log(`[TwitterWatcher] Polling @${TWITTER_HANDLE} every ${POLL_INTERVAL_MS / 1000}s`);
}

export function getTwitterWatcherStatus() {
  return {
    handle: TWITTER_HANDLE,
    initialized,
    seenCount: seenGuids.size,
    activeInstance: lastWorkingInstance || "none yet",
    pollIntervalSec: POLL_INTERVAL_MS / 1000,
  };
}
