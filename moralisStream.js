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
  // Use raw body parser — never throws 400, captures body for sig verification and manual JSON parse
  app.use(express.raw({ type: "*/*", limit: "10mb" }));

  app.post("/webhook", (req, res) => {
    // Ack immediately — Moralis requires 200 before processing anything
    res.sendStatus(200);
    console.log("[MoralisStream] Webhook hit");

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString() : "";

    // Verify signature — skip silently on test pings (no x-signature header)
    if (req.headers["x-signature"]) {
      try {
        const isValid = Moralis.Streams.verifySignature({
          body: rawBody,
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
    }

    let body;
    try {
      body = JSON.parse(rawBody || "{}");
    } catch {
      return; // test ping or malformed — already acked 200
    }

    const { txs, confirmed } = body;
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

  // Railway's edge proxy takes a few seconds to start routing traffic after bind.
  // Retry setupStream with backoff — don't crash the process if it keeps failing.
  let delay = 5000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await setupStream();
      return;
    } catch (e) {
      if (attempt === 6) {
        console.error("[MoralisStream] Stream setup failed after all retries — running without stream:", e.message);
        return;
      }
      console.warn(`[MoralisStream] Stream setup attempt ${attempt}/6 failed: ${e.message} — retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30000);
    }
  }
}

// Webhook base URL. Prefer explicit WEBHOOK_URL, but fall back to Railway's
// auto-injected RAILWAY_PUBLIC_DOMAIN — which always tracks the CURRENT domain.
// A stale webhook URL (from domain rotation) is the #1 cause of a dead stream.
function getWebhookUrl() {
  let base = process.env.WEBHOOK_URL;
  if (!base && process.env.RAILWAY_PUBLIC_DOMAIN) {
    base = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/webhook`;
}

async function setupStream() {
  const db = getDb();
  // MORALIS_STREAM_ID env var bypasses stream creation — use when C0006 blocks auto-create
  streamId = process.env.MORALIS_STREAM_ID || db.data.moralisStreamId || null;
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) {
    throw new Error("No WEBHOOK_URL or RAILWAY_PUBLIC_DOMAIN set — cannot configure Moralis webhook");
  }
  const tracked = getTracked();

  if (process.env.MORALIS_STREAM_ID && !db.data.moralisStreamId) {
    db.data.moralisStreamId = process.env.MORALIS_STREAM_ID;
    await db.write();
  }

  const streamConfig = {
    chains: ["0x1"], // Ethereum mainnet
    description: "NFT mint bot — whale tracker",
    tag: "whale-mints",
    webhookUrl,
    includeNativeTxs: true,
  };

  if (!streamId) {
    console.log(`[MoralisStream] Creating new stream → ${webhookUrl}`);
    const stream = await Moralis.Streams.add(streamConfig);
    streamId = stream.id;
    db.data.moralisStreamId = streamId;
    await db.write();
    console.log(`[MoralisStream] Stream created: ${streamId}`);
  } else {
    // Reusing an existing stream — REPAIR it on every boot:
    //  1. re-point the webhook at the current URL (heals domain rotation)
    //  2. force status back to ACTIVE (Moralis auto-pauses after repeated webhook failures)
    console.log(`[MoralisStream] Reusing stream ${streamId} — re-syncing webhook + status`);
    try {
      await Moralis.Streams.update({ id: streamId, ...streamConfig });
      console.log(`[MoralisStream] Webhook URL synced → ${webhookUrl}`);
    } catch (e) {
      console.warn(`[MoralisStream] Stream update failed: ${e.message}`);
    }
    try {
      await Moralis.Streams.updateStatus({ id: streamId, status: "active" });
      console.log(`[MoralisStream] Stream status forced → active`);
    } catch (e) {
      console.warn(`[MoralisStream] Status reactivate failed: ${e.message}`);
    }
  }

  // Log the live stream status so the boot logs show whether it's actually active
  try {
    const info = await Moralis.Streams.getById({ id: streamId });
    const status = info?.toJSON?.()?.status || info?.result?.status || "unknown";
    console.log(`[MoralisStream] Stream status: ${status}`);
  } catch (_) {}

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
