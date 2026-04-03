// Watches for brand-new collections (created in last MAX_AGE_HOURS) that hit
// SALES_THRESHOLD sales on Reservoir. Polls every POLL_INTERVAL ms.

const RESERVOIR_BASE   = "https://api.reservoir.tools";
const POLL_INTERVAL    = 3 * 60 * 1000;  // every 3 minutes
const COOLDOWN         = 60 * 60 * 1000; // re-alert max once per hour per contract
const SALES_THRESHOLD  = 50;             // sales in the last 24h to trigger
const MAX_AGE_HOURS    = 48;             // only care about collections launched in last 48h

// In-memory — fine, Railway restarts are rare and worst case is a duplicate alert
const lastFired = new Map(); // contract -> timestamp

async function fetchNewCollections() {
  // sortBy=createdAt gives us the freshest collections first
  const url = `${RESERVOIR_BASE}/collections/v7?sortBy=createdAt&limit=100&includeAttributes=false`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Reservoir HTTP ${res.status}`);
  const data = await res.json();
  return data?.collections || [];
}

async function poll(notifyFn) {
  let collections;
  try {
    collections = await fetchNewCollections();
  } catch (e) {
    console.error(`[NewCollectionWatcher] Fetch error: ${e.message}`);
    return;
  }

  const now = Date.now();
  const cutoff = now - MAX_AGE_HOURS * 60 * 60 * 1000;

  for (const col of collections) {
    const createdAt = col.createdAt ? new Date(col.createdAt).getTime() : 0;

    // Stop processing once we hit collections older than our window
    // (results are sorted newest-first so we can break early)
    if (createdAt < cutoff) break;

    const contract   = (col.id || col.primaryContract || "").toLowerCase();
    const name       = col.name || contract;
    const sales24h   = Number(col.salesCount?.["1day"] ?? 0);
    const floor      = col.floorAsk?.price?.amount?.native ?? null;
    const volume24h  = col.volume?.["1day"] ?? null;

    if (!contract || sales24h < SALES_THRESHOLD) continue;

    const lastFiredAt = lastFired.get(contract) || 0;
    if (now - lastFiredAt < COOLDOWN) continue;

    lastFired.set(contract, now);

    const ageHours   = ((now - createdAt) / (60 * 60 * 1000)).toFixed(1);
    const floorStr   = floor   != null ? `${Number(floor).toFixed(4)} ETH`   : "—";
    const volumeStr  = volume24h != null ? `${Number(volume24h).toFixed(2)} ETH` : "—";

    console.log(`[NewCollectionWatcher] Hot new drop: ${name} — ${sales24h} sales, ${ageHours}h old`);

    await notifyFn(
      `🚨 *New Collection Heating Up!*\n\n` +
      `*${name}*\n` +
      `\`${contract}\`\n\n` +
      `Age: *${ageHours}h old*\n` +
      `24h Sales: *${sales24h}*\n` +
      `Floor: ${floorStr}\n` +
      `24h Vol: ${volumeStr}\n\n` +
      `[OpenSea](https://opensea.io/assets/ethereum/${contract}) | [Etherscan](https://etherscan.io/address/${contract})`,
      null,
      "Markdown"
    );
  }
}

export function initNewCollectionWatcher(notifyFn) {
  poll(notifyFn).catch(console.error);
  setInterval(() => poll(notifyFn).catch(console.error), POLL_INTERVAL);
  console.log(`[NewCollectionWatcher] Started — polling every 3 min, threshold: ${SALES_THRESHOLD} sales, max age: ${MAX_AGE_HOURS}h`);
}
