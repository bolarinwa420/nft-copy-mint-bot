import { getMintLog } from "./storage.js";

const RESERVOIR_BASE = "https://api.reservoir.tools";
const POLL_INTERVAL = 10 * 60 * 1000;   // check every 10 minutes
const COOLDOWN = 2 * 60 * 60 * 1000;    // re-alert max once per 2 hours per contract
const SALES_THRESHOLD = 10;

// In-memory cooldown tracker — resets on redeploy, which is fine
const lastFired = new Map(); // contract -> timestamp

function getUniqueContractsEverMinted() {
  const mintLog = getMintLog();
  const seen = new Set();
  for (const entry of mintLog) {
    const ca = entry.contract?.toLowerCase();
    if (ca) seen.add(ca);
  }
  return [...seen];
}

async function getSalesCount24h(contract) {
  try {
    const res = await fetch(
      `${RESERVOIR_BASE}/collections/v7?contract=${contract}&limit=1`,
      { headers: { accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const col = data?.collections?.[0];
    if (!col) return null;
    return {
      name: col.name || contract,
      salesCount: Number(col.salesCount?.["1day"] ?? 0),
      floor: col.floorAsk?.price?.amount?.native ?? null,
      volume24h: col.volume?.["1day"] ?? null,
    };
  } catch (e) {
    console.error(`[SalesWatcher] Reservoir error for ${contract}: ${e.message}`);
    return null;
  }
}

async function poll(notifyFn) {
  const contracts = getUniqueContractsEverMinted();
  if (contracts.length === 0) return;

  console.log(`[SalesWatcher] Checking ${contracts.length} contract(s)...`);

  for (const contract of contracts) {
    const stats = await getSalesCount24h(contract);
    if (!stats) continue;

    console.log(`[SalesWatcher] ${stats.name} — 24h sales: ${stats.salesCount}`);

    if (stats.salesCount > SALES_THRESHOLD) {
      const now = Date.now();
      const last = lastFired.get(contract) || 0;
      if (now - last < COOLDOWN) {
        const minsLeft = Math.ceil((COOLDOWN - (now - last)) / 60_000);
        console.log(`[SalesWatcher] ${stats.name} cooldown — ${minsLeft}m left`);
        continue;
      }

      lastFired.set(contract, now);

      const floor =
        stats.floor != null ? `${Number(stats.floor).toFixed(4)} ETH` : "—";
      const volume =
        stats.volume24h != null
          ? `${Number(stats.volume24h).toFixed(2)} ETH`
          : "—";

      await notifyFn(
        `🔥 *Sales Spike Alert!*\n\n` +
          `*${stats.name}* just hit ${stats.salesCount} sales today!\n\n` +
          `\`${contract}\`\n\n` +
          `24h Sales: *${stats.salesCount}*\n` +
          `Floor: ${floor}\n` +
          `24h Vol: ${volume}`,
        null,
        "Markdown"
      );

      console.log(`[SalesWatcher] Alert fired for ${stats.name} (${stats.salesCount} sales)`);
    }
  }
}

export function initSalesWatcher(notifyFn) {
  // Run once immediately, then on interval
  poll(notifyFn).catch(console.error);
  setInterval(() => poll(notifyFn).catch(console.error), POLL_INTERVAL);
  console.log("[SalesWatcher] Started — polling every 10 min, threshold: 50 sales/day");
}
