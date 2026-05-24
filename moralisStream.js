import Moralis from "moralis";
import express from "express";
import { mintEvents, tmaEvents } from "./tracker.js";
import { getTracked, getSettings, getDb } from "./storage.js";

const TMA_WALLET = "0xdbd47f66aa2f00b3db03397f260ce9728298c495";

const MARKETPLACE_CONTRACTS = new Map([
  ["0x00000000000000adc04c56bf30ac9d3c0aaf14dc", "OpenSea (Seaport 1.5)"],
  ["0x00000000000001ad428e4906ae43d8f9852d0dd6", "OpenSea (Seaport 1.4)"],
  ["0x0000000000000068f116a894984e2db1123eb395", "OpenSea (Seaport 1.6)"],
  ["0x000000000000ad05ccc4f10045630fb830b95127", "Blur"],
  ["0x0000000000a39bb272e79075ade125fd351887ac", "Blur Bid Pool"],
  ["0x0000000000e655fae4d56241588680f86e3b2377", "LooksRare v2"],
  ["0x74312363e45dcaba76c59ec49a13aa35017c8c9", "X2Y2"],
  ["0x9757f2d2b135150bbeb65308d4a91804107cd8d6", "Reservoir Router"],
]);

const MINT_SELECTORS = new Set([
  "0xa0712d68", "0x1249c58b", "0x6a627842", "0x40c10f19",
  "0x2db11544", "0x84bb1e42", "0xd96a094a", "0xd0def521",
  "0xe7572e43", "0x5eca0752", "0x488a7b25", "0x81012e40",
  "0x0c143a93", "0x4b5f1bd2", "0x8b83209b", "0xf3aaf5b7",
  "0x161ac21f", "0x4b61cd6f", "0x9dbb844d", "0xefef39a1",
  "0xd85d3d27", "0xfa7b9a7b", "0x57bc3d78",
]);

let streamId = null;

function isMintTx(input) {
  if (!input || input === "0x") return false;
  const settings = getSettings();
  if (settings.catchAll) return true;
  return MINT_SELECTORS.has(input.slice(0, 10).toLowerCase());
}

// Normalize Moralis tx payload → shape copymint.js expects
function normalizeTx(tx) {
  return {
    hash: tx.hash,
    from: tx.fromAddress,
    to: tx.toAddress,
    value: tx.value || "0",
    input: tx.input || "0x",
    data: tx.input || "0x",
    gas: tx.gas,
    gasPrice: tx.gasPrice,
  };
}

export async function initMoralisStream() {
  await Moralis.start({ apiKey: process.env.MORALIS_API_KEY });

  const app = express();
  // Capture raw body for signature verification
  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf.toString(); }
  }));

  app.post("/webhook", (req, res) => {
    // Always ack immediately — Moralis requires 200 (including on test webhook during stream creation)
    res.sendStatus(200);

    // Verify signature before processing — drop silently if invalid
    try {
      const isValid = Moralis.Streams.verifySignature({
        body: req.rawBody,
        signature: req.headers["x-signature"],
      });
      if (!isValid) {
        console.warn("[MoralisStream] Invalid webhook signature — dropped");
        return;
      }
    } catch (e) {
      console.warn("[MoralisStream] Signature error:", e.message);
      return;
    }

    const { txs, confirmed } = req.body;

    // Moralis sends unconfirmed first (confirmed=false), then confirmed (confirmed=true)
    // We only copy-mint on confirmed (already mined) to match old behavior
    if (!confirmed) return;
    if (!txs?.length) return;

    const tracked = getTracked();

    for (const tx of txs) {
      const from = tx.fromAddress?.toLowerCase();
      const to = tx.toAddress?.toLowerCase();
      if (!from || !to) continue;

      const normalized = normalizeTx(tx);

      // TMA wallet — secondary market buy alerts
      if (from === TMA_WALLET) {
        const marketplace = MARKETPLACE_CONTRACTS.get(to);
        if (marketplace) {
          console.log(`[TMA] Buy on ${marketplace} → ${tx.hash}`);
          tmaEvents.emit("tmaBuyDetected", { tx: normalized, marketplace });
        }
        continue;
      }

      // Whale mint detection
      if (!tracked.includes(from)) continue;
      if (!isMintTx(tx.input)) continue;

      console.log(`[MoralisStream] Whale mint from ${from} → ${tx.toAddress}`);
      mintEvents.emit("mintDetected", {
        whale: from,
        contract: tx.toAddress,
        tx: normalized,
      });
    }
  });

  const port = process.env.PORT || 3001;
  await new Promise((resolve) => {
    app.listen(port, () => {
      console.log(`[MoralisStream] Webhook listening on :${port}`);
      resolve();
    });
  });

  await setupStream();
}

async function setupStream() {
  const db = getDb();
  streamId = db.data.moralisStreamId || null;
  const webhookUrl = `${process.env.WEBHOOK_URL}/webhook`;
  const tracked = getTracked();

  if (!streamId) {
    console.log(`[MoralisStream] Creating new stream → ${webhookUrl}`);
    const stream = await Moralis.Streams.add({
      chains: ["0x1"], // Ethereum mainnet
      description: "NFT mint bot — whale tracker",
      tag: "whale-mints",
      webhookUrl,
      includeNativeTxs: true,
    });
    streamId = stream.id;
    db.data.moralisStreamId = streamId;
    await db.write();
    console.log(`[MoralisStream] Stream created: ${streamId}`);
  } else {
    console.log(`[MoralisStream] Reusing stream: ${streamId}`);
  }

  // Add tracked addresses + TMA wallet in batches of 50 (Moralis limit per call)
  const addresses = [...new Set([...tracked, TMA_WALLET])];
  for (let i = 0; i < addresses.length; i += 50) {
    await Moralis.Streams.addAddress({
      id: streamId,
      address: addresses.slice(i, i + 50),
    });
  }
  console.log(`[MoralisStream] Watching ${addresses.length} address(es)`);
}

export async function addToMoralisStream(address) {
  if (!streamId) return;
  try {
    await Moralis.Streams.addAddress({ id: streamId, address });
    console.log(`[MoralisStream] Added ${address} to stream`);
  } catch (e) {
    console.warn(`[MoralisStream] Failed to add ${address}:`, e.message);
  }
}

export async function removeFromMoralisStream(address) {
  if (!streamId) return;
  try {
    await Moralis.Streams.deleteAddress({ id: streamId, address });
    console.log(`[MoralisStream] Removed ${address} from stream`);
  } catch (e) {
    console.warn(`[MoralisStream] Failed to remove ${address}:`, e.message);
  }
}
