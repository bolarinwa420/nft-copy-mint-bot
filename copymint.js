import { ethers } from "ethers";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { getSettings } from "./storage.js";
import { mintEvents } from "./tracker.js";

let provider;
let mainSigner;
let flashbotsProvider;
let telegramNotify; // injected from bot.js

const FLASHBOTS_RELAY = "https://relay.flashbots.net";
const MAX_BLOCKS_TO_TRY = 3;

export async function initCopyMint(ethProvider, signer, notifyFn) {
  provider = ethProvider;
  mainSigner = signer;
  telegramNotify = notifyFn;

  // Initialize Flashbots with a random auth signer (just for signing bundles, not for funds)
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

  // Listen for mint events from tracker
  mintEvents.on("mintDetected", handleMintDetected);
  console.log("[CopyMint] Listening for whale mints...");
}

async function handleMintDetected({ whale, contract, tx }) {
  const settings = getSettings();

  // Always notify even if auto-mint is off
  const alertMsg =
    `🐋 *Whale Mint Detected!*\n\n` +
    `Whale: \`${whale.slice(0, 6)}...${whale.slice(-4)}\`\n` +
    `Contract: \`${contract.slice(0, 6)}...${contract.slice(-4)}\`\n` +
    `Value: ${tx.value ? ethers.formatEther(BigInt(tx.value)) : "0"} ETH\n` +
    `Auto-Mint: ${settings.autoMint ? "✅ Firing..." : "❌ Off"}`;

  await telegramNotify(alertMsg);

  if (!settings.autoMint) return;

  // Check max mint limit
  const txValue = tx.value ? BigInt(tx.value) : 0n;
  const maxWei = ethers.parseEther(settings.maxMintEth || "1.0");
  if (txValue > maxWei) {
    await telegramNotify(
      `⚠️ Skipped — tx value ${ethers.formatEther(txValue)} ETH exceeds your max limit of ${settings.maxMintEth} ETH`
    );
    return;
  }

  await executeCopyMint(tx, settings.mevShield);
}

export async function executeCopyMint(whaleTx, useMevShield = true) {
  const settings = getSettings();

  // Build a copy of the whale's transaction
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
      `🐋 Whale: followed\n` +
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

    if ("error" in simulation) {
      console.warn(`[Flashbots] Simulation error block ${targetBlock}:`, simulation.error.message);
      continue;
    }

    const submission = await flashbotsProvider.sendRawBundle(signedBundle, targetBlock);

    if ("error" in submission) {
      console.warn(`[Flashbots] Submission error block ${targetBlock}:`, submission.error.message);
      continue;
    }

    const waitResult = await submission.wait();

    if (waitResult === 0) {
      // BundleIncluded
      const receipts = await submission.receipts();
      const txHash = receipts[0]?.transactionHash;
      console.log(`[Flashbots] Bundle included in block ${targetBlock}, tx: ${txHash}`);
      return txHash;
    }

    console.log(`[Flashbots] Bundle not included in block ${targetBlock}, trying next...`);
  }

  // Fallback to regular broadcast
  console.log("[Flashbots] All blocks missed — falling back to normal broadcast");
  const sentTx = await mainSigner.sendTransaction(mintTx);
  return sentTx.hash;
}

// Manual mint by contract address (for scheduled mints)
export async function mintByContract(contractAddress, data, value, signer) {
  const mintTx = {
    to: contractAddress,
    data: data || "0x1249c58b", // default: mint()
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
