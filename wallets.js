import { ethers } from "ethers";
import { addSubWallet, removeSubWallet, getSubWallets, getGroupWallets } from "./storage.js";

// Simple XOR "encryption" for local storage — not military grade but keeps raw keys out of plaintext
function xorEncode(text, key) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return Buffer.from(out, "binary").toString("base64");
}
function xorDecode(encoded, key) {
  const text = Buffer.from(encoded, "base64").toString("binary");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

const ENC_KEY = process.env.MAIN_PRIVATE_KEY?.slice(2, 18) || "nftbotkey123456";

export async function addWallet(privateKey) {
  const wallet = new ethers.Wallet(privateKey);
  const encryptedPk = xorEncode(privateKey, ENC_KEY);
  await addSubWallet(wallet.address, encryptedPk);
  return wallet.address;
}

export async function deleteWallet(address) {
  await removeSubWallet(address);
}

export function listWallets() {
  return getSubWallets().map(w => w.address);
}

export function getWalletSigner(address, provider) {
  const entry = getSubWallets().find(
    w => w.address.toLowerCase() === address.toLowerCase()
  );
  if (!entry) throw new Error(`Wallet ${address} not found`);
  const pk = xorDecode(entry.encryptedPk, ENC_KEY);
  return new ethers.Wallet(pk, provider);
}

export function getAllSigners(provider) {
  return getSubWallets().map(w => {
    const pk = xorDecode(w.encryptedPk, ENC_KEY);
    return new ethers.Wallet(pk, provider);
  });
}

// Send ETH from main wallet to sub-wallets (all or specific group)
export async function distributeGas(mainSigner, amountEth, groupName = null) {
  const wallets = groupName ? getGroupWallets(groupName) : getSubWallets();
  if (!wallets || wallets.length === 0) {
    throw new Error(groupName ? `Group "${groupName}" not found or empty` : "No sub-wallets to distribute to");
  }

  const value = ethers.parseEther(amountEth);
  const results = [];

  for (const w of wallets) {
    try {
      const tx = await mainSigner.sendTransaction({ to: w.address, value });
      results.push({ address: w.address, txHash: tx.hash, status: "sent" });
    } catch (err) {
      results.push({ address: w.address, error: err.message, status: "failed" });
    }
  }
  return results;
}

// Sweep ETH from all sub-wallets back to main wallet
export async function sweepGas(provider, mainAddress) {
  const wallets = getSubWallets();
  const results = [];
  const GAS_COST = ethers.parseEther("0.0001"); // reserve for gas

  for (const w of wallets) {
    try {
      const pk = xorDecode(w.encryptedPk, ENC_KEY);
      const signer = new ethers.Wallet(pk, provider);
      const balance = await provider.getBalance(w.address);
      if (balance <= GAS_COST) {
        results.push({ address: w.address, status: "skipped", reason: "insufficient balance" });
        continue;
      }
      const sendAmount = balance - GAS_COST;
      const tx = await signer.sendTransaction({ to: mainAddress, value: sendAmount });
      results.push({ address: w.address, txHash: tx.hash, status: "sent" });
    } catch (err) {
      results.push({ address: w.address, error: err.message, status: "failed" });
    }
  }
  return results;
}

// ERC721 transferFrom — sweep NFTs from sub-wallets to main
const ERC721_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
];

export async function sweepNFTs(contractAddress, provider, mainAddress) {
  const wallets = getSubWallets();
  const results = [];

  for (const w of wallets) {
    try {
      const pk = xorDecode(w.encryptedPk, ENC_KEY);
      const signer = new ethers.Wallet(pk, provider);
      const contract = new ethers.Contract(contractAddress, ERC721_ABI, signer);
      const balance = await contract.balanceOf(w.address);

      if (balance === 0n) {
        results.push({ address: w.address, status: "skipped", reason: "no NFTs" });
        continue;
      }

      const txHashes = [];
      for (let i = 0; i < balance; i++) {
        const tokenId = await contract.tokenOfOwnerByIndex(w.address, 0); // always index 0 as we transfer
        const tx = await contract.safeTransferFrom(w.address, mainAddress, tokenId);
        txHashes.push(tx.hash);
      }
      results.push({ address: w.address, status: "swept", txHashes, count: Number(balance) });
    } catch (err) {
      results.push({ address: w.address, error: err.message, status: "failed" });
    }
  }
  return results;
}
