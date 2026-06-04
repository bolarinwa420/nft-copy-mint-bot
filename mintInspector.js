// mintInspector.js — paste-a-link → full mint intel (contract, phases, price, allowlist proof)
//
// Upgrades over linkAnalyzer.js:
//   1. Deep site read — fetches the JS bundles too, not just top-level HTML (custom dapps hide the CA there)
//   2. OpenSea / Etherscan / raw-CA input resolution
//   3. Phase detection — public vs allowlist, which is live, and each phase's price
//   4. Allowlist merkle-proof auto-pull — from the site's proof API, or computed locally from a baked-in tree
//
// Reuses contractMinter helpers for ABI + mint-fn + price.

import { ethers } from "ethers";
import { fetchABI, findBestMintFn, readMintPrice, mintFnSignature } from "./contractMinter.js";

const ERC721_ID = "0x80ac58cd";
const ERC1155_ID = "0xd9b67a26";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// OpenSea SeaDrop router — stores the drop schedule (price + start/end times) on-chain, readable pre-launch
export const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const SEADROP_SCHEDULE_ABI = [
  "function getPublicDrop(address) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
  "function getAllowListMerkleRoot(address) view returns (bytes32)",
];

// ─── SeaDrop drop schedule (the Proof-style phase card) ──────────────────────

// Read the public + allowlist schedule straight from the SeaDrop router. Works before the sale opens.
export async function readSeadropSchedule(provider, nftContract) {
  const c = new ethers.Contract(SEADROP_ADDRESS, SEADROP_SCHEDULE_ABI, provider);
  const out = { isSeadrop: false, public: null, allowlist: null };

  try {
    const d = await c.getPublicDrop(nftContract);
    const startTime = Number(d.startTime);
    const endTime = Number(d.endTime);
    if (startTime > 0 || endTime > 0 || d.mintPrice > 0n) {
      out.isSeadrop = true;
      out.public = {
        price: ethers.formatEther(d.mintPrice),
        startTime,
        endTime,
        maxPerWallet: Number(d.maxTotalMintableByWallet),
      };
    }
  } catch {}

  try {
    const root = await c.getAllowListMerkleRoot(nftContract);
    if (root && root !== ethers.ZeroHash) {
      out.isSeadrop = true;
      out.allowlist = { merkleRoot: root };
    }
  } catch {}

  return out;
}

// Human status for a phase window. now = unix seconds.
export function phaseStatus(startTime, endTime, now = Math.floor(Date.now() / 1000)) {
  if (!startTime) return { state: "unknown", label: "time unknown" };
  if (now < startTime) return { state: "upcoming", label: `opens in ${humanDuration(startTime - now)}`, opensAt: startTime };
  if (endTime && now > endTime) return { state: "ended", label: "ended" };
  return { state: "live", label: "🟢 LIVE NOW", endsAt: endTime };
}

export function humanDuration(secs) {
  if (secs < 0) secs = 0;
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtUTC(unixSecs) {
  if (!unixSecs) return "—";
  return new Date(unixSecs * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// ─── Input classification ───────────────────────────────────────────────────

// Turn whatever the user pasted into { kind, contract?, url?, origin? }
export function classifyInput(raw) {
  const input = raw.trim();

  // Raw contract address
  if (/^0x[0-9a-fA-F]{40}$/.test(input)) {
    return { kind: "contract", contract: ethers.getAddress(input) };
  }

  // Anything else should be a URL
  let u;
  try {
    u = new URL(input.startsWith("http") ? input : `https://${input}`);
  } catch {
    return { kind: "unknown", raw: input };
  }
  const host = u.hostname.replace(/^www\./, "");
  const origin = u.origin;

  // Etherscan — contract is in /address/0x.. or /token/0x..
  if (host.endsWith("etherscan.io")) {
    const m = u.pathname.match(/0x[0-9a-fA-F]{40}/);
    if (m) return { kind: "contract", contract: ethers.getAddress(m[0]), url: input };
  }

  // OpenSea
  if (host.endsWith("opensea.io")) {
    // /assets/ethereum/0x.../123  → contract in path
    const direct = u.pathname.match(/\/(?:assets|item)\/[^/]+\/(0x[0-9a-fA-F]{40})/);
    if (direct) return { kind: "contract", contract: ethers.getAddress(direct[1]), url: input };
    // /collection/<slug> → needs API resolve
    const coll = u.pathname.match(/\/collection\/([^/?#]+)/);
    if (coll) return { kind: "opensea", slug: coll[1], url: input };
  }

  // Magic Eden — /ethereum/0x.. or /collections/ethereum/0x..
  if (host.endsWith("magiceden.io")) {
    const m = u.pathname.match(/0x[0-9a-fA-F]{40}/);
    if (m) return { kind: "contract", contract: ethers.getAddress(m[0]), url: input };
  }

  // Anything else → custom mint site, deep-read it
  return { kind: "site", url: input, origin };
}

// ─── OpenSea slug → contract ─────────────────────────────────────────────────

export async function resolveOpenSeaSlug(slug, apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://api.opensea.io/api/v2/collections/${slug}`, {
      headers: { "X-API-KEY": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const eth = (json.contracts || []).find((c) => c.chain === "ethereum");
    return eth ? ethers.getAddress(eth.address) : null;
  } catch {
    return null;
  }
}

// ─── Deep site read (HTML + JS bundles) ──────────────────────────────────────

function extractAddresses(text) {
  return [...new Set(text.match(/0x[0-9a-fA-F]{40}/g) || [])];
}

// Pull <script src> + Next.js chunk paths out of the HTML
function extractScriptUrls(html, origin) {
  const urls = new Set();
  const srcRe = /<script[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = srcRe.exec(html))) {
    try {
      urls.add(new URL(m[1], origin).href);
    } catch {}
  }
  // Next.js / Vite chunk references that appear as bare strings in inline scripts
  const chunkRe = /["'](\/_next\/static\/[^"']+\.js|\/assets\/[^"']+\.js)["']/g;
  while ((m = chunkRe.exec(html))) {
    try {
      urls.add(new URL(m[1], origin).href);
    } catch {}
  }
  return [...urls];
}

// Fetch the page and its JS bundles, return the combined text blob.
export async function deepFetchSite(url, { maxBundles = 12, maxBytes = 4_000_000 } = {}) {
  const origin = new URL(url).origin;
  let html;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    throw new Error(`Couldn't fetch page: ${err.message}`);
  }

  const scriptUrls = extractScriptUrls(html, origin).slice(0, maxBundles);
  let combined = html;
  let total = html.length;

  // Fetch bundles in parallel; ignore failures
  const bundles = await Promise.allSettled(
    scriptUrls.map((su) =>
      fetch(su, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) }).then((r) =>
        r.ok ? r.text() : ""
      )
    )
  );
  for (const b of bundles) {
    if (b.status === "fulfilled" && b.value) {
      if (total + b.value.length > maxBytes) continue;
      combined += "\n" + b.value;
      total += b.value.length;
    }
  }

  return { html, origin, combined, scriptCount: scriptUrls.length };
}

// ─── NFT contract detection ──────────────────────────────────────────────────

async function isNFTContract(provider, address) {
  const iface = new ethers.Interface(["function supportsInterface(bytes4) view returns (bool)"]);
  for (const id of [ERC721_ID, ERC1155_ID]) {
    try {
      const data = iface.encodeFunctionData("supportsInterface", [id]);
      const result = await provider.call({ to: address, data });
      const [ok] = iface.decodeFunctionResult("supportsInterface", result);
      if (ok) return true;
    } catch {}
  }
  return false;
}

// ─── Phase detection (public vs allowlist) ───────────────────────────────────

// Boolean getters that signal a live phase
const PUBLIC_FLAGS = [
  "saleIsActive", "publicSaleActive", "isPublicSaleActive", "publicMintActive",
  "isPublicMintActive", "mintActive", "saleActive", "isPublicSaleOpen", "publicActive",
  "isMintActive", "mintingActive", "isSaleActive",
];
const ALLOWLIST_FLAGS = [
  "presaleActive", "isPresaleActive", "allowlistActive", "isAllowlistActive",
  "whitelistActive", "isWhitelistActive", "wlMintActive", "presaleIsActive",
  "allowListActive", "isAllowListActive", "presaleOpen",
];
const ALLOWLIST_PRICE_GETTERS = [
  "presalePrice", "allowlistPrice", "allowListPrice", "whitelistPrice",
  "wlPrice", "PRESALE_PRICE", "WHITELIST_PRICE",
];

async function readBoolGetter(provider, contract, name) {
  try {
    const iface = new ethers.Interface([`function ${name}() view returns (bool)`]);
    const result = await provider.call({ to: contract, data: iface.encodeFunctionData(name, []) });
    const [val] = iface.decodeFunctionResult(name, result);
    return { exists: true, value: !!val };
  } catch {
    return { exists: false };
  }
}

async function readUintGetter(provider, contract, name) {
  try {
    const iface = new ethers.Interface([`function ${name}() view returns (uint256)`]);
    const result = await provider.call({ to: contract, data: iface.encodeFunctionData(name, []) });
    const [val] = iface.decodeFunctionResult(name, result);
    return val;
  } catch {
    return null;
  }
}

// Probe both phases. Returns { public:{exists,active,price}, allowlist:{exists,active,price} }
export async function detectPhases(provider, contract, abi, publicPrice) {
  const probe = async (flags) => {
    const results = await Promise.all(flags.map((f) => readBoolGetter(provider, contract, f)));
    const found = results.find((r) => r.exists);
    return found ? { exists: true, active: found.value } : { exists: false, active: false };
  };

  const [pub, allow] = await Promise.all([probe(PUBLIC_FLAGS), probe(ALLOWLIST_FLAGS)]);

  // Allowlist price
  let allowPrice = null;
  for (const g of ALLOWLIST_PRICE_GETTERS) {
    const v = await readUintGetter(provider, contract, g);
    if (v !== null && v > 0n) { allowPrice = ethers.formatEther(v); break; }
  }

  // Some contracts expose a single enum saleState(): 0=closed,1=presale,2=public
  let enumState = null;
  const es = await readUintGetter(provider, contract, "saleState");
  if (es !== null) enumState = Number(es);

  return {
    public: { exists: pub.exists, active: pub.active || enumState === 2, price: publicPrice },
    allowlist: { exists: allow.exists || enumState === 1, active: allow.active || enumState === 1, price: allowPrice || publicPrice },
    enumState,
  };
}

// Find the allowlist mint function in the ABI (takes a bytes32[] proof)
export function findAllowlistMintFn(abi) {
  if (!abi) return null;
  const kw = ["presale", "allowlist", "allowList", "whitelist", "wl", "claim"];
  const candidates = abi.filter(
    (i) =>
      i.type === "function" &&
      i.stateMutability !== "view" &&
      i.stateMutability !== "pure" &&
      i.inputs?.some((inp) => inp.type === "bytes32[]")
  );
  if (!candidates.length) return null;
  // Prefer ones whose name looks allowlist-y
  const named = candidates.find((c) => kw.some((k) => c.name.toLowerCase().includes(k.toLowerCase())));
  return named || candidates[0];
}

// ─── Allowlist proof: discover + fetch + compute ─────────────────────────────

// Scan the site blob for a proof API endpoint or a baked-in merkle/allowlist file
export function findAllowlistSources(combined, origin) {
  const apiPaths = new Set();
  const jsonPaths = new Set();

  // fetch("/api/proof?address=" ...) style references
  const pathRe = /["'`](\/[a-z0-9_\-/]*(?:proof|allowlist|allowlist|whitelist|merkle)[a-z0-9_\-/.]*)["'`]/gi;
  let m;
  while ((m = pathRe.exec(combined))) {
    const p = m[1];
    if (p.endsWith(".json")) jsonPaths.add(new URL(p, origin).href);
    else apiPaths.add(new URL(p, origin).href);
  }
  return { apiPaths: [...apiPaths], jsonPaths: [...jsonPaths] };
}

// Try the site's proof API for a given wallet. Returns bytes32[] or null.
async function tryProofApi(apiUrl, address) {
  const attempts = [
    apiUrl, // as-is (might already be a static json)
    `${apiUrl}${apiUrl.includes("?") ? "&" : "?"}address=${address}`,
    `${apiUrl.replace(/\/$/, "")}/${address}`,
    `${apiUrl.replace(/\/$/, "")}/${address}.json`,
  ];
  for (const url of attempts) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(7000) });
      if (!res.ok) continue;
      const json = await res.json();
      const proof = extractProofFromJson(json, address);
      if (proof) return proof;
    } catch {}
  }
  return null;
}

// Dig a bytes32[] proof out of an arbitrary JSON response shape
function extractProofFromJson(json, address) {
  const isProof = (arr) =>
    Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x));

  if (isProof(json)) return json;
  if (json && typeof json === "object") {
    for (const key of ["proof", "merkleProof", "proofs", "data"]) {
      if (isProof(json[key])) return json[key];
      if (json[key] && typeof json[key] === "object" && isProof(json[key].proof)) return json[key].proof;
    }
    // keyed by address: { "0xabc...": ["0x..","0x.."] }
    const lower = address.toLowerCase();
    for (const [k, v] of Object.entries(json)) {
      if (k.toLowerCase() === lower && isProof(v)) return v;
      if (k.toLowerCase() === lower && v && isProof(v.proof)) return v.proof;
    }
  }
  return null;
}

// Local merkle proof computation (OpenZeppelin-style: sorted-pair keccak256, address-only leaf)
export function computeMerkleProof(addresses, target) {
  const leafOf = (a) => ethers.keccak256(ethers.solidityPacked(["address"], [ethers.getAddress(a)]));
  const hashPair = (a, b) => {
    const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    return ethers.keccak256(ethers.concat([x, y]));
  };

  let leaves = addresses.map(leafOf).sort();
  const targetLeaf = leafOf(target);
  let idx = leaves.indexOf(targetLeaf);
  if (idx === -1) return null; // wallet not on the list

  const proof = [];
  while (leaves.length > 1) {
    const next = [];
    for (let i = 0; i < leaves.length; i += 2) {
      if (i + 1 < leaves.length) {
        if (i === idx || i + 1 === idx) {
          proof.push(i === idx ? leaves[i + 1] : leaves[i]);
        }
        next.push(hashPair(leaves[i], leaves[i + 1]));
      } else {
        next.push(leaves[i]); // odd one out, carries up
      }
    }
    idx = Math.floor(idx / 2);
    leaves = next;
  }
  return proof;
}

// Pull a full address list out of a baked-in allowlist json (array of addrs, or {address:...} objects)
function extractAddressList(json) {
  if (Array.isArray(json)) {
    if (json.every((x) => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x))) return json;
    const addrs = json.map((o) => o?.address || o?.addr || o?.wallet).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a || ""));
    if (addrs.length) return addrs;
  }
  if (json && typeof json === "object") {
    const keys = Object.keys(json).filter((k) => /^0x[0-9a-fA-F]{40}$/.test(k));
    if (keys.length) return keys;
    for (const v of Object.values(json)) {
      const nested = extractAddressList(v);
      if (nested) return nested;
    }
  }
  return null;
}

// Get a proof for one wallet: try APIs first, then baked-in lists. Caches the address list.
export async function getAllowlistProof(address, sources, cache) {
  // 1. Proof APIs
  for (const api of sources.apiPaths) {
    const proof = await tryProofApi(api, address);
    if (proof) return { proof, via: "api" };
  }
  // 2. Baked-in json (fetch once, compute locally for every wallet)
  for (const jurl of sources.jsonPaths) {
    if (!cache.lists.has(jurl)) {
      try {
        const res = await fetch(jurl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
        const json = res.ok ? await res.json() : null;
        cache.lists.set(jurl, json ? extractAddressList(json) : null);
      } catch {
        cache.lists.set(jurl, null);
      }
    }
    const list = cache.lists.get(jurl);
    if (list) {
      const proof = computeMerkleProof(list, address);
      if (proof) return { proof, via: "computed" };
    }
  }
  return null;
}

// Build calldata for an allowlist mint fn, mapping qty + proof + address into the right arg slots.
// Returns hex string or null if the arg shape is too exotic.
export function buildAllowlistCalldata(fn, qty, address, proof) {
  if (!fn) return null;
  const iface = new ethers.Interface([fn]);
  const args = fn.inputs.map((inp) => {
    if (inp.type === "bytes32[]") return proof;
    if (inp.type === "address") return address;
    if (inp.type.startsWith("uint")) return qty; // qty / maxAllowance — qty is the safe pick
    if (inp.type === "bool") return true;
    return null;
  });
  if (args.some((a) => a === null)) return null;
  try {
    return iface.encodeFunctionData(fn.name, args);
  } catch {
    return null;
  }
}

// ─── Master entry point ──────────────────────────────────────────────────────

// inspectMint(input, provider, { etherscanApiKey, openseaApiKey })
// Returns a full report the bot can turn into an options menu.
export async function inspectMint(input, provider, opts = {}) {
  const { etherscanApiKey, openseaApiKey } = opts;
  const cls = classifyInput(input);

  let contract = null;
  let siteBlob = null;
  let origin = null;
  let allFound = 0;

  if (cls.kind === "contract") {
    contract = cls.contract;
  } else if (cls.kind === "opensea") {
    contract = await resolveOpenSeaSlug(cls.slug, openseaApiKey);
    if (!contract) throw new Error("Couldn't resolve OpenSea collection — set OPENSEA_API_KEY or paste the contract.");
  } else if (cls.kind === "site") {
    siteBlob = await deepFetchSite(cls.url);
    origin = siteBlob.origin;
    const addrs = extractAddresses(siteBlob.combined);
    allFound = addrs.length;
    if (!addrs.length) throw new Error("No contract addresses found on the page or its scripts.");
    // Pick the NFT contract among candidates
    const checks = await Promise.allSettled(addrs.map(async (a) => ({ a, nft: await isNFTContract(provider, a) })));
    const nfts = checks.filter((r) => r.status === "fulfilled" && r.value.nft).map((r) => r.value.a);
    contract = nfts[0] || addrs[0];
  } else {
    throw new Error("Couldn't understand that input — paste a contract address, Etherscan/OpenSea link, or mint URL.");
  }

  // Core contract intel
  const abi = await fetchABI(contract, etherscanApiKey);
  const mintFn = findBestMintFn(abi);
  const allowFn = findAllowlistMintFn(abi);
  const publicPrice = await readMintPrice(provider, contract, abi);
  const phases = await detectPhases(provider, contract, abi, publicPrice);
  const isNFT = await isNFTContract(provider, contract);

  // SeaDrop on-chain schedule (price + exact start/end times — works pre-launch, Proof-style)
  const seadrop = await readSeadropSchedule(provider, contract);

  // Allowlist sources (only if we read a site)
  let allowlistSources = { apiPaths: [], jsonPaths: [] };
  if (siteBlob) allowlistSources = findAllowlistSources(siteBlob.combined, origin);

  return {
    input,
    kind: cls.kind,
    contract,
    isNFT,
    hasAbi: !!abi,
    abi,
    publicMintFn: mintFn,
    publicSig: mintFn ? mintFnSignature(mintFn) : null,
    allowlistMintFn: allowFn,
    allowlistSig: allowFn ? mintFnSignature(allowFn) : null,
    phases,
    seadrop,
    allowlistSources,
    origin,
    allFound,
  };
}
