// daemonSniper.js
// One-time use: snipe DAEMONS ERC20 at launch + wrap artifacts as ERC721
// Flow: dry run (simulate tax/slippage) → buy 50% of each wallet's balance → wrap ERC721

import { ethers } from "ethers";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { getAllSigners } from "./wallets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Constants ────────────────────────────────────────────────────────────────

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Uniswap V3
const V3_FACTORY     = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const V3_QUOTER_V2   = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const V3_SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

// Uniswap V4
const V4_POOL_MANAGER   = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const V4_UNIV_ROUTER    = process.env.UNISWAP_V4_ROUTER || "0x66a9893cC07D91D95ba3a1a91F6Fc7f4e2Ca9c5F";

// V4 Universal Router action codes (from Actions.sol)
const V4_ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const V4_ACTION_SETTLE_ALL           = 0x11;
const V4_ACTION_TAKE_ALL             = 0x14;
const V4_COMMAND_SWAP                = 0x10;

const V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"
];

const V3_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut)"
];

const V3_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)"
];

const UNIV_ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const V4_INITIALIZE_SIG = "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)";

const WRAP_KEYWORDS = ["wrap", "wrapall", "freeze", "lock", "toERC721", "convertToNFT"];
const WRAP_SELECTORS = [
  { selector: "0x29c69c34", sig: "wrap()" },
  { selector: "0x1e83409a", sig: "wrap(address)" },
  { selector: "0x3ccfd60b", sig: "withdraw()" },
  { selector: "0x4d49e87d", sig: "wrapAll()" },
  { selector: "0x2f865568", sig: "freeze()" },
  { selector: "0x3a4b66f1", sig: "stake()" },
];

const BALANCE_PCT       = 50;    // always use 50% of each wallet's balance
const TAX_SLIPPAGE_PAD  = 5;    // add 5% on top of detected tax as buffer
const FALLBACK_SLIPPAGE = 30;   // used when tax simulation fails
const WRAP_WAIT_MS      = 45000; // 45s (~3–4 blocks) before wrapping
const GAS_RESERVE_ETH   = 0.015; // ETH kept back per wallet for gas

const DAEMON_WALLETS_FILE = path.join(__dirname, "daemon-wallets.json");

// ─── Snipe Wallet List ────────────────────────────────────────────────────────
// Stores the addresses pre-registered by the user for this snipe.

let snipeAddresses = new Set();

function loadSnipeWallets() {
  try {
    const raw = JSON.parse(fs.readFileSync(DAEMON_WALLETS_FILE, "utf8"));
    snipeAddresses = new Set(raw.map(a => a.toLowerCase()));
  } catch {
    snipeAddresses = new Set();
  }
}

function saveSnipeWallets() {
  fs.writeFileSync(DAEMON_WALLETS_FILE, JSON.stringify([...snipeAddresses], null, 2));
}

export function addSnipeWallet(address) {
  snipeAddresses.add(address.toLowerCase());
  saveSnipeWallets();
}

export function removeSnipeWallet(address) {
  snipeAddresses.delete(address.toLowerCase());
  saveSnipeWallets();
}

export function clearSnipeWallets() {
  snipeAddresses.clear();
  saveSnipeWallets();
}

export function getSnipeWalletAddresses() {
  return [...snipeAddresses];
}

// ─── Module State ─────────────────────────────────────────────────────────────

let provider;
let mainSigner;

export function initDaemonSniper(ethProvider, signer) {
  provider = ethProvider;
  mainSigner = signer;
  loadSnipeWallets();
  console.log(`[DaemonSniper] Loaded ${snipeAddresses.size} pre-registered snipe wallet(s)`);
}

// ─── Pool Discovery ───────────────────────────────────────────────────────────

async function findV3Pool(tokenCA) {
  const factory = new ethers.Contract(V3_FACTORY, V3_FACTORY_ABI, provider);
  for (const fee of [3000, 10000, 500, 100]) {
    try {
      const pool = await factory.getPool(WETH, tokenCA, fee);
      if (pool !== ethers.ZeroAddress) return { type: "v3", fee, pool };
    } catch {}
  }
  return null;
}

async function findV4Pool(tokenCA) {
  const topic = ethers.id(V4_INITIALIZE_SIG);
  const tokenTopic = ethers.zeroPadValue(tokenCA.toLowerCase(), 32);

  try {
    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - 50000); // ~7 days

    // Try token as currency1 (most likely — ETH=address(0) < any real token)
    let logs = await provider.getLogs({
      address: V4_POOL_MANAGER,
      topics: [topic, null, null, tokenTopic],
      fromBlock,
      toBlock: "latest",
    });

    // Also try token as currency0 (edge case)
    if (logs.length === 0) {
      logs = await provider.getLogs({
        address: V4_POOL_MANAGER,
        topics: [topic, null, tokenTopic],
        fromBlock,
        toBlock: "latest",
      });
    }

    if (logs.length === 0) return null;

    const log = logs[0];
    // Non-indexed data: uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint24", "int24", "address", "uint160", "int24"],
      log.data
    );

    const currency0 = ethers.getAddress("0x" + log.topics[2].slice(-40));
    const currency1 = ethers.getAddress("0x" + log.topics[3].slice(-40));

    return {
      type: "v4",
      currency0,
      currency1,
      fee: Number(decoded[0]),
      tickSpacing: Number(decoded[1]),
      hooks: decoded[2],
      zeroForOne: currency0.toLowerCase() === ethers.ZeroAddress.toLowerCase(),
    };
  } catch (err) {
    console.warn("[DaemonSniper] V4 pool scan failed:", err.message);
    return null;
  }
}

export async function detectPool(tokenCA) {
  const v3 = await findV3Pool(tokenCA);
  if (v3) return v3;
  const v4 = await findV4Pool(tokenCA);
  if (v4) return v4;
  return null;
}

// ─── Tax Detection (V3) ───────────────────────────────────────────────────────

export async function detectTax(tokenCA, ethAmount, fee) {
  const amountIn = ethers.parseEther(ethAmount.toString());

  try {
    // Get expected output from quoter (pure math, no tax)
    const quoter = new ethers.Contract(V3_QUOTER_V2, V3_QUOTER_ABI, provider);
    const expectedOut = await quoter.quoteExactInputSingle.staticCall(
      WETH, tokenCA, fee, amountIn, 0n
    );

    if (expectedOut === 0n) return { tax: null, error: "zero quote" };

    // Simulate actual swap via eth_call — this hits the real token transfer logic
    const router = new ethers.Contract(V3_SWAP_ROUTER, V3_ROUTER_ABI, provider);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const myAddr = await mainSigner.getAddress();

    let actualOut;
    try {
      actualOut = await router.exactInputSingle.staticCall(
        {
          tokenIn: WETH,
          tokenOut: tokenCA,
          fee,
          recipient: myAddr,
          deadline,
          amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
        { value: amountIn }
      );
    } catch {
      // If simulation fails (pool may not be live yet), fall through
      return { tax: null, error: "simulation failed" };
    }

    if (actualOut >= expectedOut) return { tax: 0, expectedOut, actualOut };

    const taxBps = Number((expectedOut - actualOut) * 10000n / expectedOut);
    return { tax: taxBps / 100, expectedOut, actualOut };
  } catch (err) {
    return { tax: null, error: err.message };
  }
}

// ─── Buy V3 ───────────────────────────────────────────────────────────────────

// walletAmounts: [{ signer, buyAmount (BigInt wei) }]
async function buyV3(tokenCA, walletAmounts, slippagePct, fee) {
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas
    ? (feeData.maxFeePerGas * 150n) / 100n
    : ethers.parseUnits("80", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
    ? (feeData.maxPriorityFeePerGas * 200n) / 100n
    : ethers.parseUnits("10", "gwei");

  const quoter   = new ethers.Contract(V3_QUOTER_V2, V3_QUOTER_ABI, provider);
  const router   = new ethers.Contract(V3_SWAP_ROUTER, V3_ROUTER_ABI, provider);
  const deadline = Math.floor(Date.now() / 1000) + 180;
  const slippageBps = BigInt(Math.round(slippagePct * 100));

  return Promise.allSettled(
    walletAmounts.map(async ({ signer, buyAmount }) => {
      // Per-wallet quote so amountOutMin scales with each wallet's actual buy size
      let amountOutMin = 0n;
      try {
        const expected = await quoter.quoteExactInputSingle.staticCall(WETH, tokenCA, fee, buyAmount, 0n);
        amountOutMin = (expected * (10000n - slippageBps)) / 10000n;
      } catch {}

      const tx = await router.connect(signer).exactInputSingle(
        {
          tokenIn: WETH,
          tokenOut: tokenCA,
          fee,
          recipient: signer.address,
          deadline,
          amountIn: buyAmount,
          amountOutMinimum: amountOutMin,
          sqrtPriceLimitX96: 0n,
        },
        {
          value: buyAmount,
          maxFeePerGas,
          maxPriorityFeePerGas,
          gasLimit: 400000n,
        }
      );
      return { hash: tx.hash, address: signer.address, ethSpent: parseFloat(ethers.formatEther(buyAmount)) };
    })
  );
}

// ─── Buy V4 via Universal Router ─────────────────────────────────────────────

function encodeV4Swap(poolKey, amountIn, amountOutMin) {
  // actions: SWAP_EXACT_IN_SINGLE → SETTLE_ALL → TAKE_ALL
  const actions = new Uint8Array([
    V4_ACTION_SWAP_EXACT_IN_SINGLE,
    V4_ACTION_SETTLE_ALL,
    V4_ACTION_TAKE_ALL,
  ]);

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  // SWAP_EXACT_IN_SINGLE params: ExactInputSingleParams
  const swapParams = abiCoder.encode(
    ["(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)"],
    [{
      poolKey: {
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
      },
      zeroForOne: poolKey.zeroForOne,
      amountIn: amountIn,
      amountOutMinimum: amountOutMin,
      hookData: "0x",
    }]
  );

  // SETTLE_ALL params: (Currency currency, uint256 maxAmount) — pays ETH from msg.value
  const settleParams = abiCoder.encode(
    ["address", "uint256"],
    [poolKey.currency0, amountIn]
  );

  // TAKE_ALL params: (Currency currency, uint256 minAmount) — takes token to msg.sender
  const takeParams = abiCoder.encode(
    ["address", "uint256"],
    [poolKey.currency1, amountOutMin]
  );

  // Outer encoding for V4_SWAP Universal Router command
  const v4SwapInput = abiCoder.encode(
    ["bytes", "bytes[]"],
    [actions, [swapParams, settleParams, takeParams]]
  );

  return {
    commands: ethers.hexlify(new Uint8Array([V4_COMMAND_SWAP])),
    inputs: [v4SwapInput],
  };
}

// walletAmounts: [{ signer, buyAmount (BigInt wei) }]
async function buyV4(poolKey, walletAmounts, slippagePct) {
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas
    ? (feeData.maxFeePerGas * 150n) / 100n
    : ethers.parseUnits("80", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
    ? (feeData.maxPriorityFeePerGas * 200n) / 100n
    : ethers.parseUnits("10", "gwei");

  const deadline = Math.floor(Date.now() / 1000) + 180;
  const router   = new ethers.Contract(V4_UNIV_ROUTER, UNIV_ROUTER_ABI, provider);

  return Promise.allSettled(
    walletAmounts.map(async ({ signer, buyAmount }) => {
      // amountOutMin = 0 for V4 (no V4 quoter available pre-launch; slippage absorbed by tax detection)
      const { commands, inputs } = encodeV4Swap(poolKey, buyAmount, 0n);
      const tx = await router.connect(signer).execute(commands, inputs, deadline, {
        value: buyAmount,
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit: 500000n,
      });
      return { hash: tx.hash, address: signer.address, ethSpent: parseFloat(ethers.formatEther(buyAmount)) };
    })
  );
}

// ─── Wrap Detection ───────────────────────────────────────────────────────────

export async function detectWrapFunction(contractCA) {
  const apiKey = process.env.ETHERSCAN_API_KEY;

  // Try Etherscan ABI first
  if (apiKey) {
    try {
      const url = `https://api.etherscan.io/api?module=contract&action=getabi&address=${contractCA}&apikey=${apiKey}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.status === "1") {
        const abi = JSON.parse(json.result);
        const wrapFn = abi.find(fn =>
          fn.type === "function" &&
          WRAP_KEYWORDS.some(kw => fn.name.toLowerCase().includes(kw))
        );
        if (wrapFn) {
          const sig = `${wrapFn.name}(${wrapFn.inputs.map(i => i.type).join(",")})`;
          const iface = new ethers.Interface([wrapFn]);
          return {
            sig,
            calldata: iface.encodeFunctionData(wrapFn.name, []),
            source: "etherscan",
          };
        }
      }
    } catch {}
  }

  // Probe known wrap selectors
  for (const { selector, sig } of WRAP_SELECTORS) {
    try {
      await provider.call({ to: contractCA, data: selector });
      return { sig, calldata: selector, source: "probe" };
    } catch (err) {
      const msg = err.message || "";
      // execution revert = function exists but failed (expected — not yet wrapped)
      if (msg.includes("execution reverted") || msg.includes("revert")) {
        return { sig, calldata: selector, source: "probe" };
      }
    }
  }

  return null;
}

// ─── Wrap Execution ───────────────────────────────────────────────────────────

async function wrapArtifacts(contractCA, calldata, signers) {
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas
    ? (feeData.maxFeePerGas * 120n) / 100n
    : ethers.parseUnits("50", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");

  return Promise.allSettled(
    signers.map(async (signer) => {
      // Simulate first
      try {
        await provider.call({ to: contractCA, data: calldata, from: signer.address });
      } catch (simErr) {
        const reason = simErr.reason || simErr.message || "";
        if (reason.includes("nothing to wrap") || reason.includes("no artifacts") || reason.includes("zero")) {
          return { skipped: true, address: signer.address, reason };
        }
      }

      const tx = await signer.sendTransaction({
        to: contractCA,
        data: calldata,
        gasLimit: 300000n,
        maxFeePerGas,
        maxPriorityFeePerGas,
        type: 2,
      });
      return { hash: tx.hash, address: signer.address };
    })
  );
}

// ─── Check Token Balance ──────────────────────────────────────────────────────

async function checkBalance(tokenCA, address) {
  try {
    const token = new ethers.Contract(tokenCA, ERC20_ABI, provider);
    const [bal, dec] = await Promise.all([token.balanceOf(address), token.decimals()]);
    return ethers.formatUnits(bal, dec);
  } catch {
    return "0";
  }
}

// ─── Wallet Resolution ────────────────────────────────────────────────────────
// Returns [{ signer, buyAmount, balanceEth }] for each pre-registered wallet.
// buyAmount = 50% of (balance − gas reserve).

async function resolveSnipeWallets() {
  if (snipeAddresses.size === 0) return [];

  // Get all signers the bot controls (main + sub-wallets)
  const allSigners = [mainSigner, ...getAllSigners(provider)];
  const signerMap  = new Map(allSigners.map(s => [s.address.toLowerCase(), s]));
  const gasReserve = ethers.parseEther(GAS_RESERVE_ETH.toString());

  const results = await Promise.all(
    [...snipeAddresses].map(async (addr) => {
      const signer = signerMap.get(addr);
      if (!signer) {
        console.warn(`[DaemonSniper] ${addr} is in snipe list but not a known wallet — skipped`);
        return null;
      }
      try {
        const bal = await provider.getBalance(signer.address);
        if (bal <= gasReserve) return null; // nothing above gas
        const spendable  = bal - gasReserve;
        const buyAmount  = (spendable * 5000n) / 10000n; // exactly 50%
        if (buyAmount === 0n) return null;
        return {
          signer,
          buyAmount,
          balanceEth: parseFloat(ethers.formatEther(bal)),
          buyEth:     parseFloat(ethers.formatEther(buyAmount)),
        };
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

// ─── Main Snipe Orchestrator ──────────────────────────────────────────────────

// ─── Dry Run ──────────────────────────────────────────────────────────────────
// Simulates one swap (median wallet size) to get rate + tax, then shows a
// per-wallet breakdown of what each wallet will spend and receive.

async function dryRun(walletAmounts, tokenCA, pool, slippage, notify) {
  // Use the median wallet's amount as the representative simulation amount
  const sorted   = [...walletAmounts].sort((a, b) => Number(a.buyAmount - b.buyAmount));
  const medianWA = sorted[Math.floor(sorted.length / 2)];
  const refAmount = medianWA.buyAmount;
  const refEth    = medianWA.buyEth;

  let taxPct = null;
  let ratePerEth = null; // tokens per 1 ETH (after tax)
  let detectedSlippage = slippage;

  if (pool.type === "v3") {
    try {
      const quoter = new ethers.Contract(V3_QUOTER_V2, V3_QUOTER_ABI, provider);
      const router = new ethers.Contract(V3_SWAP_ROUTER, V3_ROUTER_ABI, provider);
      const refAddr = medianWA.signer.address;
      const deadline = Math.floor(Date.now() / 1000) + 300;

      // Expected output (pure pool math, no tax)
      const expectedOut = await quoter.quoteExactInputSingle.staticCall(
        WETH, tokenCA, pool.fee, refAmount, 0n
      );

      // Simulated output (hits token contract, includes tax)
      let actualOut = expectedOut;
      try {
        actualOut = await router.exactInputSingle.staticCall(
          {
            tokenIn: WETH, tokenOut: tokenCA, fee: pool.fee,
            recipient: refAddr, deadline,
            amountIn: refAmount, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
          },
          { value: refAmount }
        );
      } catch {}

      if (expectedOut > 0n) {
        const taxBps = Number((expectedOut - actualOut) * 10000n / expectedOut);
        taxPct = Math.max(0, taxBps / 100);
        detectedSlippage = Math.ceil(taxPct) + TAX_SLIPPAGE_PAD;
        ratePerEth = parseFloat(ethers.formatUnits(actualOut, 18)) / refEth;
      }
    } catch (err) {
      console.warn("[DaemonSniper] Dry run simulation error:", err.message);
    }
  }

  // Build per-wallet preview
  const walletLines = walletAmounts.map(({ signer, buyEth }) => {
    const expectedTokens = ratePerEth !== null
      ? (ratePerEth * buyEth).toFixed(2)
      : "?";
    return `\`${signer.address.slice(0, 10)}...\`  ${buyEth.toFixed(4)} ETH → ~${expectedTokens} DAEMON`;
  });

  const totalEth = walletAmounts.reduce((s, w) => s + w.buyEth, 0);

  await notify(
    `🧪 *Dry Run Complete*\n\n` +
    walletLines.join("\n") + "\n\n" +
    `─────────────────\n` +
    `📊 Wallets: ${walletAmounts.length}\n` +
    `💸 Total ETH: ~${totalEth.toFixed(4)}\n` +
    `🧾 Transfer tax: ${taxPct !== null ? taxPct.toFixed(1) + "%" : "unknown (V4)"}\n` +
    `📉 Slippage set: ${detectedSlippage}%\n\n` +
    `⚡ Executing real transactions now...`
  );

  return detectedSlippage;
}

// ─── Main Snipe Orchestrator ──────────────────────────────────────────────────

export async function runDaemonSnipe({ tokenCA, notify }) {
  // ── Step 1: Resolve pre-registered wallets ──
  if (snipeAddresses.size === 0) {
    await notify(
      `❌ *No wallets registered*\n\n` +
      `Add wallets first with:\n` +
      `\`/daemonadd 0xAddress\`\n\n` +
      `Then re-run /daemonsnipe.`
    );
    return { aborted: true, reason: "no_wallets_registered" };
  }

  await notify(
    `🎯 *DAEMON Snipe Starting*\n\n` +
    `CA: \`${tokenCA}\`\n` +
    `Registered wallets: ${snipeAddresses.size}\n` +
    `Spend: *50%* of each wallet's balance\n\n` +
    `Checking balances...`
  );

  const walletAmounts = await resolveSnipeWallets();

  if (walletAmounts.length === 0) {
    await notify(
      `❌ *No funded wallets*\n\n` +
      `All registered wallets are below the gas reserve (${GAS_RESERVE_ETH} ETH).\n` +
      `Top them up first.`
    );
    return { aborted: true, reason: "no_funded_wallets" };
  }

  const totalEth = walletAmounts.reduce((s, w) => s + w.buyEth, 0);
  const minEth   = Math.min(...walletAmounts.map(w => w.buyEth));
  const maxEth   = Math.max(...walletAmounts.map(w => w.buyEth));

  await notify(
    `💼 *${walletAmounts.length}/${snipeAddresses.size}* wallets funded\n` +
    `50% per wallet: ${minEth.toFixed(4)}–${maxEth.toFixed(4)} ETH\n` +
    `Total to spend: *~${totalEth.toFixed(4)} ETH*`
  );

  // ── Step 2: Find pool ──
  await notify("🔍 Scanning for pool...");
  const pool = await detectPool(tokenCA);

  if (!pool) {
    await notify(
      `❌ *No pool found*\n\n` +
      `V3 (all fee tiers) and V4 both returned empty.\n` +
      `Either the CA is wrong or the pool isn't live yet.`
    );
    return { aborted: true, reason: "no_pool" };
  }

  await notify(
    `✅ *${pool.type.toUpperCase()} pool* — fee: ${pool.fee / 10000}%` +
    (pool.type === "v4" ? `\nHooks: \`${pool.hooks}\`` : "")
  );

  // ── Step 3: Dry run — simulate, measure tax, show per-wallet breakdown ──
  await notify("🧪 Running simulation...");
  const slippage = await dryRun(walletAmounts, tokenCA, pool, FALLBACK_SLIPPAGE, notify);

  // ── Step 4: Execute buys ──
  let buyResults;
  if (pool.type === "v3") {
    buyResults = await buyV3(tokenCA, walletAmounts, slippage, pool.fee);
  } else {
    buyResults = await buyV4(pool, walletAmounts, slippage);
  }

  const bought    = buyResults.filter(r => r.status === "fulfilled");
  const buyFailed = buyResults.filter(r => r.status === "rejected");
  const ethSpent  = bought.reduce((s, r) => s + (r.value?.ethSpent || 0), 0);

  if (bought.length > 0) {
    const hashes = bought.slice(0, 5)
      .map(r => `• [${r.value.address.slice(0, 10)}...](https://etherscan.io/tx/${r.value.hash})`)
      .join("\n");
    await notify(
      `💰 *Buy Results*\n\n` +
      `✅ Succeeded: ${bought.length} wallets\n` +
      `❌ Failed: ${buyFailed.length}\n` +
      `💸 ETH spent: ~${ethSpent.toFixed(4)}\n\n` +
      hashes,
      null, "Markdown"
    );
  } else {
    await notify(
      `❌ *All buys failed*\n\n` +
      buyFailed.slice(0, 3).map(r => `• ${r.reason?.message?.slice(0, 80)}`).join("\n")
    );
    return { bought: 0, wrapped: 0 };
  }

  // ── Step 5: Wait for artifacts to spawn ──
  await notify(`⏳ Waiting ${WRAP_WAIT_MS / 1000}s for artifacts to spawn on-chain...`);
  await new Promise(r => setTimeout(r, WRAP_WAIT_MS));

  // ── Step 6: Detect wrap function ──
  await notify("🔍 Detecting wrap function...");
  const wrapFn = await detectWrapFunction(tokenCA);

  if (!wrapFn) {
    await notify(
      `⚠️ *Wrap function not detected yet*\n\n` +
      `Contract may not be verified on Etherscan yet.\n\n` +
      `Once verified, run:\n\`/daemonwrap ${tokenCA}\`\n\n` +
      `Or with manual calldata:\n\`/daemonwrap ${tokenCA} 0xSELECTOR\``
    );
    return { bought: bought.length, wrapped: 0 };
  }

  await notify(`✅ Wrap fn: \`${wrapFn.sig}\` (${wrapFn.source})`);

  // ── Step 7: Wrap only successfully bought wallets ──
  const successSigners = bought
    .map(r => walletAmounts.find(w => w.signer.address.toLowerCase() === r.value.address.toLowerCase())?.signer)
    .filter(Boolean);

  await notify(`🧊 Wrapping on ${successSigners.length} wallets...`);
  const wrapResults = await wrapArtifacts(tokenCA, wrapFn.calldata, successSigners);

  const wrapped    = wrapResults.filter(r => r.status === "fulfilled" && !r.value?.skipped).length;
  const wrapSkip   = wrapResults.filter(r => r.value?.skipped).length;
  const wrapFailed = wrapResults.filter(r => r.status === "rejected").length;

  await notify(
    `🎉 *DAEMON Snipe Complete!*\n\n` +
    `💰 Bought: ${bought.length} wallets (~${ethSpent.toFixed(4)} ETH)\n` +
    `🧊 Wrapped: ${wrapped}\n` +
    `⏭️ Skipped (no artifacts): ${wrapSkip}\n` +
    `❌ Wrap errors: ${wrapFailed}`
  );

  return { bought: bought.length, wrapped };
}

// ─── Manual Wrap Only ─────────────────────────────────────────────────────────

export async function runDaemonWrap({ tokenCA, calldata, notify }) {
  const allSigners = [mainSigner, ...getAllSigners(provider)];

  let wrapData = calldata;

  if (!wrapData) {
    await notify("🔍 Auto-detecting wrap function...");
    const wrapFn = await detectWrapFunction(tokenCA);
    if (!wrapFn) {
      await notify(
        `❌ Could not auto-detect wrap function.\n\n` +
        `Provide calldata manually:\n` +
        `\`/daemonwrap ${tokenCA} 0xCALLDATA [group]\``
      );
      return;
    }
    wrapData = wrapFn.calldata;
    await notify(`✅ Using: \`${wrapFn.sig}\``);
  }

  await notify(`🧊 Wrapping artifacts on ${allSigners.length} wallets...`);
  const results = await wrapArtifacts(tokenCA, wrapData, allSigners);

  const wrapped = results.filter(r => r.status === "fulfilled" && !r.value?.skipped).length;
  const skipped = results.filter(r => r.value?.skipped).length;
  const failed  = results.filter(r => r.status === "rejected").length;

  await notify(
    `🧊 *Wrap Results*\n\n` +
    `✅ Wrapped: ${wrapped}\n` +
    `⏭️ Skipped: ${skipped}\n` +
    `❌ Failed: ${failed}`
  );
}
