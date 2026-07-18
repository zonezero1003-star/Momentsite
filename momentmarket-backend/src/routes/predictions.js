import { Router } from "express";
import { getUmi, uploadMetadata, uploadSvg, mintPredictionAsset } from "../services/metaplex.js";
import { buildUnresolvedCardSvg } from "../services/cardImage.js";
import { generateUnresolvedImage } from "../services/geminiImage.js";
import { SUPPORTED_MOMENT_TYPES } from "../services/txlineData.js";
import { PredictionsStore } from "../db/store.js";

export function predictionsRouter({ backendWallet, latestOdds }) {
  const router = Router();

  /**
   * POST /api/predictions/preview
   * body: { fixtureId, match, predictedEvent, predictedWindow, style? }
   * style: "gemini" (default) | "svg" — generates the image WITHOUT minting,
   * so the minter can see it and confirm before anything goes on-chain.
   */
  router.post("/preview", async (req, res) => {
    try {
      const { fixtureId, match, predictedEvent, predictedWindow, style = "gemini" } = req.body;
      if (!fixtureId || !predictedEvent) {
        return res.status(400).json({ error: "fixtureId and predictedEvent are required" });
      }
      if (!SUPPORTED_MOMENT_TYPES.includes(predictedEvent)) {
        return res.status(400).json({ error: `predictedEvent must be one of: ${SUPPORTED_MOMENT_TYPES.join(", ")}` });
      }

      const oddsAtPrediction = latestOdds.get(fixtureId) ?? null;
      const umi = getUmi(backendWallet);
      const params = { match: match || fixtureId, predictedEvent, predictedWindow, oddsAtPrediction };

      let imageUri, source;
      if (style === "svg") {
        imageUri = await uploadSvg(umi, buildUnresolvedCardSvg(params));
        source = "svg";
      } else {
        const result = await generateUnresolvedImage(umi, params);
        imageUri = result.imageUri;
        source = result.source; // "gemini" or "svg-fallback" if Gemini failed
      }

      console.log(`preview generated — source: ${source}, imageUri: ${imageUri}`);
      res.json({ ok: true, imageUri, source, oddsAtPrediction });
    } catch (err) {
      console.error("preview generation failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/predictions
   * body: { ownerPublicKey, fixtureId, match, predictedEvent, predictedWindow, imageUri? }
   * Mints a Prediction NFT. If imageUri is provided (from a prior /preview
   * call the minter approved), it's reused as-is — no regenerating the
   * image and potentially getting a different result at mint time.
   */
  router.post("/", async (req, res) => {
    try {
      const { ownerPublicKey, fixtureId, match, predictedEvent, predictedWindow, imageUri: providedImageUri } = req.body;
      if (!ownerPublicKey || !fixtureId || !predictedEvent) {
        return res.status(400).json({ error: "ownerPublicKey, fixtureId, and predictedEvent are required" });
      }
      if (!SUPPORTED_MOMENT_TYPES.includes(predictedEvent)) {
        return res.status(400).json({ error: `predictedEvent must be one of: ${SUPPORTED_MOMENT_TYPES.join(", ")}` });
      }

      const oddsAtPrediction = latestOdds.get(fixtureId) ?? null;
      const umi = getUmi(backendWallet);
      const params = { match: match || fixtureId, predictedEvent, predictedWindow, oddsAtPrediction };

      let imageUri = providedImageUri;
      let imageSource = "provided";
      if (!imageUri) {
        const result = await generateUnresolvedImage(umi, params);
        imageUri = result.imageUri;
        imageSource = result.source;
      }

      console.log(`minting — imageSource: ${imageSource}, imageUri: ${imageUri}`);

      const metadata = {
        name: `Prediction: ${predictedEvent} - ${match || fixtureId}`,
        description: "A MomentMarket prediction — resolves on-chain when TxLINE confirms the real event.",
        image: imageUri,
        attributes: [
          { trait_type: "Match", value: match || fixtureId },
          { trait_type: "Predicted Event", value: predictedEvent },
          { trait_type: "Predicted Window", value: predictedWindow || "full match" },
          { trait_type: "Odds At Prediction", value: oddsAtPrediction ?? "unavailable" },
          { trait_type: "Status", value: "Unresolved" },
          { trait_type: "Image Source", value: imageSource },
        ],
        properties: {
          files: [{ uri: imageUri, type: imageSource === "gemini" ? "image/png" : "image/svg+xml" }],
          category: "image",
        },
      };

      const metadataUri = await uploadMetadata(umi, metadata);
      console.log(`metadataUri (len ${metadataUri.length}): ${metadataUri}`);
      const { assetAddress, signature } = await mintPredictionAsset(umi, {
        ownerPublicKey,
        name: metadata.name,
        metadataUri,
      });
      console.log(`minted asset ${assetAddress} with uri: ${metadataUri}`);

      const record = PredictionsStore.create({
        assetAddress,
        ownerPublicKey,
        fixtureId,
        match,
        predictedEvent,
        predictedWindow,
        oddsAtPrediction,
        status: "unresolved",
        mintSignature: signature,
        imageSource,
        createdAt: Date.now(),
      });

      res.json({ ok: true, prediction: record });
    } catch (err) {
      console.error("mint prediction failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/predictions/:assetAddress */
  router.get("/:assetAddress", (req, res) => {
    const record = PredictionsStore.get(req.params.assetAddress);
    if (!record) return res.status(404).json({ error: "not found" });
    res.json(record);
  });

  /** GET /api/predictions?owner=... */
  router.get("/", (req, res) => {
    const { owner } = req.query;
    const all = PredictionsStore.all();
    res.json(owner ? all.filter((p) => p.ownerPublicKey === owner) : all);
  });

  return router;
}
