import { getPriceAlerts, updatePriceAlert } from "./storage.js";
import { getAlchemy } from "./tracker.js";

const POLL_INTERVAL = 2 * 60 * 1000;  // check every 2 minutes
const COOLDOWN = 30 * 60 * 1000;      // re-alert max once per 30 min per contract

export async function getFloorPrice(contract) {
  try {
    const alchemy = getAlchemy();
    if (!alchemy) {
      console.warn("[PriceAlerts] Alchemy not initialized yet");
      return null;
    }

    const result = await alchemy.nft.getFloorPrice(contract);

    // Collect non-error prices from all marketplaces
    const prices = [];
    for (const [market, data] of Object.entries(result)) {
      if (data?.error) {
        console.warn(`[PriceAlerts] ${market} error for ${contract}: ${data.error}`);
        continue;
      }
      if (data?.floorPrice != null && data?.priceCurrency === "ETH") {
        prices.push(data.floorPrice);
      }
    }

    if (prices.length === 0) {
      console.warn(`[PriceAlerts] No floor price found for ${contract}`);
      return null;
    }

    // Return the lowest floor across all markets (most conservative)
    return Math.min(...prices);
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

      if (floor >= alert.targetPrice) {
        const now = Date.now();
        const cooldownPassed = !alert.lastFiredAt || now - alert.lastFiredAt >= COOLDOWN;
        if (cooldownPassed) {
          await notify(
            `🚨 Price Alert Triggered!\n` +
            `Collection: ${alert.name || alert.contract}\n` +
            `Floor is now ${floor.toFixed(4)} ETH (target: ${alert.targetPrice} ETH)`,
            null,
            null
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
  console.log("[PriceAlerts] Polling started (2 min interval, Alchemy NFT API)");
}
