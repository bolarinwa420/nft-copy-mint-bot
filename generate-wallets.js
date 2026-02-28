import { ethers } from "ethers";
import { writeFileSync } from "fs";

const COUNT = 100;
const wallets = [];

console.log(`Generating ${COUNT} fresh wallets...\n`);

for (let i = 0; i < COUNT; i++) {
  const wallet = ethers.Wallet.createRandom();
  wallets.push({ address: wallet.address, privateKey: wallet.privateKey });
}

// Save addresses to one file (safe to share for receiving ETH)
const addresses = wallets.map(w => w.address).join("\n");
writeFileSync("wallet-addresses.txt", addresses);

// Save private keys to a separate file (KEEP THIS PRIVATE)
const keys = wallets.map(w => w.privateKey).join("\n");
writeFileSync("wallet-keys.txt", keys);

// Save full info (address + key) for your own reference
const full = wallets.map((w, i) => `Wallet ${i + 1}\nAddress: ${w.address}\nKey: ${w.privateKey}`).join("\n\n");
writeFileSync("wallet-full.txt", full);

console.log(`✅ Done! 3 files created:\n`);
console.log(`  wallet-addresses.txt — addresses only (safe to share)`);
console.log(`  wallet-keys.txt      — private keys only (upload this to bot)`);
console.log(`  wallet-full.txt      — full info (KEEP SECRET)\n`);
console.log(`⚠️  Keep wallet-keys.txt and wallet-full.txt PRIVATE. Never share them.`);
