import { getPriceAlerts, updatePriceAlert } from "./storage.js";

const POLL_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const COOLDOWN = 6 * 60 * 60 * 1000;      // re-alert max once per 6 hours per contract
const RESERVOIR_BASE = "https://api.reservoir.tools";

export async function getFloorPrice(contract) {
  try {
    const res = await fetch(`${RESERVOIR_BASE}/collections/v7?id=${contract}&limit=1`);
    const data = await res.json();
    const col = data?.collections?.[0];
    return col?.floorAsk?.price?.amount?.native ?? null;
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
