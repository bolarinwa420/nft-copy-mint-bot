// Mint replicator — takes a diagnosis (rhDiagnose.js) and replays the whale's
// whole path from the MAIN wallet: buy the token they bought, approve what they
// approved, repeat their burn/deposit tx, then send their mint.
//
// The safety model is one rule: nothing is sent unless the ENTIRE chain, run in
// order on the node (eth_simulateV1) from our own address, ends with the NFT
// landing in our wallet. A path we can't reproduce costs an RPC call, not money.
// On top of that: main wallet only, token spend held to prereqCapUsd, one replay
// per contract, prereqDailyMax replays per day, and nothing at all in dry run.
//
// The token is bought the way the whale bought it: the pools are read out of
// their buy tx (v2, v3 and v4 hops alike) and re-routed through the Universal
// Router. If they didn't buy it inside the lookback, a plain v2 / native-v4 route
// is tried instead.
import { ethers } from "ethers";
import { RH_DEX, RH_EXPLORER_TX } from "./rhConfig.js";
import { getEthUsdPrice } from "./rhQty.js";
import { getRhSettings, getRhReplicated, logRhReplicated, logRhMint } from "./rhStore.js";
import { diagnoseAndNotify } from "./rhDiagnose.js";

const abi = ethers.AbiCoder.defaultAbiCoder();
const NATIVE = ethers.ZeroAddress;
const WETH = RH_DEX.weth.toLowerCase();

const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const ERC1155_SINGLE = ethers.id("TransferSingle(address,address,address,uint256,uint256)");
const ERC1155_BATCH = ethers.id("TransferBatch(address,address,address,uint256[],uint256[])");
const V2_SWAP = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const V3_SWAP = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const V4_SWAP = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const V4_INIT = ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const iInit = new ethers.Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const iErc20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const iRouter = new ethers.Interface([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
const iV2Router = new ethers.Interface([
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
]);

// Universal Router commands, v4 actions and the router's magic values.
const CMD = { V3_IN: 0x00, SWEEP: 0x04, V2_IN: 0x08, WRAP: 0x0b, UNWRAP: 0x0c, V4: 0x10 };
const ACT = { SWAP_IN_SINGLE: 0x06, SETTLE: 0x0b, TAKE: 0x0e };
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const CONTRACT_BALANCE = 1n << 255n;   // "everything the router is holding"
const OPEN_DELTA = 0n;                 // "everything the pool owes / is owed"
const POOLKEY = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";

// The RH node serves 10M blocks per getLogs when the address is fixed.
const LOG_SPAN = 10_000_000;
const u8 = (n) => ethers.toBeHex(n, 1);
const pad = (a) => ethers.zeroPadValue(a, 32).toLowerCase();
const lc = (a) => a.toLowerCase();
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

// ── simulation ──────────────────────────────────────────────────────────────

// Run `calls` back to back on top of the latest block, with the sender given a
// fat balance for the run so "the path works" and "the wallet can afford it"
// are answered separately.
async function simulate(provider, from, calls) {
  const block = {
    stateOverrides: { [from]: { balance: ethers.toQuantity(ethers.parseEther("1000")) } },
    calls: calls.map((c) => ({
      from, to: c.to, data: c.data || "0x", value: ethers.toQuantity(c.value || 0n),
    })),
  };
  const out = await provider.send("eth_simulateV1", [{ blockStateCalls: [block] }, "latest"]);
  return out[0].calls.map((c) => ({
    ok: c.status === "0x1",
    returnData: c.returnData,
    logs: c.logs || [],
    error: c.error?.message || null,
    gasUsed: BigInt(c.gasUsed || 0),
  }));
}

// ── route building ──────────────────────────────────────────────────────────

// Every 10M-block span from the head back to genesis.
function logSpans(head) {
  const spans = [];
  for (let hi = head; hi > 0; hi -= LOG_SPAN) spans.push({ fromBlock: Math.max(0, hi - LOG_SPAN + 1), toBlock: hi });
  return spans;
}

const v4Keys = new Map();   // poolId → PoolKey (a pool's key never changes)
async function v4KeyFromId(provider, poolId, head) {
  if (v4Keys.has(poolId)) return v4Keys.get(poolId);
  const found = (await Promise.all(logSpans(head).map((span) =>
    provider.getLogs({ address: RH_DEX.poolManager, topics: [V4_INIT, poolId], ...span }).catch(() => [])))).flat();
  if (!found.length) return null;
  const a = iInit.parseLog(found[0]).args;
  const key = { currency0: lc(a.currency0), currency1: lc(a.currency1), fee: Number(a.fee), tickSpacing: Number(a.tickSpacing), hooks: lc(a.hooks) };
  v4Keys.set(poolId, key);
  return key;
}

// Every swap in a tx as a directed edge { kind, tokenIn, tokenOut, … }.
async function swapEdges(provider, txHash, head) {
  const rcpt = await provider.getTransactionReceipt(txHash);
  if (!rcpt) return [];
  const edges = [], seen = new Set();
  const add = (e) => {
    const k = `${e.kind}:${e.id}:${e.tokenIn}`;
    if (!seen.has(k)) { seen.add(k); edges.push(e); }
  };
  const pairAbi = ["function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)"];

  for (const log of rcpt.logs) {
    const t0 = log.topics[0];
    try {
      if (t0 === V4_SWAP && lc(log.address) === lc(RH_DEX.poolManager)) {
        const key = await v4KeyFromId(provider, log.topics[1], head);
        if (!key) continue;
        const [a0] = abi.decode(["int128", "int128"], ethers.dataSlice(log.data, 0, 64));
        // v4 reports the swapper's side: negative is what they paid in.
        const zeroForOne = a0 < 0n;
        add({ kind: "v4", id: log.topics[1], key, zeroForOne,
          tokenIn: zeroForOne ? key.currency0 : key.currency1, tokenOut: zeroForOne ? key.currency1 : key.currency0 });
      } else if (t0 === V3_SWAP) {
        const c = new ethers.Contract(log.address, pairAbi, provider);
        const [tok0, tok1, fee] = await Promise.all([c.token0(), c.token1(), c.fee()]);
        const [a0] = abi.decode(["int256", "int256"], ethers.dataSlice(log.data, 0, 64));
        // v3 reports the pool's side: positive is what the pool received.
        const zeroForOne = a0 > 0n;
        add({ kind: "v3", id: lc(log.address), fee: Number(fee),
          tokenIn: lc(zeroForOne ? tok0 : tok1), tokenOut: lc(zeroForOne ? tok1 : tok0) });
      } else if (t0 === V2_SWAP) {
        const c = new ethers.Contract(log.address, pairAbi, provider);
        const [tok0, tok1] = await Promise.all([c.token0(), c.token1()]);
        const [in0] = abi.decode(["uint256"], ethers.dataSlice(log.data, 0, 32));
        const zeroForOne = in0 > 0n;
        add({ kind: "v2", id: lc(log.address),
          tokenIn: lc(zeroForOne ? tok0 : tok1), tokenOut: lc(zeroForOne ? tok1 : tok0) });
      }
    } catch {}
  }
  return edges;
}

// Shortest chain of those edges from native ETH to `token`. Wrapping and
// unwrapping are free hops, so a WETH-paired pool is reachable too.
function findPath(edges, token) {
  const all = [
    ...edges,
    { kind: "wrap", tokenIn: NATIVE, tokenOut: WETH },
    { kind: "unwrap", tokenIn: WETH, tokenOut: NATIVE },
  ];
  const queue = [[NATIVE, []]];
  const visited = new Set([NATIVE]);
  while (queue.length) {
    const [at, path] = queue.shift();
    if (at === token) return path;
    for (const e of all) {
      if (e.tokenIn !== at || visited.has(e.tokenOut)) continue;
      visited.add(e.tokenOut);
      queue.push([e.tokenOut, [...path, e]]);
    }
  }
  return null;
}

// Universal Router calldata that walks `path` with `ethIn`. Every hop pays from
// the router's own balance and leaves its output there; the final SWEEP hands
// the token to us and reverts the lot if it is less than `minOut`.
function encodePath(path, token, ethIn, minOut) {
  const commands = [], inputs = [];
  for (const e of path) {
    if (e.kind === "wrap") {
      commands.push(u8(CMD.WRAP));
      inputs.push(abi.encode(["address", "uint256"], [ADDRESS_THIS, CONTRACT_BALANCE]));
    } else if (e.kind === "unwrap") {
      commands.push(u8(CMD.UNWRAP));
      inputs.push(abi.encode(["address", "uint256"], [ADDRESS_THIS, 0n]));
    } else if (e.kind === "v3") {
      commands.push(u8(CMD.V3_IN));
      inputs.push(abi.encode(["address", "uint256", "uint256", "bytes", "bool"], [
        ADDRESS_THIS, CONTRACT_BALANCE, 0n,
        ethers.solidityPacked(["address", "uint24", "address"], [e.tokenIn, e.fee, e.tokenOut]), false,
      ]));
    } else if (e.kind === "v2") {
      commands.push(u8(CMD.V2_IN));
      inputs.push(abi.encode(["address", "uint256", "uint256", "address[]", "bool"], [
        ADDRESS_THIS, CONTRACT_BALANCE, 0n, [e.tokenIn, e.tokenOut], false,
      ]));
    } else if (e.kind === "v4") {
      const k = e.key;
      const actions = ethers.concat([u8(ACT.SETTLE), u8(ACT.SWAP_IN_SINGLE), u8(ACT.TAKE)]);
      const params = [
        abi.encode(["address", "uint256", "bool"], [e.tokenIn, CONTRACT_BALANCE, false]),
        // This chain's router takes the newer struct, with a per-hop price floor
        // (0 = off) ahead of hookData; the older 5-field layout reverts empty.
        abi.encode([`tuple(${POOLKEY} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)`],
          [[[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks], e.zeroForOne, OPEN_DELTA, 0n, 0n, "0x"]]),
        abi.encode(["address", "address", "uint256"], [e.tokenOut, ADDRESS_THIS, OPEN_DELTA]),
      ];
      commands.push(u8(CMD.V4));
      inputs.push(abi.encode(["bytes", "bytes[]"], [actions, params]));
    }
  }
  commands.push(u8(CMD.SWEEP));
  inputs.push(abi.encode(["address", "address", "uint256"], [token, MSG_SENDER, minOut]));
  return {
    to: RH_DEX.universalRouter, value: ethIn,
    data: iRouter.encodeFunctionData("execute", [ethers.concat(commands), inputs, deadline()]),
  };
}

const describePath = (path) => path.map((e) => e.kind).join(" → ");

// Candidate ways to buy `token`, best guess first, as { label, build(ethIn, minOut, me) }.
// Lazy: the fallbacks cost extra log scans, so they only run if the whale's route fails.
async function* candidateRoutes(provider, token, buyTxs, head) {
  for (const h of buyTxs.slice(0, 2)) {
    const path = findPath(await swapEdges(provider, h, head), token);
    if (path?.length) {
      yield { label: `the whale's own route (${describePath(path)})`, build: (ethIn, minOut) => encodePath(path, token, ethIn, minOut) };
      break;
    }
  }
  for (const [p, label] of [[[RH_DEX.weth, token], "v2 ETH → token"], [[RH_DEX.weth, RH_DEX.usdg, token], "v2 ETH → USDG → token"]]) {
    yield { label, build: (ethIn, minOut, me) => ({
      to: RH_DEX.v2Router, value: ethIn,
      data: iV2Router.encodeFunctionData("swapExactETHForTokensSupportingFeeOnTransferTokens", [minOut, p, me, deadline()]),
    }) };
  }
  // Deepest hook-free native v4 pool, if the token has one.
  try {
    const logs = (await Promise.all(logSpans(head).map((span) =>
      provider.getLogs({ address: RH_DEX.poolManager, topics: [V4_INIT, null, pad(NATIVE), pad(token)], ...span }).catch(() => [])))).flat();
    const stateView = new ethers.Contract(RH_DEX.stateView, ["function getLiquidity(bytes32) view returns (uint128)"], provider);
    let best = null;
    for (const log of logs.slice(0, 20)) {
      const a = iInit.parseLog(log).args;
      if (a.hooks !== NATIVE) continue;
      const liq = await stateView.getLiquidity(a.id).catch(() => 0n);
      if (liq > 0n && (!best || liq > best.liq)) best = { liq, key: { currency0: NATIVE, currency1: token, fee: Number(a.fee), tickSpacing: Number(a.tickSpacing), hooks: NATIVE } };
    }
    if (best) {
      const path = [{ kind: "v4", key: best.key, zeroForOne: true, tokenIn: NATIVE, tokenOut: token }];
      yield { label: "v4 ETH → token", build: (ethIn, minOut) => encodePath(path, token, ethIn, minOut) };
    }
  } catch {}
}

// Tokens `me` would receive for `ethIn` down this route, or null if it reverts.
async function quote(provider, me, token, route, ethIn) {
  const bal = { to: token, data: iErc20.encodeFunctionData("balanceOf", [me]) };
  try {
    const r = await simulate(provider, me, [bal, route.build(ethIn, 0n, me), bal]);
    if (!r[1].ok) return null;
    return BigInt(r[2].returnData) - BigInt(r[0].returnData);
  } catch { return null; }
}

// Smallest ETH amount, never above `capEth`, that buys at least `need` of `token`.
// Returns { route, ethIn } or { error }.
async function planBuy(provider, me, token, need, buyTxs, capEth, head) {
  let tooDear = null;
  for await (const route of candidateRoutes(provider, token, buyTxs, head)) {
    const atCap = await quote(provider, me, token, route, capEth);
    if (atCap == null || atCap === 0n) continue;
    if (atCap < need) { if (!tooDear || atCap > tooDear.got) tooDear = { route, got: atCap }; continue; }
    // Smaller buys move the price less, so scaling down from the cap quote
    // overshoots slightly — which is the side we want to err on.
    const est = (capEth * need) / atCap;
    for (const ethIn of [(est * 104n) / 100n, (est * 115n) / 100n, capEth]) {
      const capped = ethIn > capEth ? capEth : ethIn;
      const out = await quote(provider, me, token, route, capped);
      if (out != null && out >= need) return { route, ethIn: capped };
    }
  }
  if (tooDear) return { error: `over the cap — the full cap only buys ${((Number(tooDear.got) / Number(need)) * 100).toFixed(1)}% of what's needed (${tooDear.route.label})` };
  return { error: "no route to buy the token simulates (tried the whale's route, v2 and native v4)" };
}

// ── the plan ────────────────────────────────────────────────────────────────

// Did this simulated call mint an NFT of one of `nfts` to `me`?
function mintedTo(logs, me, nfts) {
  const mine = pad(me), zero = pad(NATIVE);
  return logs.some((l) => {
    if (!nfts.has(lc(l.address))) return false;
    if (l.topics[0] === TRANSFER && l.topics.length === 4) return l.topics[1] === zero && l.topics[2] === mine;
    if (l.topics[0] === ERC1155_SINGLE || l.topics[0] === ERC1155_BATCH) return l.topics[2] === zero && l.topics[3] === mine;
    return false;
  });
}

/**
 * Build the whale's path for our wallet and prove it on the node.
 * Returns { ok, steps, buyEth, buyUsd, nativeValue, needWei, balance, funded } or
 * { ok: false, error }. Each step is { label, tx: { to, data, value }, gasLimit }.
 */
export async function planReplication(diag, whaleTx, provider, me, s) {
  if (!diag?.ok || diag.whaleReverted) return { ok: false, error: "nothing to replay" };
  if (diag.nftNeeds.length) return { ok: false, error: "the whale gave up an NFT — we don't hold one" };
  if (!diag.needs.length) return { ok: false, error: "no token prerequisite found — nothing to replay" };

  const whale = diag.whale.slice(2);
  const mine = lc(me).slice(2);
  // Calldata often names the caller (recipient, referrer…) — point it at us.
  const retarget = (data) => (data || "0x").toLowerCase().replaceAll(whale, mine);
  const [head, ethUsd] = await Promise.all([provider.getBlockNumber(), getEthUsdPrice()]);
  if (!(ethUsd > 0)) return { ok: false, error: "no ETH price — can't apply the $ cap" };

  // 1. buys — the cap covers ALL tokens together, not each one.
  let capLeft = ethers.parseEther((s.prereqCapUsd / ethUsd).toFixed(18));
  const steps = [];
  let buyEth = 0n;
  for (const n of diag.needs) {
    const have = BigInt(await provider.call({ to: n.token, data: iErc20.encodeFunctionData("balanceOf", [me]) }).catch(() => "0x0"));
    if (have >= n.amount) continue;
    const short = n.amount - have;
    if (capLeft <= 0n) return { ok: false, error: `over the $${s.prereqCapUsd} cap` };
    const buy = await planBuy(provider, me, n.token, short, diag.plan.buyTxs[n.token] || [], capLeft, head);
    if (buy.error) return { ok: false, error: `${n.symbol}: ${buy.error}` };
    capLeft -= buy.ethIn; buyEth += buy.ethIn;
    steps.push({ label: `Buy ${n.symbol} via ${buy.route.label}`, tx: buy.route.build(buy.ethIn, short, me) });
  }

  // 2. the whale's earlier burn/deposit txs, then the mint itself.
  const replay = [];
  for (const h of diag.plan.priorTxs) {
    const tx = await provider.getTransaction(h);
    if (!tx?.to) return { ok: false, error: "an earlier whale tx could not be read" };
    replay.push({ label: `Repeat the whale's earlier tx on \`${lc(tx.to)}\``, tx: { to: tx.to, data: retarget(tx.data), value: tx.value } });
  }
  const mintValue = BigInt(whaleTx.value || 0);
  replay.push({ label: "Mint", tx: { to: whaleTx.to, data: retarget(whaleTx.input || whaleTx.data), value: mintValue } });

  const nativeValue = replay.reduce((sum, r) => sum + r.tx.value, 0n);
  const hardCap = ethers.parseEther(String(s.maxMintNative || "0"));
  if (hardCap > 0n && nativeValue > hardCap) {
    return { ok: false, error: `the mint itself costs ${ethers.formatEther(nativeValue)} ETH — over the ${s.maxMintNative} hard cap` };
  }

  // 3. approvals. Only the exact amount needed, and first only to the contracts
  // that took the token; if that isn't enough, everything the whale approved.
  const needOf = new Map(diag.needs.map((n) => [n.token, n]));
  const approvalSteps = (list) => {
    const seen = new Set();
    return list.filter((a) => needOf.has(a.token) && !seen.has(a.token + a.spender) && seen.add(a.token + a.spender))
      .map((a) => ({
        label: `Approve ${needOf.get(a.token).symbol} to \`${a.spender}\``,
        tx: { to: a.token, data: iErc20.encodeFunctionData("approve", [a.spender, needOf.get(a.token).amount]), value: 0n },
      }));
  };
  const takers = new Set(diag.plan.approvals.filter((a) => !a.logged).map((a) => a.token + a.spender));
  const variants = [
    approvalSteps(diag.plan.approvals.filter((a) => takers.has(a.token + a.spender))),
    approvalSteps(diag.plan.approvals),
  ];

  const nfts = new Set([whaleTx.to, diag.nft].filter(Boolean).map(lc));
  let lastError = "the replay did not simulate";
  for (const approvals of variants) {
    const all = [...steps, ...approvals, ...replay];
    let sim;
    try { sim = await simulate(provider, me, all.map((x) => x.tx)); }
    catch (e) { return { ok: false, error: `simulation unavailable: ${e.shortMessage || e.message}` }; }
    const bad = sim.findIndex((c) => !c.ok);
    if (bad >= 0) { lastError = `step ${bad + 1} (${all[bad].label}) reverts: ${sim[bad].error || "no reason"}`; continue; }
    if (!mintedTo(sim[sim.length - 1].logs, me, nfts)) { lastError = "the replay runs but no NFT lands in our wallet"; continue; }

    const gas = sim.reduce((sum, c) => sum + c.gasUsed, 0n);
    const [balance, fee] = await Promise.all([provider.getBalance(me), provider.getFeeData().catch(() => ({}))]);
    const needWei = buyEth + nativeValue + gas * 2n * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
    all.forEach((x, i) => { x.gasLimit = (sim[i].gasUsed * 150n) / 100n + 50_000n; });
    return {
      ok: true, steps: all, buyEth, nativeValue, needWei, balance,
      buyUsd: Number(ethers.formatEther(buyEth)) * ethUsd,
      funded: balance >= needWei,
    };
  }
  return { ok: false, error: lastError };
}

// Telegram-Markdown report of a plan. Addresses are never shortened.
export function formatReplication(plan, me, contract) {
  if (!plan.ok) return `🔁 *RH replay not possible*\n${plan.error}\nContract: \`${contract}\``;
  const list = plan.steps.map((x, i) => `${i + 1}. ${x.label}`).join("\n");
  return (
    `🔁 *RH replay plan — proven by simulation*\n` +
    `Run in this order from \`${me}\`, the whale's path ends with the NFT in our wallet:\n${list}\n` +
    `Token: ≈ $${plan.buyUsd.toFixed(2)} (${ethers.formatEther(plan.buyEth)} ETH) · mint: ${ethers.formatEther(plan.nativeValue)} ETH\n` +
    (plan.funded ? "Wallet can afford it." : `Wallet is short: needs ${ethers.formatEther(plan.needWei)} ETH, has ${ethers.formatEther(plan.balance)}.`) +
    `\nContract: \`${contract}\``
  );
}

function mainSigner(provider) {
  try { return new ethers.Wallet(process.env.MAIN_PRIVATE_KEY, provider); } catch { return null; }
}

// Current fees, clamped to the user's gas ceiling like every other RH send.
async function gasFees(provider, ceilingGwei) {
  let fee;
  try { fee = await provider.getFeeData(); } catch { fee = {}; }
  const ceiling = ethers.parseUnits(String(ceilingGwei), "gwei");
  if (fee.maxFeePerGas) {
    const maxFee = fee.maxFeePerGas < ceiling ? fee.maxFeePerGas : ceiling;
    const tip = fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas < maxFee ? fee.maxPriorityFeePerGas : 0n;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
  }
  return { gasPrice: fee.gasPrice && fee.gasPrice < ceiling ? fee.gasPrice : ceiling };
}

const day = (ts) => new Date(ts).toISOString().slice(0, 10);
const clean = (e) => String(e.shortMessage || e.message).replace(/`/g, "'").slice(0, 200);

// Send a proven plan one step at a time, each confirmed before the next.
async function sendPlan(plan, signer, me, contract, provider, notify, s) {
  const fees = await gasFees(provider, s.gasCeilingGwei);
  const done = [];
  for (const [i, step] of plan.steps.entries()) {
    try {
      // The plan was proven as a whole; re-check each later step against real
      // state right before paying for it, since the drop can close under us.
      // (Step 1 is the buy, which protects itself with a minimum-out.)
      if (i > 0) await provider.call({ ...step.tx, from: me });
      const resp = await signer.sendTransaction({ ...step.tx, ...fees, gasLimit: step.gasLimit });
      const rcpt = await resp.wait(1);
      done.push(`${i + 1}. ${step.label} · [tx](${RH_EXPLORER_TX}${resp.hash})`);
      if (rcpt?.status !== 1) throw new Error("reverted on-chain");
      if (i === plan.steps.length - 1) await logRhMint({ contract, wallet: me, txHash: resp.hash, valueNative: step.tx.value.toString() });
    } catch (e) {
      return notify(
        `🔁 *RH replay stopped at step ${i + 1}* (${step.label})\n\`${clean(e)}\`\n` +
        (done.length ? `\nAlready done:\n${done.join("\n")}\n\nAnything bought is still in \`${me}\`.` : "\nNothing was spent.") +
        `\nContract: \`${contract}\``, null);
    }
  }
  await notify(
    `✅ *RH replay minted*\nWallet: \`${me}\`\n${done.join("\n")}\n` +
    `Token: ≈ $${plan.buyUsd.toFixed(2)} · mint: ${ethers.formatEther(plan.nativeValue)} ETH\nContract: \`${contract}\``, null);
}

/**
 * Plan the replay of `whaleTx`, report it, and — when `send` is set and the bot
 * is live — carry it out. `manual` (someone typing /rhcopy) ignores the on/off
 * setting and the once-per-contract / per-day limits, never the cap or the proof.
 */
export async function replicateRhMint(diag, whaleTx, provider, notify, { manual = false, send = true } = {}) {
  const s = getRhSettings();
  if (!manual && !s.prereqReplicate) return;
  if (!diag?.ok || !diag.needs.length || diag.nftNeeds.length) {
    if (manual) await notify("🔁 Nothing to replay — the diagnosis found no token step.", null);
    return;
  }
  const signer = mainSigner(provider);
  if (!signer) return notify("🔁 *RH replay skipped* — no main wallet configured.", null);
  const me = signer.address;
  const contract = lc(whaleTx.to);

  if (!manual) {
    const log = getRhReplicated();
    if (log.some((e) => e.contract === contract)) return;   // one shot per contract, ever
    if (log.filter((e) => day(e.timestamp) === day(Date.now())).length >= s.prereqDailyMax) {
      return notify(`🔁 *RH replay skipped* — daily limit of ${s.prereqDailyMax} reached.\nContract: \`${contract}\``, null);
    }
  }

  let plan;
  try { plan = await planReplication(diag, whaleTx, provider, me, s); }
  catch (e) { plan = { ok: false, error: e.shortMessage || e.message }; }

  const willSend = plan.ok && send && !s.dryRun && plan.funded;
  await notify(
    formatReplication(plan, me, contract) +
    (plan.ok && !willSend ? `\n_Not sent — ${!send ? "plan only" : s.dryRun ? "bot is in dry run" : "wallet is short"}._` : willSend ? "\n_Sending now…_" : ""),
    null);
  if (!willSend) return;

  await logRhReplicated(contract);   // before the first send, so a crash can't double-spend
  await sendPlan(plan, signer, me, contract, provider, notify, s);
}

// Hook for the executor's failure paths: explain the whale's mint, then copy it.
export async function diagnoseAndReplicate({ whaleTx, nft, revert }, provider, notify, capUsd) {
  const diag = await diagnoseAndNotify({ whaleTx, nft, revert }, provider, notify, capUsd);
  if (!diag) return;
  diag.nft = nft;
  try { await replicateRhMint(diag, whaleTx, provider, notify); }
  catch (e) { console.warn("[RH] replay error:", e.message); }
}
