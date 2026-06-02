import { getPriceAlerts, updatePriceAlert } from "./storage.js";
import { getAlchemy } from "./tracker.js";

const POLL_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const COOLDOWN = 6 * 60 * 60 * 1000;      // re-alert max once per 6 hours per contract
const OPENSEA_API = "https://api.opensea.io/api/v2";

// Read floor from OpenSea (same source the user sees on the site).
// contract -> collection slug -> /stats.total.floor_price. Falls back to
// Reservoir if OpenSea is unavailable so alerts aren't blinded by a hiccup.
async function getOpenSeaFloor(contract) {
  // OpenSea's v2 contract/stats endpoints work WITHOUT a key — send one if we
  // have it (higher rate limits) but never bail just because it's missing.
  const apiKey = process.env.OPENSEA_API_KEY;
  const headers = { Accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const cRes = await fetch(`${OPENSEA_API}/chain/ethereum/contract/${contract}`, { headers });
  if (!cRes.ok) throw new Error(`OpenSea contract ${cRes.status}`);
  const slug = (await cRes.json()).collection;
  if (!slug) return null;

  const sRes = await fetch(`${OPENSEA_API}/collections/${slug}/stats`, { headers });
  if (!sRes.ok) throw new Error(`OpenSea stats ${sRes.status}`);
  const fp = (await sRes.json())?.total?.floor_price;
  return typeof fp === "number" && fp > 0 ? fp : null;
}

// Alchemy NFT API takes the contract address directly — no slug lookup, no
// OpenSea key required. This is the most reliable source so it goes first.
async function getAlchemyFloor(contract) {
  const fp = (await getAlchemy().nft.getFloorPrice(contract))?.openSea?.floorPrice;
  return typeof fp === "number" && fp > 0 ? fp : null;
}

export async function getFloorPrice(contract) {
  try {
    const floor = await getAlchemyFloor(contract);
    if (floor !== null) return floor;
  } catch (e) {
    console.error(`[PriceAlerts] Alchemy floor error for ${contract}: ${e.message} — falling back to OpenSea`);
  }
  // Fallback: OpenSea by slug (contract->slug step needs OPENSEA_API_KEY).
  try {
    return await getOpenSeaFloor(contract);
  } catch (e) {
    console.error(`[PriceAlerts] getFloorPrice error for ${contract}: ${e.message}`);
    return null;
  }
}

export function initPriceAlerts(notify) {
  const poll = async () => {
    const alerts = getPriceAlerts();
    for (const alert of alerts) {
      const floor = await getFloorPrice(alert.contract);
      console.log(`[PriceAlerts] ${alert.name} — floor: ${floor} | target: ${alert.targetPrice}`);
      if (floor === null) {
        console.log(`[PriceAlerts] No price data for ${alert.contract} — skipping`);
        continue;
      }

      const triggered = alert.direction === "below"
        ? floor <= alert.targetPrice
        : floor >= alert.targetPrice;
      if (triggered) {
        const now = Date.now();
        const cooldownPassed = !alert.lastFiredAt || now - alert.lastFiredAt >= COOLDOWN;
        if (cooldownPassed) {
          const dirWord = alert.direction === "below" ? "dropped to" : "reached";
          await notify(
            `🚨 Price Alert Triggered!\n` +
            `Collection: ${alert.name || alert.contract}\n` +
            `Floor has ${dirWord} ${floor.toFixed(4)} ETH (target: ${alert.targetPrice} ETH)`,
            null,
            null
          );
          await updatePriceAlert(alert.id, { lastFiredAt: now });
        } else {
          const hrsLeft = ((COOLDOWN - (now - alert.lastFiredAt)) / 3600000).toFixed(1);
          console.log(`[PriceAlerts] ${alert.name} cooldown — ${hrsLeft}h left`);
        }
      }
    }
  };

  // Run once immediately, then on interval
  poll().catch(console.error);
  setInterval(() => poll().catch(console.error), POLL_INTERVAL);
  console.log("[PriceAlerts] Polling started (5 min interval, Reservoir API)");
}
