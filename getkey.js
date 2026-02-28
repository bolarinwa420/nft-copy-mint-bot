import "dotenv/config";
import { readFileSync } from "fs";

// Match by first 6 + last 4 chars (what the bot shows)
const PARTIALS = [
  { start: "0x2bb1", end: "3700" },
  { start: "0xdae5", end: "a9a4" },
  { start: "0x5a9d", end: "adbb" },
  { start: "0x3d78", end: "16e9" },
];

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

for (const { start, end } of PARTIALS) {
  const entry = db.wallets.find(w =>
    w.address.startsWith(start.toLowerCase()) &&
    w.address.endsWith(end.toLowerCase())
  );
  if (!entry) {
    console.log(`NOT FOUND: ${start}...${end}`);
  } else {
    const pk = xorDecode(entry.encryptedPk, ENC_KEY);
    console.log(`\nAddress: ${entry.address}\nPrivate Key: ${pk}`);
  }
}
