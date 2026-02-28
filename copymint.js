import { ethers } from "ethers";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { getSettings } from "./storage.js";
import { mintEvents } from "./tracker.js";
import { getAllSigners } from "./wallets.js";
import { v4 as uuidv4 } from "uuid";

let provider;
let mainSigner;
let flashbotsProvider;
let telegramNotify;    // injected from bot.js — sends plain alerts
let telegramAskApproval; // injected from bot.js — sends approval prompt with buttons

const FLASHBOTS_RELAY = "https://relay.flashbots.net";
const MAX_BLOCKS_TO_TRY = 3;
const MAX_MINT_USD = 0.15;       // default max per NFT in USD
const APPROVAL_TIMEOUT_MS = 120000; // 2 minutes to respond

// Pending approvals waiting for user response: mintId → { resolve, reject, timer }
const pendingApprovals = new Map();

// Deduplication — ignore tx if already processed
const processedTxHashes = new Set();

// ETH price cache
let cachedEthPrice = null;
let priceLastFetched = 0;

async function getEthUsdPrice() {
  const now = Date.now();
  if (cachedEthPrice && now - priceLastFetched < 60000) return cachedEthPrice;
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
    );
    const data = await res.json();
    cachedEthPrice = data.ethereum.usd;
    priceLastFetched = now;
    return cachedEthPrice;
  } catch {
    return cachedEthPrice || 2000; // fallback if API is down
  }
}

export async function initCopyMint(ethProvider, signer, notifyFn, askApprovalFn) {
  provider = ethProvider;
  mainSigner = signer;
  telegramNotify = notifyFn;
  telegramAskApproval = askApprovalFn;

  const authSigner = ethers.Wallet.createRandom();
  try {
    flashbotsProvider = await FlashbotsBundleProvider.create(
      provider,
      authSigner,
      FLASHBOTS_RELAY
    );
    console.log("[CopyMint] Flashbots provider ready");
  } catch (err) {
    console.warn("[CopyMint] Flashbots init failed:", err.message);
  }

  mintEvents.on("mintDetected", handleMintDetected);
  console.log("[CopyMint] Listening for whale mints...");
}

async function handleMintDetected({ whale, contract, tx }) {
  // Dedup — same tx can fire twice on WebSocket reconnect
  const txHash = tx.hash;
  if (txHash && processedTxHashes.has(txHash)) return;
  if (txHash) {
    processedTxHashes.add(txHash);
    // Clean up after 10 mins to prevent unbounded memory growth
    setTimeout(() => processedTxHashes.delete(txHash), 10 * 60 * 1000);
  }

  const settings = getSettings();
  const txValue = tx.value ? BigInt(tx.value) : 0n;
  const ethPrice = await getEthUsdPrice();
  const ethAmount = parseFloat(ethers.formatEther(txValue));
  const usdCost = ethAmount * ethPrice;
  const maxUsd = parseFloat(settings.maxMintUsd ?? MAX_MINT_USD);

  const alertMsg =
    `🐋 *Whale Mint Detected!*\n\n` +
    `Whale: \`${whale.slice(0, 6)}...${whale.slice(-4)}\`\n` +
    `Contract: \`${contract}\`\n` +
    `Price: ${ethAmount.toFixed(6)} ETH ($${usdCost.toFixed(2)})\n` +
    `Chain: Ethereum\n` +
    `Auto-Mint: ${settings.autoMint ? "✅ Checking..." : "❌ Off"}`;

  await telegramNotify(alertMsg);
  if (!settings.autoMint) return;

  // Free mint — go immediately
  if (txValue === 0n) {
    await Promise.all([
      executeCopyMint(tx, settings.mevShield),
      executeSubWalletMints(tx),
    ]);
    return;
  }

  // Under limit — mint automatically
  if (usdCost <= maxUsd) {
    await telegramNotify(`✅ Price $${usdCost.toFixed(2)} is under $${maxUsd} limit — minting automatically...`);
    await Promise.all([
      executeCopyMint(tx, settings.mevShield),
      executeSubWalletMints(tx),
    ]);
    return;
  }

  // Over limit — ask for approval
  const mintId = uuidv4();
  await telegramAskApproval({
    mintId,
    usdCost: usdCost.toFixed(2),
    ethAmount: ethAmount.toFixed(6),
    maxUsd,
    contract,
    whale,
  });

  // Wait for user response (yes/no) or timeout
  try {
    const approved = await waitForApproval(mintId);
    if (approved) {
      await Promise.all([
        executeCopyMint(tx, settings.mevShield),
        executeSubWalletMints(tx),
      ]);
    } else {
      await telegramNotify(`⏭️ Mint skipped.`);
    }
  } catch {
    await telegramNotify(`⏰ No response in 2 minutes — mint skipped automatically.`);
  }
}

function waitForApproval(mintId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(mintId);
      reject(new Error("timeout"));
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(mintId, { resolve, reject, timer });
  });
}

// Called from bot.js callback handlers
export function resolveApproval(mintId, approved) {
  const pending = pendingApprovals.get(mintId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingApprovals.delete(mintId);
  pending.resolve(approved);
  return true;
}

export async function executeCopyMint(whaleTx, useMevShield = true) {
  const mintTx = {
    to: whaleTx.to,
    data: whaleTx.input || whaleTx.data || "0x",
    value: whaleTx.value ? BigInt(whaleTx.value) : 0n,
    gasLimit: whaleTx.gas
      ? BigInt(Math.floor(Number(BigInt(whaleTx.gas)) * 1.2))
      : 300000n,
  };

  try {
    let txHash;
    if (useMevShield && flashbotsProvider) {
      txHash = await sendViaFlashbots(mintTx);
    } else {
      const sentTx = await mainSigner.sendTransaction(mintTx);
      txHash = sentTx.hash;
    }

    const shortContract = `${mintTx.to.slice(0, 6)}...${mintTx.to.slice(-4)}`;
    await telegramNotify(
      `✅ *Copy Mint Successful!*\n\n` +
      `📄 Contract: \`${shortContract}\`\n` +
      `⛓️ Chain: Ethereum\n` +
      `💎 Minted to: \`${(await mainSigner.getAddress()).slice(0, 6)}...${(await mainSigner.getAddress()).slice(-4)}\``,
      txHash
    );
    return txHash;
  } catch (err) {
    console.error("[CopyMint] Failed:", err.message);
    await telegramNotify(`❌ *Copy Mint Failed*\n\nError: ${err.message}`);
    throw err;
  }
}

// Forces quantity to 1 in mint calldata.
// Handles the two most common patterns:
//   - mint()              → no args, already 1, return as-is
//   - mint(uint256 qty)   → 4-byte selector + 32-byte arg → replace arg with 1
// Anything more complex is left untouched.
function buildSingleMintData(originalData) {
  const data = originalData || "0x";
  // No args (e.g. mint()) — already mints 1
  if (data.length <= 10) return data;
  // One uint256 arg (e.g. mint(uint256 quantity)) — force to 1
  if (data.length === 74) {
    const selector = data.slice(0, 10);
    const encodedOne = "0000000000000000000000000000000000000000000000000000000000000001";
    return selector + encodedOne;
  }
  // Complex calldata — use as-is
  return data;
}

async function executeSubWalletMints(whaleTx) {
  const signers = getAllSigners(provider);
  if (signers.length === 0) return;

  const txValue = whaleTx.value ? BigInt(whaleTx.value) : 0n;
  // 0.015 ETH covers gas up to ~150 gwei on a 300k gas limit tx
  const GAS_BUFFER = ethers.parseEther("0.015");

  // Get current network gas fees so sub-wallets are competitive
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas
    ? (feeData.maxFeePerGas * 120n) / 100n  // 20% above current to ensure inclusion
    : ethers.parseUnits("50", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
    ? feeData.maxPriorityFeePerGas
    : ethers.parseUnits("2", "gwei");

  // Filter only wallets with enough balance
  const funded = (
    await Promise.all(
      signers.map(async (signer) => {
        try {
          const balance = await provider.getBalance(signer.address);
          return balance >= txValue + GAS_BUFFER ? signer : null;
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);

  if (funded.length === 0) {
    await telegramNotify(`💼 *Sub-Wallets:* 0 funded — skipped`);
    return;
  }

  const mintTx = {
    to: whaleTx.to,
    data: buildSingleMintData(whaleTx.input || whaleTx.data || "0x"),
    value: txValue,
    gasLimit: whaleTx.gas
      ? BigInt(Math.floor(Number(BigInt(whaleTx.gas)) * 1.2))
      : 300000n,
    type: 2,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };

  const results = await Promise.allSettled(
    funded.map((signer) => signer.sendTransaction(mintTx))
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  await telegramNotify(
    `💼 *Sub-Wallet Mints Complete*\n\n` +
    `✅ Succeeded: ${succeeded}\n` +
    `❌ Failed: ${failed}\n` +
    `⏭️ Skipped (no balance): ${signers.length - funded.length}`
  );
}

async function sendViaFlashbots(mintTx) {
  const currentBlock = await provider.getBlockNumber();

  for (let attempt = 0; attempt < MAX_BLOCKS_TO_TRY; attempt++) {
    const targetBlock = currentBlock + 1 + attempt;
    const bundle = [
      {
        signer: mainSigner,
        transaction: {
          ...mintTx,
          chainId: 1,
          type: 2,
          maxFeePerGas: ethers.parseUnits("50", "gwei"),
          maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
        },
      },
    ];

    const signedBundle = await flashbotsProvider.signBundle(bundle);
    const simulation = await flashbotsProvider.simulate(signedBundle, targetBlock);
    if ("error" in simulation) continue;

    const submission = await flashbotsProvider.sendRawBundle(signedBundle, targetBlock);
    if ("error" in submission) continue;

    const waitResult = await submission.wait();
    if (waitResult === 0) {
      const receipts = await submission.receipts();
      return receipts[0]?.transactionHash;
    }
  }

  const sentTx = await mainSigner.sendTransaction(mintTx);
  return sentTx.hash;
}

export async function mintByContract(contractAddress, data, value, signer) {
  const mintTx = {
    to: contractAddress,
    data: data || "0x1249c58b",
    value: value ? ethers.parseEther(value) : 0n,
    gasLimit: 300000n,
  };

  const settings = getSettings();
  const signerToUse = signer || mainSigner;
  if (settings.mevShield && flashbotsProvider && signerToUse === mainSigner) {
    return sendViaFlashbots(mintTx);
  }

  const tx = await signerToUse.sendTransaction(mintTx);
  return tx.hash;
}
