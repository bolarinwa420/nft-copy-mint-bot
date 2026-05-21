import { getMintLog, getMintFloorBaseline, setMintFloorBaseline, addFiredMilestone } from "./storage.js";

const RESERVOIR_BASE = "https://api.reservoir.tools";
const POLL_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

// Milestones to alert on (% change from baseline)
const UP_MILESTONES   = [50, 100, 200, 500];
const DOWN_MILESTONES = [-50];

function getUniqueContracts() {
  const seen = new Set();
  for (const entry of getMintLog()) {
    const ca = entry.contract?.toLowerCase();
    if (ca) seen.add(ca);
  }
  return [...seen];
}

async function fetchFloors(contracts) {
  const BATCH = 20;
  const results = {};

  for (let i = 0; i < contracts.length; i += BATCH) {
    const chunk = contracts.slice(i, i + BATCH);
    const params = chunk.map(c => `contract=${c}`).join("&");
    try {
      const res = await fetch(
        `${RESERVOIR_BASE}/collections/v7?${params}&limit=${BATCH}`,
        { headers: { accept: "application/json" } }
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const col of data?.collections || []) {
        const ca = (col.primaryContract || col.id || "").toLowerCase();
        const floor = col.floorAsk?.price?.amount?.native ?? null;
        if (ca && floor !== null) {
          results[ca] = { name: col.name || ca, floor };
        }
      }
    } catch (e) {
      console.error(`[MintFloorTracker] Reservoir error: ${e.message}`);
    }
  }

  return results;
}

async function poll(notifyFn) {
  const contracts = getUniqueContracts();
  if (contracts.length === 0) return;

  console.log(`[MintFloorTracker] Checking ${contracts.length} contract(s)...`);

  const floors = await fetchFloors(contracts);

  for (const ca of contracts) {
    const info = floors[ca];
    if (!info || info.floor == null) continue;

    const currentFloor = info.floor;
    const existing = getMintFloorBaseline(ca);

    if (!existing) {
      // First time we've seen this contract — set baseline, no alert
      await setMintFloorBaseline(ca, currentFloor);
      console.log(`[MintFloorTracker] Baseline set for ${info.name}: ${currentFloor} ETH`);
      continue;
    }

    const baseline = existing.baselineFloor;
    if (!baseline || baseline === 0) continue;

    const pctChange = ((currentFloor - baseline) / baseline) * 100;
    const firedMilestones = existing.firedMilestones || [];

    // Check upward milestones
    for (const milestone of UP_MILESTONES) {
      if (pctChange >= milestone && !firedMilestones.includes(milestone)) {
        await addFiredMilestone(ca, milestone);

        const sign = "+";
        const msg =
          `🚀 *Floor Surge — ${info.name}*\n\n` +
          `\`${ca}\`\n\n` +
          `Floor is *${sign}${pctChange.toFixed(0)}%* since you minted!\n` +
          `Current: *${currentFloor.toFixed(4)} ETH*\n` +
          `Baseline: ${baseline.toFixed(4)} ETH\n\n` +
          `[OpenSea](https://opensea.io/collection/${ca}) | [Etherscan](https://etherscan.io/address/${ca})`;

        await notifyFn(msg, null, "Markdown");
        console.log(`[MintFloorTracker] Fired +${milestone}% for ${info.name} (${pctChange.toFixed(1)}%)`);
        break; // fire one milestone at a time per poll cycle
      }
    }

    // Check downward milestones
    for (const milestone of DOWN_MILESTONES) {
      if (pctChange <= milestone && !firedMilestones.includes(milestone)) {
        await addFiredMilestone(ca, milestone);

        const msg =
          `📉 *Floor Dump — ${info.name}*\n\n` +
          `\`${ca}\`\n\n` +
          `Floor is *${pctChange.toFixed(0)}%* since you minted.\n` +
          `Current: *${currentFloor.toFixed(4)} ETH*\n` +
          `Baseline: ${baseline.toFixed(4)} ETH\n\n` +
          `[OpenSea](https://opensea.io/collection/${ca}) | [Etherscan](https://etherscan.io/address/${ca})`;

        await notifyFn(msg, null, "Markdown");
        console.log(`[MintFloorTracker] Fired ${milestone}% for ${info.name} (${pctChange.toFixed(1)}%)`);
      }
    }
  }
}

export function initMintFloorTracker(notifyFn) {
  poll(notifyFn).catch(console.error);
  setInterval(() => poll(notifyFn).catch(console.error), POLL_INTERVAL);
  console.log("[MintFloorTracker] Started — polling every 6 hours");
}
