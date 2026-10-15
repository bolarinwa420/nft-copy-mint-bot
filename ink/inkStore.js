// Isolated lowdb store for the Ink copy-minter.
// Deliberately a SEPARATE db file from the mainnet bot so Ink state can never
// corrupt or shift mainnet behaviour. On Railway, point INK_DB_PATH at the same
// volume (e.g. /data/ink-db.json) so it persists across deploys.
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
    gasCeilingGwei: 5,    // hard cap on gas price (Ink is cheap + uncontested)
    maxMintNative: "0.05",// per-wallet spend ceiling in native token; skip above
    allowFreeMints: true,
    freeMintMax: 50,      // free mints: take the max the contract allows, up to this
    walletCount: 100,     // how many wallets to fire, from the top of the pool
    useMainWallet: true,  // prepend the MAIN wallet (MAIN_PRIVATE_KEY) to the pool
    alertChatId: null,    // falls back to mainnet ALERT_CHAT_ID at call site
    prereqCapUsd: 1.2,    // most we'd spend per wallet on a token a mint requires
    prereqReplicate: true,// replay the whale's buy → burn → mint path (main wallet only)
    prereqDailyMax: 3,    // replays per day, so a bad day costs at most 3 × the cap
  },
  mintLog: [],        // [{ contract, wallet, txHash, valueNative, timestamp }]
  replicated: [],     // [{ contract, timestamp }] — replays that reached the send step
};

let db;

export async function initInkDb() {
  const dbPath = process.env.INK_DB_PATH || "ink-db.json";
  db = await JSONFilePreset(dbPath, defaultData);
  // lazy-heal missing keys if an older file exists
  db.data.settings = { ...defaultData.settings, ...(db.data.settings || {}) };
  // The old default (10) was persisted on first boot and there is no command to
  // change it, so a stored 10 is never a user choice — lift it to the new default.
  if (db.data.settings.freeMintMax === 10) db.data.settings.freeMintMax = defaultData.settings.freeMintMax;
  await db.write();
  return db;
}

function requireDb() {
  if (!db) throw new Error("Ink DB not initialized");
  return db;
}

// --- seed from the bundled whale list ---
// Runs on EVERY boot and unions in any seed address not already tracked — the
// same semantics bot.js has always used for the mainnet WHALE_SEED loop. It used
// to bail out early once `seeded` was set, which meant growing seed-wallets.json
// was a silent no-op on any deploy that had already seeded once (Railway had).
// Existing tracked entries are never removed; a wallet you /inkuntrack that is
// still in the seed file WILL come back on the next boot — remove it from the
// file too if you want it gone for good.
export async function seedTrackedOnce() {
  const d = requireDb();
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
    console.warn("[INK] seed load failed:", e.message);
  }
  d.data.seeded = true;
  await d.write();
  return { skipped: false, count: d.data.tracked.length, added };
}

// --- tracked wallets ---
export function getInkTracked() { return requireDb().data.tracked; }

export async function addInkTracked(address) {
  const d = requireDb();
  const a = address.toLowerCase();
  if (!d.data.tracked.includes(a)) { d.data.tracked.push(a); await d.write(); return true; }
  return false;
}

export async function removeInkTracked(address) {
  const d = requireDb();
  const a = address.toLowerCase();
  const before = d.data.tracked.length;
  d.data.tracked = d.data.tracked.filter(x => x !== a);
  await d.write();
  return d.data.tracked.length < before;
}

// --- settings ---
export function getInkSettings() { return requireDb().data.settings; }

export async function updateInkSettings(patch) {
  const d = requireDb();
  Object.assign(d.data.settings, patch);
  await d.write();
  return d.data.settings;
}

// --- mint log ---
export async function logInkMint(entry) {
  const d = requireDb();
  d.data.mintLog.push({ ...entry, timestamp: Date.now() });
  if (d.data.mintLog.length > 1000) d.data.mintLog = d.data.mintLog.slice(-1000);
  await d.write();
}

export function getInkMintLog() { return requireDb().data.mintLog; }

// --- replay attempts (inkReplicate.js) ---
export function getInkReplicated() {
  const d = requireDb();
  if (!d.data.replicated) d.data.replicated = [];
  return d.data.replicated;
}

export async function logInkReplicated(contract) {
  const d = requireDb();
  getInkReplicated().push({ contract: contract.toLowerCase(), timestamp: Date.now() });
  if (d.data.replicated.length > 200) d.data.replicated = d.data.replicated.slice(-200);
  await d.write();
}
