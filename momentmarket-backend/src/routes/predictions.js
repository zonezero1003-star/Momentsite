import { Router } from "express";
import { getUmi, uploadMetadata, uploadSvg, buildMintTransaction } from "../services/metaplex.js";
import { buildUnresolvedCardSvg } from "../services/cardImage.js";
import { SUPPORTED_MOMENT_TYPES } from "../services/txlineData.js";
import { PredictionsStore, PendingMintsStore } from "../db/store.js";
import { connection } from "../services/solana.js";
import { config } from "../config.js";

export function predictionsRouter({ backendWallet, latestOdds }) {
  const router = Router();

  async function mintedCount(fixtureId, predictedEvent) {
    // Confirmed mints PLUS unexpired in-flight reservations both count
    // against the cap — otherwise two people signing at the same moment
    // could both land "edition 3 of 10".
    const open = await PredictionsStore.findOpenByFixtureAndType(fixtureId, predictedEvent);
    const pending = await PendingMintsStore.countActive(fixtureId, predictedEvent);
    return open.length + pending;
  }

  /**
   * GET /api/predictions/availability?fixtureId=&predictedEvent=
   * How many of this exact moment are left to mint.
   */
  router.get("/availability", async (req, res) => {
    try {
      const { fixtureId, predictedEvent } = req.query;
      if (!fixtureId || !predictedEvent) {
        return res.status(400).json({ error: "fixtureId and predictedEvent are required" });
      }
      const minted = await mintedCount(fixtureId, predictedEvent);
      const cap = config.editionCap;
      res.json({ ok: true, minted, cap, remaining: Math.max(cap - minted, 0), soldOut: minted >= cap });
    } catch (err) {
      console.error("availability check failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/predictions/preview
   * body: { fixtureId, match, predictedEvent, predictedWindow }
   * Builds the card SVG WITHOUT minting or reserving anything — pure
   * preview. Deterministic SVG, no AI image generation.
   */
  router.post("/preview", async (req, res) => {
    try {
      const { fixtureId, match, predictedEvent, predictedWindow } = req.body;
      if (!fixtureId || !predictedEvent) {
        return res.status(400).json({ error: "fixtureId and predictedEvent are required" });
      }
      if (!SUPPORTED_MOMENT_TYPES.includes(predictedEvent)) {
        return res.status(400).json({ error: `predictedEvent must be one of: ${SUPPORTED_MOMENT_TYPES.join(", ")}` });
      }

      const minted = await mintedCount(fixtureId, predictedEvent);
      if (minted >= config.editionCap) {
        return res.status(409).json({ error: `Sold out — ${config.editionCap}/${config.editionCap} minted for this moment.` });
      }
      const editionNumber = minted + 1;

      const oddsAtPrediction = latestOdds.get(fixtureId) ?? null;
      const umi = getUmi(backendWallet);
      const svg = buildUnresolvedCardSvg({
        match: match || fixtureId, predictedEvent, predictedWindow, oddsAtPrediction,
        editionNumber, editionCap: config.editionCap,
      });
      const imageUri = await uploadSvg(umi, svg);
      console.log(`preview generated — imageUri: ${imageUri}`);

      res.json({ ok: true, imageUri, editionNumber, editionCap: config.editionCap, oddsAtPrediction });
    } catch (err) {
      console.error("preview generation failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/predictions/build
   * body: { ownerPublicKey, fixtureId, match, predictedEvent, predictedWindow, imageUri? }
   *
   * Reserves an edition slot, uploads metadata, and builds (but does not
   * send) the mint transaction with the USER as fee payer — they sign and
   * pay gas themselves via Phantom, not the backend. Returns a base64
   * transaction for the frontend to have the user sign, plus the asset
   * address that transaction will create if confirmed.
   *
   * The reservation expires after 5 minutes (see PendingMintsStore) if
   * the user never completes /confirm — e.g. they close the Phantom
   * popup — so the edition slot doesn't stay stuck as unavailable.
   */
  router.post("/build", async (req, res) => {
    try {
      const { ownerPublicKey, fixtureId, match, predictedEvent, predictedWindow, imageUri: providedImageUri } = req.body;
      if (!ownerPublicKey || !fixtureId || !predictedEvent) {
        return res.status(400).json({ error: "ownerPublicKey, fixtureId, and predictedEvent are required" });
      }
      if (!SUPPORTED_MOMENT_TYPES.includes(predictedEvent)) {
        return res.status(400).json({ error: `predictedEvent must be one of: ${SUPPORTED_MOMENT_TYPES.join(", ")}` });
      }

      const minted = await mintedCount(fixtureId, predictedEvent);
      if (minted >= config.editionCap) {
        return res.status(409).json({ error: `Sold out — ${config.editionCap}/${config.editionCap} minted for this moment.` });
      }
      const editionNumber = minted + 1;

      const oddsAtPrediction = latestOdds.get(fixtureId) ?? null;
      const umi = getUmi(backendWallet);

      let imageUri = providedImageUri;
      if (!imageUri) {
        const svg = buildUnresolvedCardSvg({
          match: match || fixtureId, predictedEvent, predictedWindow, oddsAtPrediction,
          editionNumber, editionCap: config.editionCap,
        });
        imageUri = await uploadSvg(umi, svg);
      }

      const metadata = {
        name: `Prediction: ${predictedEvent} - ${match || fixtureId} #${editionNumber}/${config.editionCap}`,
        description: "A MomentMarket prediction — resolves on-chain when TxLINE confirms the real event.",
        image: imageUri,
        attributes: [
          { trait_type: "Match", value: match || fixtureId },
          { trait_type: "Predicted Event", value: predictedEvent },
          { trait_type: "Predicted Window", value: predictedWindow || "full match" },
          { trait_type: "Odds At Prediction", value: oddsAtPrediction ?? "unavailable" },
          { trait_type: "Status", value: "Unresolved" },
          { trait_type: "Edition", value: `${editionNumber} of ${config.editionCap}` },
        ],
        properties: {
          files: [{ uri: imageUri, type: "image/svg+xml" }],
          category: "image",
        },
      };

      const metadataUri = await uploadMetadata(umi, metadata);
      console.log(`metadataUri (len ${metadataUri.length}): ${metadataUri}`);

      const { assetAddress, transactionBase64 } = await buildMintTransaction(umi, backendWallet, {
        ownerPublicKey, name: metadata.name, metadataUri,
      });

      await PendingMintsStore.reserve(assetAddress, fixtureId, predictedEvent, editionNumber);

      // Stash what /confirm needs to persist later, keyed by assetAddress,
      // without trusting the client to send it back accurately. Kept
      // in-process (not in Postgres) deliberately — it's transient scratch
      // space that only needs to survive a few minutes (same TTL as the
      // reservation itself). If the process restarts mid-mint, that one
      // in-flight mint's /confirm call 404s and the person just retries
      // /build — no data integrity issue results.
      pendingMintDetails.set(assetAddress, {
        ownerPublicKey, fixtureId, match, predictedEvent, predictedWindow,
        oddsAtPrediction, editionNumber,
      });

      res.json({ ok: true, transaction: transactionBase64, assetAddress, editionNumber, editionCap: config.editionCap });
    } catch (err) {
      console.error("build mint transaction failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/predictions/confirm
   * body: { assetAddress, signature }
   * Verifies the user's signed-and-submitted transaction actually landed
   * on-chain and created this exact asset, THEN persists the prediction
   * record. Never trusts the client's word alone that a mint succeeded.
   */
  router.post("/confirm", async (req, res) => {
    try {
      const { assetAddress, signature } = req.body;
      if (!assetAddress || !signature) {
        return res.status(400).json({ error: "assetAddress and signature are required" });
      }

      const details = pendingMintDetails.get(assetAddress);
      if (!details) {
        return res.status(404).json({ error: "no pending mint found for this asset — it may have expired, or /build was never called for it" });
      }

      const txInfo = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!txInfo) return res.status(400).json({ error: "transaction not found or not yet confirmed — try again shortly" });
      if (txInfo.meta?.err) return res.status(400).json({ error: "mint transaction failed on-chain" });

      const accountKeys = (txInfo.transaction.message.staticAccountKeys ?? txInfo.transaction.message.accountKeys)
        .map((k) => k.toString());
      if (!accountKeys.includes(assetAddress)) {
        return res.status(400).json({ error: "this transaction does not create the expected asset" });
      }

      const record = await PredictionsStore.create({
        assetAddress,
        ownerPublicKey: details.ownerPublicKey,
        fixtureId: details.fixtureId,
        match: details.match,
        predictedEvent: details.predictedEvent,
        predictedWindow: details.predictedWindow,
        oddsAtPrediction: details.oddsAtPrediction,
        status: "unresolved",
        mintSignature: signature,
        editionNumber: details.editionNumber,
        editionCap: config.editionCap,
        createdAt: Date.now(),
      });

      await PendingMintsStore.release(assetAddress);
      pendingMintDetails.delete(assetAddress);

      console.log(`minted asset ${assetAddress} with uri already confirmed on-chain via user-paid tx ${signature}`);

      res.json({ ok: true, prediction: record });
    } catch (err) {
      console.error("confirm mint failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/predictions/:assetAddress */
  router.get("/:assetAddress", async (req, res) => {
    try {
      const record = await PredictionsStore.get(req.params.assetAddress);
      if (!record) return res.status(404).json({ error: "not found" });
      res.json(record);
    } catch (err) {
      console.error("get prediction failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/predictions?owner=... */
  router.get("/", async (req, res) => {
    try {
      const { owner } = req.query;
      const all = await PredictionsStore.all();
      res.json(owner ? all.filter((p) => p.ownerPublicKey === owner) : all);
    } catch (err) {
      console.error("list predictions failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// In-memory, per-process map of assetAddress -> the details needed to
// persist a prediction once /confirm verifies the mint landed on-chain.
// See the comment inside /build above for why this stays out of Postgres.
const pendingMintDetails = new Map();
