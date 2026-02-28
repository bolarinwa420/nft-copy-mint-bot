import { JSONFilePreset } from "lowdb/node";

const defaultData = {
  tracked: [],       // whale wallet addresses
  wallets: [],       // sub-wallets: [{ address, encryptedPk }]
  groups: {},        // wallet groups: { groupName: [walletIndex, ...] }
  settings: {
    autoMint: false,
    mevShield: true,
    maxMintEth: "1.0",
    alertChatId: null,
  },
  jobs: [],          // scheduled mints
};

let db;

export async function initDb() {
  // DB_PATH lets Railway volume persist data across deploys
  const dbPath = process.env.DB_PATH || "db.json";
  db = await JSONFilePreset(dbPath, defaultData);
  return db;
}

export function getDb() {
  if (!db) throw new Error("DB not initialized");
  return db;
}

// --- Tracked Wallets ---

export async function addTracked(address) {
  const addr = address.toLowerCase();
  if (!db.data.tracked.includes(addr)) {
    db.data.tracked.push(addr);
    await db.write();
  }
}

export async function removeTracked(address) {
  const addr = address.toLowerCase();
  db.data.tracked = db.data.tracked.filter(a => a !== addr);
  await db.write();
}

export function getTracked() {
  return db.data.tracked;
}

// --- Sub Wallets ---

export async function addSubWallet(address, encryptedPk) {
  if (db.data.wallets.length >= 100) throw new Error("Max 100 sub-wallets reached");
  if (db.data.wallets.find(w => w.address.toLowerCase() === address.toLowerCase())) {
    throw new Error("Wallet already added");
  }
  db.data.wallets.push({ address: address.toLowerCase(), encryptedPk });
  await db.write();
}

export async function removeSubWallet(address) {
  db.data.wallets = db.data.wallets.filter(
    w => w.address.toLowerCase() !== address.toLowerCase()
  );
  await db.write();
}

export function getSubWallets() {
  return db.data.wallets;
}

// --- Groups ---

export async function createGroup(name, fromIndex, toIndex) {
  if (!db.data.groups) db.data.groups = {};
  const indices = [];
  for (let i = fromIndex; i <= toIndex; i++) indices.push(i);
  db.data.groups[name.toLowerCase()] = indices;
  await db.write();
}

export async function deleteGroup(name) {
  if (db.data.groups) {
    delete db.data.groups[name.toLowerCase()];
    await db.write();
  }
}

export function getGroups() {
  return db.data.groups || {};
}

export function getGroupWallets(name) {
  const groups = db.data.groups || {};
  const indices = groups[name.toLowerCase()];
  if (!indices) return null;
  return indices
    .map(i => db.data.wallets[i])
    .filter(Boolean);
}

// --- Settings ---

export function getSettings() {
  return db.data.settings;
}

export async function updateSettings(patch) {
  Object.assign(db.data.settings, patch);
  await db.write();
}

// --- Scheduled Jobs ---

export async function addJob(job) {
  db.data.jobs.push(job);
  await db.write();
}

export async function removeJob(id) {
  db.data.jobs = db.data.jobs.filter(j => j.id !== id);
  await db.write();
}

export async function updateJobStatus(id, status) {
  const job = db.data.jobs.find(j => j.id === id);
  if (job) {
    job.status = status;
    await db.write();
  }
}

export function getJobs() {
  return db.data.jobs;
}
