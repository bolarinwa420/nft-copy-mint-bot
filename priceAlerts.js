import { getPriceAlerts, updatePriceAlert } from "./storage.js";

const POLL_INTERVAL = 2 * 60 * 1000;  // check every 2 minutes
const COOLDOWN = 30 * 60 * 1000;      // re-alert max once per 30 min per contract

async function getFloorPrice(contract) {
  try {
    const res = await fetch(
      `https://api.reservoir.tools/collections/v7?id=${contract}`,
      { headers: { "x-api-key": "demo" } }
    );
    const data = await res.json();
    return data.collections?.[0]?.floorAsk?.price?.amount?.native ?? null;
  } catch {
    return null;
  }
}

export function initPriceAlerts(notify) {
  const poll = async () => {
    const alerts = getPriceAlerts();
    for (const alert of alerts) {
      const floor = await getFloorPrice(alert.contract);
      if (floor === null) continue;

      if (floor >= alert.targetPrice) {
        const now = Date.now();
        const cooldownPassed = !alert.lastFiredAt || now - alert.lastFiredAt >= COOLDOWN;
        if (cooldownPassed) {
          await notify(
            `🚨 *Price Alert Triggered!*\n` +
            `Collection: *${alert.name || alert.contract}*\n` +
            `Floor is now *${floor.toFixed(4)} ETH* ≥ target ${alert.targetPrice} ETH`
          );
          await updatePriceAlert(alert.id, { lastFiredAt: now });
        }
      }
    }
  };

  // Run once immediately, then on interval
  poll().catch(console.error);
  setInterval(() => poll().catch(console.error), POLL_INTERVAL);
  console.log("[PriceAlerts] Polling started (2 min interval)");
}
