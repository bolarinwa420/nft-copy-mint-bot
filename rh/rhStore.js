// Isolated lowdb store for the Robinhood Chain copy-minter.
// Deliberately a SEPARATE db file from the mainnet bot so RH state can never
// corrupt or shift mainnet behaviour. On Railway, point RH_DB_PATH at the same
// volume (e.g. /data/rh-db.json) so it persists across deploys.
import { JSONFilePreset } from "lowdb/node";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaultData = {
  tracked: [],        // whale wallet addresses (lowercased)
  seeded: false,      // whether we imported the bundled seed list yet
  settings: {
    enabled: true,        // master on/off for auto copy-minting
    dryRun: true,         // simulate + alert only, DON'T broadcast (safe default)
    gasCeilingGwei: 5,    // hard cap on gas price (RH is cheap + uncontested)
    maxMintNative: "0.05",// per-wallet spend ceiling in native token; skip above
    allowFreeMints: true,
    freeMintMax: 10,      // free mints: grab per-wallet cap, clamped to this
    freeMintFallback: 3,  // free mint + cap unreadable → this many
    walletCount: 100,     // how many wallets to fire, from the top of the pool
    useMainWallet: true,  // prepend the MAIN wallet (MAIN_PRIVATE_KEY) to the pool
    alertChatId: null,    // falls back to mainnet ALERT_CHAT_ID at call site
  },
  mintLog: [],        // [{ contract, wallet, txHash, valueNative, timestamp }]
};

let db;

export async function initRhDb() {
  const dbPath = process.env.RH_DB_PATH || "rh-db.json";
  db = await JSONFilePreset(dbPath, defaultData);
  // lazy-heal missing keys if an older file exists
  db.data.settings = { ...defaultData.settings, ...(db.data.settings || {}) };
  await db.write();
  return db;
}

function requireDb() {
  if (!db) throw new Error("RH DB not initialized");
  return db;
}

// --- one-time seed from bundled whale list ---
export async function seedTrackedOnce() {
  const d = requireDb();
  if (d.data.seeded && d.data.tracked.length) return { skipped: true, count: d.data.tracked.length };
  const seedPath = path.join(__dirname, "seed-wallets.json");
  let added = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    const addrs = raw
      .filter(w => w.copyEnabled !== false)
      .map(w => (w.address || "").toLowerCase())
      .filter(a => /^0x[0-9a-f]{40}$/.test(a));
    const set = new Set(d.data.tracked);
    for (const a of addrs) if (!set.has(a)) { d.data.tracked.push(a); set.add(a); added++; }
  } catch (e) {
    console.warn("[RH] seed load failed:", e.message);
  }
  d.data.seeded = true;
  await d.write();
  return { skipped: false, count: d.data.tracked.length, added };
}

// --- tracked wallets ---
export function getRhTracked() { return requireDb().data.tracked; }

export async function addRhTracked(address) {
  const d = requireDb();
  const a = address.toLowerCase();
  if (!d.data.tracked.includes(a)) { d.data.tracked.push(a); await d.write(); return true; }
  return false;
}

export async function removeRhTracked(address) {
  const d = requireDb();
  const a = address.toLowerCase();
  const before = d.data.tracked.length;
  d.data.tracked = d.data.tracked.filter(x => x !== a);
  await d.write();
  return d.data.tracked.length < before;
}

// --- settings ---
export function getRhSettings() { return requireDb().data.settings; }

export async function updateRhSettings(patch) {
  const d = requireDb();
  Object.assign(d.data.settings, patch);
  await d.write();
  return d.data.settings;
}

// --- mint log ---
export async function logRhMint(entry) {
  const d = requireDb();
  d.data.mintLog.push({ ...entry, timestamp: Date.now() });
  if (d.data.mintLog.length > 1000) d.data.mintLog = d.data.mintLog.slice(-1000);
  await d.write();
}

export function getRhMintLog() { return requireDb().data.mintLog; }
