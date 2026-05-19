import { ethers } from "ethers";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { getSettings, logMint } from "./storage.js";
import { mintEvents, tmaEvents } from "./tracker.js";
import { getAllSigners, getGroupSigners } from "./wallets.js";
import { getWhaleLabel } from "./whale-meta.js";

const SEADROP_ADDRESS = "0x00005ea00ac477b1030ce78506496e8c2de24bf5";
const SEADROP_MINT_PUBLIC_SELECTOR = "0x161ac21f";
const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
const SEADROP_IFACE = new ethers.Interface([
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)",
]);

// Fix SeaDrop calldata so our wallet is both payer AND minter (avoids PayerNotAllowed)
function fixSeaDropCalldata(to, calldata) {
  if (
    to?.toLowerCase() === SEADROP_ADDRESS &&
    calldata?.slice(0, 10).toLowerCase() === SEADROP_MINT_PUBLIC_SELECTOR
  ) {
    try {
      const decoded = SEADROP_IFACE.decodeFunctionData("mintPublic", calldata);
      return SEADROP_IFACE.encodeFunctionData("mintPublic", [
        decoded.nftContract,
        decoded.feeRecipient || OPENSEA_FEE_RECIPIENT,
        ethers.ZeroAddress, // minterIfNotPayer = 0 → msg.sender is the minter
        decoded.quantity,
      ]);
    } catch (e) {
      console.warn("[CopyMint] SeaDrop calldata decode failed, using original:", e.message);
    }
  }
  return calldata;
}

let provider;
let mainSigner;
let flashbotsProvider;
let telegramNotify;
let telegramAskApproval;

const FLASHBOTS_RELAY = "https://relay.flashbots.net";
const MAX_BLOCKS_TO_TRY = 3;
const MAX_PAID_QUANTITY = 5;
const THRESHOLD_ETH = ethers.parseEther("0.000043"); // ~$0.15 — per-unit ceiling
const APPROVAL_TIMEOUT_MS = 120000;

const pendingApprovals = new Map();
const processedTxHashes = new Set();

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
    return cachedEthPrice || 2000;
  }
}

// Mint quantity rules:
//   Free (value=0)                          → no cap, mint max
//   Paid, per-unit > THRESHOLD_ETH          → skip entirely
//   Paid, 5 × per-unit ≤ THRESHOLD_ETH     → mint 5
//   Paid, 1 × per-unit ≤ THRESHOLD_ETH
//         but 5 × per-unit > THRESHOLD_ETH → mint 1
async function adjustMintQuantity(rawData, txValue, isFree) {
  const data = rawData || "0x";
  const value = BigInt(txValue || 0);

  // Free mint — no cap at all
  if (isFree) return { data, value, skip: false, originalQty: null, newQty: null };

  // Detect quantity from calldata
  let originalQty = null;
  let isSeaDrop = false;

  if (data.slice(0, 10).toLowerCase() === SEADROP_MINT_PUBLIC_SELECTOR) {
    try {
      const decoded = SEADROP_IFACE.decodeFunctionData("mintPublic", data);
      originalQty = Number(decoded.quantity);
      isSeaDrop = true;
    } catch {}
  }

  if (originalQty === null && data.length === 74) {
    const qty = parseInt(data.slice(10), 16);
    if (qty > 0 && qty <= 10000) originalQty = qty;
  }

  if (originalQty === null && data.length > 74 && (data.length - 10) % 64 === 0) {
    const lastWord = parseInt(data.slice(-64), 16);
    if (lastWord > 0 && lastWord <= 10000) originalQty = lastWord;
  }

  const effectiveQty = originalQty || 1;
  const pricePerNft = value / BigInt(effectiveQty);

  // Per-unit exceeds threshold → skip
  if (pricePerNft > THRESHOLD_ETH) {
    return { data, value, skip: true, originalQty, newQty: 0, pricePerNft };
  }

  // Quantity is 1 or unknown — no re-encoding needed, just send
  if (!originalQty || originalQty <= 1) {
    return { data, value, skip: false, originalQty, newQty: 1 };
  }

  // 5 units affordable → mint 5, otherwise mint 1
  const newQty = pricePerNft * BigInt(MAX_PAID_QUANTITY) <= THRESHOLD_ETH
    ? MAX_PAID_QUANTITY
    : 1;

  if (newQty >= originalQty) return { data, value, skip: false, originalQty, newQty: originalQty };

  // Re-encode calldata with new quantity
  let newData = data;
  if (isSeaDrop) {
    try {
      const decoded = SEADROP_IFACE.decodeFunctionData("mintPublic", data);
      newData = SEADROP_IFACE.encodeFunctionData("mintPublic", [
        decoded.nftContract,
        decoded.feeRecipient || OPENSEA_FEE_RECIPIENT,
        ethers.ZeroAddress,
        newQty,
      ]);
    } catch {}
  } else if (data.length === 74) {
    newData = data.slice(0, 10) + newQty.toString(16).padStart(64, "0");
  } else {
    newData = data.slice(0, -64) + newQty.toString(16).padStart(64, "0");
  }

  const newValue = pricePerNft * BigInt(newQty);
  return { data: newData, value: newValue, skip: false, originalQty, newQty };
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
  tmaEvents.on("tmaBuyDetected", handleTMABuy);
  console.log("[CopyMint] Listening for whale mints...");
}

async function handleTMABuy({ tx, marketplace }) {
  const txValue = tx.value ? BigInt(tx.value) : 0n;
  const ethAmount = parseFloat(ethers.formatEther(txValue));
  const ethPrice = await getEthUsdPrice();
  const usdCost = (ethAmount * ethPrice).toFixed(2);

  await telegramNotify(
    `🛒 *TMA Buy Alert!*\n\n` +
    `Marketplace: ${marketplace}\n` +
    `Paid: ${ethAmount.toFixed(4)} ETH ($${usdCost})\n` +
    `TX: [${tx.hash?.slice(0, 10)}...](https://etherscan.io/tx/${tx.hash})`
  );
}

async function handleMintDetected({ whale, contract, tx }) {
  const txHash = tx.hash;
  if (txHash && processedTxHashes.has(txHash)) return;
  if (txHash) {
    processedTxHashes.add(txHash);
    setTimeout(() => processedTxHashes.delete(txHash), 10 * 60 * 1000);
  }

  const settings = getSettings();
  const contractLower = contract.toLowerCase();
  const whitelist = settings.whitelist || [];
  const blacklist = settings.blacklist || [];

  // ── Filters ──────────────────────────────────────────────────────────────
  if (blacklist.includes(contractLower)) {
    console.log(`[Filter] Blacklisted — skipping ${contract}`);
    return;
  }
  if (whitelist.length > 0 && !whitelist.includes(contractLower)) {
    console.log(`[Filter] Not in whitelist — skipping ${contract}`);
    return;
  }

  const txValue = tx.value ? BigInt(tx.value) : 0n;

  // Free mint toggle
  if (txValue === 0n && settings.allowFreeMints === false) {
    console.log(`[Filter] Free mints disabled — skipping ${contract}`);
    return;
  }

  const ethAmount = parseFloat(ethers.formatEther(txValue));
  const ethPrice = await getEthUsdPrice();
  const usdCost = ethAmount * ethPrice;

  const whaleLabel = getWhaleLabel(whale);
  const alertMsg =
    `🐋 *Whale Mint Detected!*\n\n` +
    (whaleLabel ? `${whaleLabel}\n` : ``) +
    `Whale: \`${whale}\`\n` +
    `Contract: \`${contract}\`\n` +
    `Whale paid: ${ethAmount.toFixed(6)} ETH ($${usdCost.toFixed(2)})\n` +
    `Chain: Ethereum\n` +
    `Auto-Mint: ${settings.autoMint ? "✅ Checking..." : "❌ Off"}`;

  await telegramNotify(alertMsg);
  if (!settings.autoMint) return;

  // mintSigned = signature locked to whale's wallet — skip entirely, sub-wallets included
  const rawData = tx.input || tx.data || "0x";
  if (rawData.slice(0, 10).toLowerCase() === SEADROP_MINT_SIGNED_SELECTOR) {
    await telegramNotify(
      `🔒 *Signed Mint — Skipped*\n\n` +
      `Guaranteed/allowlist drop. The signature is tied to the whale's wallet and cannot be copied.`
    );
    return;
  }

  await Promise.all([
    executeCopyMint(tx, settings.mevShield),
    executeSubWalletMints(tx),
  ]);
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

export function resolveApproval(mintId, approved) {
  const pending = pendingApprovals.get(mintId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingApprovals.delete(mintId);
  pending.resolve(approved);
  return true;
}

const SEADROP_MINT_SIGNED_SELECTOR = "0x4b61cd6f";

export async function executeCopyMint(whaleTx, useMevShield = true) {
  const rawData = whaleTx.input || whaleTx.data || "0x";
  const rawTxValue = whaleTx.value ? BigInt(whaleTx.value) : 0n;
  const { data: adjData, value: adjValue, skip, originalQty, newQty } =
    await adjustMintQuantity(rawData, rawTxValue, rawTxValue === 0n);

  if (skip) {
    await telegramNotify(
      `⛔ *Main Wallet — Skipped*\n\nPer-unit price exceeds 0.000043 ETH (~$0.15) — not minting.`
    );
    return;
  }

  if (newQty !== null && newQty !== originalQty) {
    await telegramNotify(
      `⚠️ *Quantity Adjusted (Main Wallet)*\n\nWhale minted ×${originalQty} → minting ×${newQty}`
    );
  }

  const mintTx = {
    to: whaleTx.to,
    data: fixSeaDropCalldata(whaleTx.to, adjData),
    value: adjValue,
    gasLimit: whaleTx.gas
      ? BigInt(Math.floor(Number(BigInt(whaleTx.gas)) * 1.2))
      : 300000n,
  };

  // Simulate before sending — catches IncorrectPayment, reverts, etc. at zero cost
  try {
    await provider.call({ ...mintTx, from: await mainSigner.getAddress() });
  } catch (simErr) {
    const reason = simErr.reason || simErr.message?.slice(0, 120) || "unknown revert";
    await telegramNotify(
      `⚠️ *Mint Simulation Failed — Skipped*\n\n` +
      `The tx would revert on-chain. Reason:\n\`${reason}\``
    );
    return;
  }

  try {
    let txHash;
    if (useMevShield && flashbotsProvider) {
      txHash = await sendViaFlashbots(mintTx);
    } else {
      const sentTx = await mainSigner.sendTransaction(mintTx);
      txHash = sentTx.hash;
    }

    const mainAddr = await mainSigner.getAddress();
    await logMint({
      contract: mintTx.to.toLowerCase(),
      wallet: mainAddr.toLowerCase(),
      txHash,
      ethSpent: parseFloat(ethers.formatEther(mintTx.value)),
      timestamp: Date.now(),
    });

    const shortContract = `${mintTx.to.slice(0, 6)}...${mintTx.to.slice(-4)}`;
    await telegramNotify(
      `✅ *Copy Mint Successful!*\n\n` +
      `📄 Contract: \`${shortContract}\`\n` +
      `⛓️ Chain: Ethereum\n` +
      `💎 Minted to: \`${mainAddr.slice(0, 6)}...${mainAddr.slice(-4)}\``,
      txHash
    );
    return txHash;
  } catch (err) {
    console.error("[CopyMint] Failed:", err.message);
    await telegramNotify(`❌ *Copy Mint Failed*\n\nError: ${err.message}`);
    throw err;
  }
}

function buildSingleMintData(originalData) {
  const data = originalData || "0x";
  if (data.length <= 10) return data;
  if (data.length === 74) {
    const selector = data.slice(0, 10);
    const encodedOne = "0000000000000000000000000000000000000000000000000000000000000001";
    return selector + encodedOne;
  }
  return data;
}

async function executeSubWalletMints(whaleTx, groupName = null) {
  const signers = groupName
    ? getGroupSigners(groupName, provider)
    : getAllSigners(provider);
  if (signers.length === 0) return;

  const rawTxValue = whaleTx.value ? BigInt(whaleTx.value) : 0n;
  const { data: adjSubData, value: txValue, skip: subSkip, originalQty: subOrigQty, newQty: subNewQty } =
    await adjustMintQuantity(
      whaleTx.input || whaleTx.data || "0x",
      rawTxValue,
      rawTxValue === 0n
    );

  if (subSkip) {
    await telegramNotify(
      `⛔ *Sub-Wallets — Skipped*\n\nPer-unit price exceeds 0.000043 ETH (~$0.15) — not minting on any wallet.`
    );
    return;
  }

  if (subNewQty !== null && subNewQty !== subOrigQty) {
    await telegramNotify(
      `⚠️ *Quantity Adjusted (Sub-Wallets)*\n\nWhale minted ×${subOrigQty} → minting ×${subNewQty} per wallet`
    );
  }

  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas
    ? (feeData.maxFeePerGas * 120n) / 100n
    : ethers.parseUnits("50", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
    ? feeData.maxPriorityFeePerGas
    : ethers.parseUnits("2", "gwei");

  // Gas buffer = actual estimated gas cost based on live gas price
  const gasLimit = whaleTx.gas
    ? BigInt(Math.floor(Number(BigInt(whaleTx.gas)) * 1.2))
    : 300000n;
  const GAS_BUFFER = (maxFeePerGas * gasLimit * 120n) / 100n; // +20% safety margin

  // Batch balance checks (10 at a time) to avoid Alchemy rate limits
  const BATCH_SIZE = 10;
  const funded = [];
  let rpcErrors = 0;
  let belowThreshold = 0;

  for (let i = 0; i < signers.length; i += BATCH_SIZE) {
    const batch = signers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (signer) => {
        try {
          const balance = await provider.getBalance(signer.address);
          if (balance >= txValue + GAS_BUFFER) return signer;
          belowThreshold++;
          return null;
        } catch {
          rpcErrors++;
          return null;
        }
      })
    );
    funded.push(...results.filter(Boolean));
    if (i + BATCH_SIZE < signers.length) {
      await new Promise(r => setTimeout(r, 200)); // small pause between batches
    }
  }

  if (funded.length === 0) {
    const threshold = ethers.formatEther(txValue + GAS_BUFFER);
    await telegramNotify(
      `💼 *Sub-Wallets:* 0 funded — skipped\n` +
      `Checked: ${signers.length} wallets | Need: ${threshold} ETH each` +
      (rpcErrors > 0 ? `\n⚠️ ${rpcErrors} RPC errors (rate limit?)` : "") +
      (belowThreshold > 0 ? `\n💸 ${belowThreshold} wallets below threshold` : "")
    );
    return;
  }

  const fixedSubData = fixSeaDropCalldata(whaleTx.to, adjSubData);
  const mintTx = {
    to: whaleTx.to,
    data: fixedSubData,
    value: txValue,
    gasLimit: whaleTx.gas
      ? BigInt(Math.floor(Number(BigInt(whaleTx.gas)) * 1.2))
      : 300000n,
    type: 2,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };

  const results = await Promise.allSettled(
    funded.map(async (signer) => {
      const tx = await signer.sendTransaction(mintTx);
      await logMint({
        contract: mintTx.to.toLowerCase(),
        wallet: signer.address.toLowerCase(),
        txHash: tx.hash,
        ethSpent: parseFloat(ethers.formatEther(txValue)),
        timestamp: Date.now(),
      });
      return tx;
    })
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

// Manual mint — called from /mint command
export async function executeManualMint(contractAddress, calldata, valueEth, groupName = null) {
  const value = valueEth ? ethers.parseEther(valueEth.toString()) : 0n;
  const data = calldata || "0x1249c58b"; // standard mint() selector

  const subSigners = groupName
    ? getGroupSigners(groupName, provider)
    : getAllSigners(provider);

  // Always include main wallet
  const signers = [mainSigner, ...subSigners];

  if (subSigners.length === 0 && !groupName) {
    throw new Error("No sub-wallets configured");
  }

  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas
    ? (feeData.maxFeePerGas * 120n) / 100n
    : ethers.parseUnits("50", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
    ? feeData.maxPriorityFeePerGas
    : ethers.parseUnits("2", "gwei");
  const GAS_BUFFER = (maxFeePerGas * 300000n * 120n) / 100n; // dynamic: based on live gas price

  const funded = (
    await Promise.all(
      signers.map(async (signer) => {
        try {
          const balance = await provider.getBalance(signer.address);
          return balance >= value + GAS_BUFFER ? signer : null;
        } catch { return null; }
      })
    )
  ).filter(Boolean);

  if (funded.length === 0) {
    throw new Error(`No wallets have enough ETH in ${groupName ? `group "${groupName}"` : "sub-wallets"}`);
  }

  const mintTx = {
    to: contractAddress,
    data,
    value,
    gasLimit: 300000n,
    type: 2,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };

  const results = await Promise.allSettled(
    funded.map(async (signer) => {
      const tx = await signer.sendTransaction(mintTx);
      await logMint({
        contract: contractAddress.toLowerCase(),
        wallet: signer.address.toLowerCase(),
        txHash: tx.hash,
        ethSpent: parseFloat(ethers.formatEther(value)),
        timestamp: Date.now(),
      });
      return tx;
    })
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  const skipped = signers.length - funded.length;

  return { succeeded, failed, skipped, total: signers.length };
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
