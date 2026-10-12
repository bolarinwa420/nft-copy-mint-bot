// Mint diagnoser — works out HOW a whale got a mint through when our copy of it
// reverts. Read-only: it never signs or sends anything. It reports the steps the
// whale took (token bought, approved, burned, spent in the mint) and what the
// same steps would cost us, against the user's prerequisite cap.
//
// Two places a prerequisite shows up on-chain:
//   1. inside the whale's mint tx — a token (or NFT) leaves their wallet there
//   2. before it — they burned / deposited a token in an earlier tx
// Anything else (signature, allowlist, snapshot) leaves no trace and is not
// copyable, which is itself the answer.
import { ethers } from "ethers";
import { RH_EXPLORER_TX, RH_EXPLORER_API, RH_DEX } from "./rhConfig.js";
import { getEthUsdPrice } from "./rhQty.js";

const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const APPROVAL = ethers.id("Approval(address,address,uint256)");
const ERC1155_SINGLE = ethers.id("TransferSingle(address,address,address,uint256,uint256)");
const BURN_SINKS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

// The RH node only serves 30,000 blocks per getLogs when there is no address
// filter, and we can't filter by address — we don't know the token yet. Blocks
// are ~0.1s, so three windows look back roughly two and a half hours.
const LOG_WINDOW = 30_000;
const LOG_WINDOWS = 3;
// Each earlier outflow costs a receipt fetch to classify; only the latest matter.
const MAX_PRIOR_TXS = 8;

const pad = (a) => ethers.zeroPadValue(a, 32).toLowerCase();
const addrOf = (topic) => "0x" + topic.slice(26).toLowerCase();

async function getLogsSafe(provider, filter) {
  try { return await provider.getLogs(filter); } catch { return []; }
}

// Every Transfer/Approval touching the whale in the lookback, oldest first.
async function whaleLogs(provider, whale, toBlock) {
  const calls = [];
  for (let i = 0; i < LOG_WINDOWS; i++) {
    const hi = toBlock - i * LOG_WINDOW;
    const lo = Math.max(0, hi - LOG_WINDOW + 1);
    if (hi < 0) break;
    calls.push(getLogsSafe(provider, { fromBlock: lo, toBlock: hi, topics: [TRANSFER, pad(whale)] }));
    calls.push(getLogsSafe(provider, { fromBlock: lo, toBlock: hi, topics: [TRANSFER, null, pad(whale)] }));
    calls.push(getLogsSafe(provider, { fromBlock: lo, toBlock: hi, topics: [APPROVAL, pad(whale)] }));
  }
  const all = (await Promise.all(calls)).flat();
  return all.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
}

const metaCache = new Map();
async function tokenMeta(provider, token) {
  const k = token.toLowerCase();
  if (metaCache.has(k)) return metaCache.get(k);
  const c = new ethers.Contract(token, [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ], provider);
  const [symbol, decimals] = await Promise.all([
    c.symbol().catch(() => "?"),
    c.decimals().then(Number).catch(() => 18),
  ]);
  // Symbols are attacker-controlled text headed for a Markdown message.
  const meta = { symbol: String(symbol).replace(/[^A-Za-z0-9$.-]/g, "").slice(0, 16) || "?", decimals };
  metaCache.set(k, meta);
  return meta;
}

async function fetchJson(url, ms = 6000) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// What it costs to BUY `amount` of `token` right now. A v2 quote is exact (it
// includes price impact); the explorer price is a spot estimate for tokens that
// only trade in a v4 pool. Returns { usd, eth, route } or null if unpriceable.
async function buyCost(provider, token, amount, decimals, ethUsd) {
  const router = new ethers.Contract(RH_DEX.v2Router, [
    "function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)",
  ], provider);
  const routes = [
    { path: [RH_DEX.weth, token], route: "ETH → token (v2 quote)" },
    { path: [RH_DEX.weth, RH_DEX.usdg, token], route: "ETH → USDG → token (v2 quote)" },
  ];
  for (const { path, route } of routes) {
    try {
      const amounts = await router.getAmountsIn(amount, path);
      const eth = amounts[0];
      return { eth, usd: Number(ethers.formatEther(eth)) * ethUsd, route };
    } catch {}
  }
  const info = await fetchJson(`${RH_EXPLORER_API}/tokens/${token}`);
  const rate = Number(info?.exchange_rate);
  if (rate > 0) {
    const usd = rate * Number(ethers.formatUnits(amount, decimals));
    return { eth: null, usd, route: "explorer spot price (no v2 route — likely a v4 pool)" };
  }
  return null;
}

// The whale's last few txs up to the mint, for context. Explorer-only and
// best-effort: it lists the latest 50, so it is empty for old mints.
async function recentTxs(whale, mintBlock, mintHash) {
  const d = await fetchJson(`${RH_EXPLORER_API}/addresses/${whale}/transactions?filter=from`);
  if (!d?.items) return [];
  return d.items
    .filter((t) => t.block_number && t.block_number <= mintBlock && t.hash !== mintHash)
    .slice(0, 5)
    .map((t) => ({
      hash: t.hash,
      to: t.to?.hash || null,
      toName: t.to?.name || null,
      method: t.method || (t.raw_input || "0x").slice(0, 10),
    }));
}

/**
 * Work out what the whale did to make `hash` succeed.
 * `to` is the contract the mint was sent to; `nft` the collection if different.
 * Returns a plain result object — see formatRhDiagnosis for the readable form.
 */
export async function diagnoseRhMint({ hash, from, to, nft }, provider, { capUsd = 1.2 } = {}) {
  const whale = from.toLowerCase();
  const targets = new Set([to, nft].filter(Boolean).map((a) => a.toLowerCase()));

  const rcpt = await provider.getTransactionReceipt(hash);
  if (!rcpt) return { ok: false, error: "whale receipt not available" };
  const mintBlock = rcpt.blockNumber;

  const result = {
    ok: true, hash, whale, capUsd,
    whaleReverted: rcpt.status === 0,
    steps: [],       // chronological, human-readable
    needs: [],       // [{ token, symbol, decimals, amount, cost }] — what we'd have to buy
    nftNeeds: [],    // NFTs the whale gave up — not buyable by this module
    recent: [],
    totalUsd: null, withinCap: null, verdict: "",
    // Machine-readable version of `steps`, for the replicator (rhReplicate.js).
    plan: { buyTxs: {}, approvals: [], priorTxs: [] },
  };
  if (result.whaleReverted) {
    result.verdict = "The whale's own mint REVERTED — there is nothing to copy.";
    return result;
  }

  const [logs, ethUsd, recent] = await Promise.all([
    whaleLogs(provider, whale, mintBlock),
    getEthUsdPrice(),
    recentTxs(whale, mintBlock, hash),
  ]);
  result.recent = recent;

  const need = new Map();   // token → total raw amount the whale gave up
  const addNeed = (token, amount) => need.set(token, (need.get(token) || 0n) + amount);
  const spendSteps = [];

  // ── 1. inside the mint tx ──
  for (const log of rcpt.logs) {
    const token = log.address.toLowerCase();
    if (log.topics[0] === TRANSFER && addrOf(log.topics[1]) === whale) {
      const sink = addrOf(log.topics[2]);
      if (log.topics.length === 3) {
        const amount = BigInt(log.data);
        if (amount === 0n) continue;
        addNeed(token, amount);
        spendSteps.push({ block: mintBlock, kind: "spent in the mint", token, amount, sink, hash });
      } else if (log.topics.length === 4) {
        result.nftNeeds.push({ token, id: BigInt(log.topics[3]).toString(), sink, hash, when: "in the mint" });
      }
    } else if (log.topics[0] === ERC1155_SINGLE && log.topics.length === 4 && addrOf(log.topics[2]) === whale) {
      result.nftNeeds.push({ token, id: "(ERC-1155)", sink: addrOf(log.topics[3]), hash, when: "in the mint" });
    }
  }

  // ── 2. before the mint ──
  // An earlier outflow only counts as a prerequisite when the token was burned,
  // or it went to the mint contract — a plain sell into a pool is neither.
  const prior = logs.filter((l) => l.transactionHash !== hash && l.topics[0] === TRANSFER && addrOf(l.topics[1]) === whale);
  const priorTxs = [...new Set(prior.map((l) => l.transactionHash))].slice(-MAX_PRIOR_TXS);
  const priorRcpts = new Map(await Promise.all(priorTxs.map(async (h) => {
    try { return [h, await provider.getTransactionReceipt(h)]; } catch { return [h, null]; }
  })));

  for (const log of prior) {
    const r = priorRcpts.get(log.transactionHash);
    if (!r) continue;
    const token = log.address.toLowerCase();
    const sink = addrOf(log.topics[2]);
    const txTo = (r.to || "").toLowerCase();
    // Burned directly, or handed to a helper contract that burned it in the same tx.
    const burned = BURN_SINKS.has(sink) || r.logs.some((x) =>
      x.address.toLowerCase() === token && x.topics[0] === TRANSFER && x.topics.length === log.topics.length &&
      BURN_SINKS.has(addrOf(x.topics[2])));
    const toMint = targets.has(sink) || targets.has(txTo);
    if (!burned && !toMint) continue;

    if (log.topics.length === 3) {
      const amount = BigInt(log.data);
      if (amount === 0n) continue;
      addNeed(token, amount);
      spendSteps.push({
        block: log.blockNumber, token, amount, sink, hash: log.transactionHash,
        kind: burned ? (toMint ? "burned via the mint contract" : "burned") : "sent to the mint contract",
        via: txTo && txTo !== sink ? txTo : null, txTo,
      });
    } else if (log.topics.length === 4) {
      result.nftNeeds.push({ token, id: BigInt(log.topics[3]).toString(), sink, hash: log.transactionHash, when: burned ? "burned earlier" : "sent earlier" });
    }
  }

  // ── 3. how the whale got each token, and what it would cost us ──
  for (const [token, amount] of need) {
    const meta = await tokenMeta(provider, token);
    let fillEth = 0n, fillGot = 0n;   // what the whale's own ETH buys of this token paid

    const buys = logs.filter((l) => l.address.toLowerCase() === token && l.topics[0] === TRANSFER &&
      l.topics.length === 3 && addrOf(l.topics[2]) === whale && l.transactionHash !== hash);
    const buyHashes = [...new Set(buys.map((l) => l.transactionHash))].slice(-3);
    result.plan.buyTxs[token] = [...buyHashes].reverse();   // newest first
    for (const h of buyHashes) {
      const got = buys.filter((l) => l.transactionHash === h).reduce((s, l) => s + BigInt(l.data), 0n);
      let paid = "";
      try {
        const tx = await provider.getTransaction(h);
        if (tx?.from?.toLowerCase() === whale && tx.value > 0n) {
          paid = ` for ${fmtEth(tx.value)} ETH`;
          fillEth += tx.value; fillGot += got;
        } else {
          // Paid in another token (e.g. USDG): it left the whale in the same tx.
          const out = logs.find((l) => l.transactionHash === h && l.topics[0] === TRANSFER && l.topics.length === 3 &&
            addrOf(l.topics[1]) === whale && l.address.toLowerCase() !== token);
          if (out) {
            const m = await tokenMeta(provider, out.address);
            paid = ` for ${fmtAmt(BigInt(out.data), m.decimals)} ${m.symbol}`;
          }
        }
      } catch {}
      const block = buys.find((l) => l.transactionHash === h).blockNumber;
      result.steps.push({ block, text: `Got ${fmtAmt(got, meta.decimals)} ${meta.symbol}${paid}`, hash: h });
    }

    // No live quote → fall back to the rate the whale themselves just paid.
    let cost = await buyCost(provider, token, amount, meta.decimals, ethUsd);
    if (!cost && fillGot > 0n) {
      const eth = (fillEth * amount) / fillGot;
      cost = { eth, usd: Number(ethers.formatEther(eth)) * ethUsd, route: "at the whale's own fill price (no live quote)" };
    }
    result.needs.push({ token, ...meta, amount, cost });

    for (const l of logs) {
      if (l.topics[0] !== APPROVAL || l.topics.length !== 3 || l.address.toLowerCase() !== token) continue;
      result.steps.push({ block: l.blockNumber, text: `Approved ${meta.symbol} to \`${addrOf(l.topics[2])}\``, hash: l.transactionHash });
      result.plan.approvals.push({ token, spender: addrOf(l.topics[2]), logged: true });
    }
  }

  // Whoever pulled the token must have been approved, even if that approval is
  // older than the lookback: the mint contract, or the contract of the earlier tx.
  for (const s of spendSteps) {
    const spender = s.hash === hash ? to.toLowerCase() : s.txTo;
    if (spender && spender !== s.token) result.plan.approvals.push({ token: s.token, spender, logged: false });
  }
  result.plan.priorTxs = [...new Set(spendSteps.filter((s) => s.hash !== hash)
    .sort((a, b) => a.block - b.block).map((s) => s.hash))];

  for (const s of spendSteps) {
    const meta = await tokenMeta(provider, s.token);
    result.steps.push({
      block: s.block, hash: s.hash,
      text: `${fmtAmt(s.amount, meta.decimals)} ${meta.symbol} ${s.kind}` + (s.via ? ` (through \`${s.via}\`)` : ""),
    });
  }
  result.steps.sort((a, b) => a.block - b.block);

  // ── verdict ──
  if (result.nftNeeds.length) {
    result.verdict = "The whale gave up an NFT to mint — we'd need to own one from that collection. Not auto-copyable.";
  } else if (!result.needs.length) {
    result.verdict = "No token or NFT prerequisite on-chain in the whale's last ~2.5h. Most likely wallet-bound " +
      "(allowlist, signature, snapshot) or the drop closed between their mint and ours.";
  } else if (result.needs.some((n) => !n.cost)) {
    result.verdict = "Token prerequisite found but it can't be priced (no v2 route, no explorer price, no whale buy to go by). Check the pool by hand.";
  } else {
    result.totalUsd = result.needs.reduce((s, n) => s + n.cost.usd, 0);
    result.withinCap = result.totalUsd <= capUsd;
    result.verdict = result.withinCap
      ? `Copyable: about $${result.totalUsd.toFixed(2)} of token per wallet — inside the $${capUsd.toFixed(2)} cap.`
      : `Too expensive: about $${result.totalUsd.toFixed(2)} of token per wallet — over the $${capUsd.toFixed(2)} cap.`;
  }
  return result;
}

function fmtEth(wei) { return (+ethers.formatEther(wei)).toPrecision(4).replace(/\.?0+$/, ""); }
function fmtAmt(raw, decimals) {
  const n = Number(ethers.formatUnits(raw, decimals));
  return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toPrecision(3);
}

// Telegram-Markdown rendering of a diagnosis. Addresses are never shortened.
export function formatRhDiagnosis(r, { revert } = {}) {
  if (!r.ok) return `🔎 *RH mint diagnosis failed* — ${r.error}`;
  const link = (h) => `[tx](${RH_EXPLORER_TX}${h})`;
  const lines = [
    `🔎 *How the whale minted*`,
    `Whale: \`${r.whale}\` · ${link(r.hash)}`,
  ];
  if (revert) lines.push(`Our copy reverted: \`${String(revert).replace(/`/g, "'")}\``);

  if (r.steps.length) {
    lines.push("", "*What they did, in order:*");
    r.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.text} · ${link(s.hash)}`));
  }
  if (r.needs.length) {
    lines.push("", "*To copy it, one wallet needs:*");
    for (const n of r.needs) {
      const cost = n.cost ? `≈ $${n.cost.usd.toFixed(2)} — ${n.cost.route}` : "price unknown";
      lines.push(`• ${fmtAmt(n.amount, n.decimals)} ${n.symbol} \`${n.token}\`\n   ${cost}`);
    }
  }
  for (const n of r.nftNeeds) {
    lines.push(`• NFT #${n.id} from \`${n.token}\` (${n.when}) · ${link(n.hash)}`);
  }
  if (r.recent.length) {
    lines.push("", "*Their last txs before it:*");
    for (const t of r.recent) {
      const method = String(t.method).replace(/[^A-Za-z0-9]/g, "");
      const name = t.toName ? ` (${String(t.toName).replace(/[^A-Za-z0-9 ]/g, "")})` : "";
      lines.push(`• ${method} → \`${t.to}\`${name} · ${link(t.hash)}`);
    }
  }
  const icon = r.withinCap === true ? "✅" : r.withinCap === false ? "⛔" : "ℹ️";
  lines.push("", `${icon} ${r.verdict}`);
  return lines.join("\n");
}

// Auto-diagnosis from the executor's failure paths. One whale mint can fail for
// 100 wallets and several whales can hit the same dead drop, so a contract is
// only diagnosed once per cooldown.
const COOLDOWN_MS = 10 * 60_000;
const lastDiagnosed = new Map();
// Reverts that already explain themselves: we were late, not missing a step.
const SELF_EXPLAINED = /MaxSupply|MaxTokenSupplyForStage|sold ?out|NotActive/i;

export async function diagnoseAndNotify({ whaleTx, nft, revert }, provider, notify, capUsd) {
  if (revert && SELF_EXPLAINED.test(String(revert))) return null;
  const key = (nft || whaleTx.to || "").toLowerCase();
  const now = Date.now();
  if (now - (lastDiagnosed.get(key) || 0) < COOLDOWN_MS) return null;
  lastDiagnosed.set(key, now);
  try {
    const r = await diagnoseRhMint({ hash: whaleTx.hash, from: whaleTx.from, to: whaleTx.to, nft }, provider, { capUsd });
    await notify(formatRhDiagnosis(r, { revert }), null);
    return r;
  } catch (e) {
    console.warn("[RH] diagnosis error:", e.message);
    return null;
  }
}
