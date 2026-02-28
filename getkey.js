import "dotenv/config";
import { readFileSync } from "fs";

const TARGET = "0x2bb150ee0d8087eee998d23de5ba9c30538b3700";

function xorDecode(encoded, key) {
  const text = Buffer.from(encoded, "base64").toString("binary");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

const ENC_KEY = process.env.MAIN_PRIVATE_KEY?.slice(2, 18);
const db = JSON.parse(readFileSync("./db.json", "utf8"));
const entry = db.wallets.find(w => w.address.toLowerCase() === TARGET.toLowerCase());

if (!entry) {
  console.log("Wallet not found in db.json");
} else {
  const pk = xorDecode(entry.encryptedPk, ENC_KEY);
  console.log("Private key:", pk);
}
