import { JSONFilePreset } from "lowdb/node";

const defaultData = {
  tracked: [],       // whale wallet addresses
  wallets: [],       // sub-wallets (copy-minter pool, max 100): [{ address, encryptedPk }]
  mintWallets: [],   // dedicated /inspect mint pool (max 20): [{ address, encryptedPk }]
  groups: {},        // wallet groups: { groupName: [walletIndex, ...] }
  settings: {
    autoMint: false,
    mevShield: true,
    maxMintEth: "1.0",
    alertChatId: null,
    whitelist: [],       // if non-empty, only auto-mint these contracts
    blacklist: [],       // never auto-mint these contracts
    allowFreeMints: true, // whether to auto-mint free (0 ETH) mints
  },
  jobs: [],          // scheduled mints
  snipes: [],        // SeaDrop "mint the moment it opens" snipes: [{ id, nftContract, qty, startTime, status }]
  mintLog: [],       // [{ contract, wallet, txHash, ethSpent, timestamp }]
  watches: [],       // drop watchers: [{ id, nftContract, group, calldata, active, createdAt }]
  priceAlerts: [],   // floor price alerts: [{ id, contract, targetPrice, lastFiredAt, createdAt }]
  sweepWatchers: [], // sweep watchers: [{ id, wallet, name, threshold, lastBlock, createdAt }]
  seadropAlertCounts: {}, // { [contractAddress]: alertCount } — persisted across deploys
  newCollectionAlertCounts: {}, // { [contractAddress]: alertCount } — persisted across deploys
  mintFloorBaselines: {}, // { [contract]: { baselineFloor, setAt, firedMilestones: [] } }
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

// --- Mint Wallets (dedicated /inspect pool, max 20) ---

export async function addMintWallet(address, encryptedPk) {
  if (!db.data.mintWallets) db.data.mintWallets = [];
  if (db.data.mintWallets.length >= 20) throw new Error("Max 20 mint wallets reached");
  if (db.data.mintWallets.find(w => w.address.toLowerCase() === address.toLowerCase())) {
    throw new Error("Wallet already added");
  }
  db.data.mintWallets.push({ address: address.toLowerCase(), encryptedPk });
  await db.write();
}

export async function removeMintWallet(address) {
  if (!db.data.mintWallets) return;
  db.data.mintWallets = db.data.mintWallets.filter(
    w => w.address.toLowerCase() !== address.toLowerCase()
  );
  await db.write();
}

export function getMintWallets() {
  return db.data.mintWallets || [];
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

// --- Snipes (mint-the-moment-it-opens) ---

export async function addSnipe(snipe) {
  if (!db.data.snipes) db.data.snipes = [];
  db.data.snipes.push(snipe);
  await db.write();
}

export async function updateSnipe(id, patch) {
  if (!db.data.snipes) return;
  const s = db.data.snipes.find(s => s.id === id);
  if (s) { Object.assign(s, patch); await db.write(); }
}

export async function removeSnipe(id) {
  if (!db.data.snipes) return;
  db.data.snipes = db.data.snipes.filter(s => s.id !== id);
  await db.write();
}

export function getSnipes() {
  return db.data.snipes || [];
}

// --- Contract Filters ---

export async function addToWhitelist(contract) {
  const c = contract.toLowerCase();
  if (!db.data.settings.whitelist) db.data.settings.whitelist = [];
  if (!db.data.settings.whitelist.includes(c)) {
    db.data.settings.whitelist.push(c);
    await db.write();
  }
}

export async function removeFromWhitelist(contract) {
  if (!db.data.settings.whitelist) return;
  db.data.settings.whitelist = db.data.settings.whitelist.filter(c => c !== contract.toLowerCase());
  await db.write();
}

export async function addToBlacklist(contract) {
  const c = contract.toLowerCase();
  if (!db.data.settings.blacklist) db.data.settings.blacklist = [];
  if (!db.data.settings.blacklist.includes(c)) {
    db.data.settings.blacklist.push(c);
    await db.write();
  }
}

export async function removeFromBlacklist(contract) {
  if (!db.data.settings.blacklist) return;
  db.data.settings.blacklist = db.data.settings.blacklist.filter(c => c !== contract.toLowerCase());
  await db.write();
}

// --- Drop Watches ---

export async function addWatch(watch) {
  if (!db.data.watches) db.data.watches = [];
  db.data.watches.push(watch);
  await db.write();
}

export async function deactivateWatch(id) {
  if (!db.data.watches) return;
  const w = db.data.watches.find((w) => w.id === id);
  if (w) { w.active = false; await db.write(); }
}

export async function removeWatch(id) {
  if (!db.data.watches) return;
  db.data.watches = db.data.watches.filter((w) => w.id !== id);
  await db.write();
}

export function getWatches() {
  return db.data.watches || [];
}

// --- Mint Log ---

export async function logMint(entry) {
  if (!db.data.mintLog) db.data.mintLog = [];
  db.data.mintLog.push(entry);
  await db.write();
}

export function getMintLog() {
  return db.data.mintLog || [];
}

// --- Price Alerts ---

export async function addPriceAlert(alert) {
  if (!db.data.priceAlerts) db.data.priceAlerts = [];
  db.data.priceAlerts.push(alert);
  await db.write();
}

export async function removePriceAlert(id) {
  if (!db.data.priceAlerts) return;
  db.data.priceAlerts = db.data.priceAlerts.filter(a => a.id !== id);
  await db.write();
}

export function getPriceAlerts() {
  return db.data.priceAlerts || [];
}

export async function updatePriceAlert(id, patch) {
  if (!db.data.priceAlerts) return;
  const alert = db.data.priceAlerts.find(a => a.id === id);
  if (alert) {
    Object.assign(alert, patch);
    await db.write();
  }
}

// --- Sweep Watchers ---

export async function addSweepWatcher(watcher) {
  if (!db.data.sweepWatchers) db.data.sweepWatchers = [];
  db.data.sweepWatchers.push(watcher);
  await db.write();
}

export async function removeSweepWatcher(id) {
  if (!db.data.sweepWatchers) return;
  db.data.sweepWatchers = db.data.sweepWatchers.filter(w => w.id !== id);
  await db.write();
}

export function getSweepWatchers() {
  return db.data.sweepWatchers || [];
}

export async function updateSweepWatcher(id, patch) {
  if (!db.data.sweepWatchers) return;
  const watcher = db.data.sweepWatchers.find(w => w.id === id);
  if (watcher) {
    Object.assign(watcher, patch);
    await db.write();
  }
}

// --- SeaDrop Alert Counts ---

export function getSeadropAlertCount(contract) {
  if (!db.data.seadropAlertCounts) return 0;
  return db.data.seadropAlertCounts[contract.toLowerCase()] || 0;
}

export async function incrementSeadropAlertCount(contract) {
  if (!db.data.seadropAlertCounts) db.data.seadropAlertCounts = {};
  const ca = contract.toLowerCase();
  db.data.seadropAlertCounts[ca] = (db.data.seadropAlertCounts[ca] || 0) + 1;
  await db.write();
}

export function getNewCollectionAlertCount(contract) {
  if (!db.data.newCollectionAlertCounts) return 0;
  return db.data.newCollectionAlertCounts[contract.toLowerCase()] || 0;
}

export async function incrementNewCollectionAlertCount(contract) {
  if (!db.data.newCollectionAlertCounts) db.data.newCollectionAlertCounts = {};
  const ca = contract.toLowerCase();
  db.data.newCollectionAlertCounts[ca] = (db.data.newCollectionAlertCounts[ca] || 0) + 1;
  await db.write();
}

// --- Mint Floor Baselines ---

export function getMintFloorBaseline(contract) {
  if (!db.data.mintFloorBaselines) return null;
  return db.data.mintFloorBaselines[contract.toLowerCase()] || null;
}

export async function setMintFloorBaseline(contract, floor) {
  if (!db.data.mintFloorBaselines) db.data.mintFloorBaselines = {};
  const ca = contract.toLowerCase();
  db.data.mintFloorBaselines[ca] = { baselineFloor: floor, setAt: Date.now(), firedMilestones: [] };
  await db.write();
}

export async function addFiredMilestone(contract, milestone) {
  if (!db.data.mintFloorBaselines) return;
  const ca = contract.toLowerCase();
  const rec = db.data.mintFloorBaselines[ca];
  if (!rec) return;
  if (!rec.firedMilestones) rec.firedMilestones = [];
  if (!rec.firedMilestones.includes(milestone)) {
    rec.firedMilestones.push(milestone);
    await db.write();
  }
}
