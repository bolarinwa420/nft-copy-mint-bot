import { getMintLog } from "./storage.js";

const RESERVOIR_BASE = "https://api.reservoir.tools";

async function getCollectionStats(contract) {
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
      name: col.name || null,
      floor: col.floorAsk?.price?.amount?.native ?? null,
      volume24h: col.volume?.["1day"] ?? null,
    };
  } catch (e) {
    console.error(`[DailyDigest] Reservoir error for ${contract}: ${e.message}`);
    return null;
  }
}

async function runDailyDigest(notifyFn) {
  console.log("[DailyDigest] Running daily digest...");

  const now = Date.now();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dayStart = startOfDay.getTime();

  const mintLog = getMintLog();
  const todayMints = mintLog.filter(
    (entry) => entry.timestamp >= dayStart && entry.timestamp <= now
  );

  const date = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  if (todayMints.length === 0) {
    await notifyFn(
      `📊 *Daily Mint Digest — ${date}*\n\nNo mints recorded today.`,
      null,
      "Markdown"
    );
    return;
  }

  // Count mints per unique contract
  const contractCounts = {};
  for (const entry of todayMints) {
    const ca = entry.contract?.toLowerCase();
    if (!ca) continue;
    contractCounts[ca] = (contractCounts[ca] || 0) + 1;
  }

  const contracts = Object.keys(contractCounts);
  const lines = [
    `📊 *Daily Mint Digest — ${date}*`,
    `${todayMints.length} mint(s) across ${contracts.length} collection(s)\n`,
  ];

  for (const contract of contracts) {
    const stats = await getCollectionStats(contract);
    const name = stats?.name || contract;
    const floor =
      stats?.floor != null ? `${Number(stats.floor).toFixed(4)} ETH` : "—";
    const volume =
      stats?.volume24h != null
        ? `${Number(stats.volume24h).toFixed(2)} ETH`
        : "—";
    const count = contractCounts[contract];

    lines.push(
      `🖼 *${name}*\n` +
        `\`${contract}\`\n` +
        `Minted: ${count}  |  Floor: ${floor}  |  24h Vol: ${volume}`
    );
  }

  await notifyFn(lines.join("\n"), null, "Markdown");
  console.log(`[DailyDigest] Digest sent — ${contracts.length} collection(s)`);
}

function msUntilNextDigest() {
  const now = new Date();
  const next = new Date();
  next.setHours(23, 59, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export function initDailyDigest(notifyFn) {
  const schedule = () => {
    const delay = msUntilNextDigest();
    const h = Math.floor(delay / 3_600_000);
    const m = Math.floor((delay % 3_600_000) / 60_000);
    console.log(`[DailyDigest] Next digest in ${h}h ${m}m`);

    setTimeout(async () => {
      await runDailyDigest(notifyFn).catch((e) =>
        console.error("[DailyDigest] Error:", e.message)
      );
      schedule(); // reschedule for the next day
    }, delay);
  };

  schedule();
}
