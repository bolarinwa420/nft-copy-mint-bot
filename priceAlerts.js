import { getPriceAlerts, updatePriceAlert } from "./storage.js";

const POLL_INTERVAL = 2 * 60 * 1000;  // check every 2 minutes
const COOLDOWN = 30 * 60 * 1000;      // re-alert max once per 30 min per contract

export async function getFloorPrice(contract) {
  try {
    // Primary: Reservoir (works with contract address)
    const res = await fetch(
      `https://api.reservoir.tools/collections/v7?id=${contract}`,
      { headers: { "x-api-key": "demo" } }
    );
    if (!res.ok) {
      console.warn(`[PriceAlerts] Reservoir HTTP ${res.status} for ${contract}`);
    } else {
      const data = await res.json();
      const floor = data.collections?.[0]?.floorAsk?.price?.amount?.native ?? null;
      if (floor !== null) return floor;
      console.warn(`[PriceAlerts] Reservoir returned no floor for ${contract} — collections: ${JSON.stringify(data.collections?.length)}`);
    }

    // Fallback: OpenSea public stats endpoint (no key needed)
    const res2 = await fetch(
      `https://api.opensea.io/api/v2/collections/${contract}/stats`,
      { headers: { "accept": "application/json" } }
    );
    if (res2.ok) {
      const data2 = await res2.json();
      return data2?.total?.floor_price ?? null;
    }
    console.warn(`[PriceAlerts] OpenSea fallback HTTP ${res2.status} for ${contract}`);
    return null;
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
        console.log(`[PriceAlerts] Reservoir returned null for ${alert.contract}`);
        continue;
      }

      if (floor >= alert.targetPrice) {
        const now = Date.now();
        const cooldownPassed = !alert.lastFiredAt || now - alert.lastFiredAt >= COOLDOWN;
        if (cooldownPassed) {
          await notify(
            `🚨 Price Alert Triggered!\n` +
            `Collection: ${alert.name || alert.contract}\n` +
            `Floor is now ${floor.toFixed(4)} ETH (target: ${alert.targetPrice} ETH)`,
            null,  // no txHash
            null   // no parseMode — plain text avoids Markdown parse errors
          );
          await updatePriceAlert(alert.id, { lastFiredAt: now });
        } else {
          const minsLeft = Math.ceil((COOLDOWN - (now - alert.lastFiredAt)) / 60000);
          console.log(`[PriceAlerts] ${alert.name} cooldown — ${minsLeft} min left`);
        }
      }
    }
  };

  // Run once immediately, then on interval
  poll().catch(console.error);
  setInterval(() => poll().catch(console.error), POLL_INTERVAL);
  console.log("[PriceAlerts] Polling started (2 min interval)");
}
