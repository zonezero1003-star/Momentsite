import { Router } from "express";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getUmi, transferAsset } from "../services/metaplex.js";
import { ListingsStore, PredictionsStore } from "../db/store.js";
import { connection } from "../services/solana.js";

/**
 * Fixed-price list/buy, no bidding — deliberately minimal for a 5-day build.
 * Flow:
 *  1. Seller lists (off-chain record only — asset stays in their wallet).
 *  2. Buyer sends SOL directly to seller's wallet (built client-side, buyer signs in Phantom).
 *  3. Buyer submits the signed payment tx signature here; backend verifies
 *     the payment actually landed, then transfers the NFT via the backend's
 *     update/mint authority.
 * This avoids needing a custom Anchor escrow program under time pressure —
 * trust is backend-mediated, which is fine for a hackathon demo but should
 * be called out as a simplification if judges ask about trust assumptions.
 */
export function marketplaceRouter({ backendWallet }) {
  const router = Router();

  /** POST /api/marketplace/list  body: { assetAddress, sellerPublicKey, priceSol } */
  router.post("/list", (req, res) => {
    const { assetAddress, sellerPublicKey, priceSol } = req.body;
    if (!assetAddress || !sellerPublicKey || !priceSol) {
      return res.status(400).json({ error: "assetAddress, sellerPublicKey, priceSol required" });
    }
    const prediction = PredictionsStore.get(assetAddress);
    if (!prediction || prediction.ownerPublicKey !== sellerPublicKey) {
      return res.status(403).json({ error: "you don't own this asset" });
    }
    const listing = ListingsStore.create({
      assetAddress,
      sellerPublicKey,
      priceSol,
      status: "active",
      createdAt: Date.now(),
    });
    res.json({ ok: true, listing });
  });

  /** GET /api/marketplace/listings */
  router.get("/listings", (req, res) => {
    const listings = ListingsStore.active().map((listing) => ({
      ...listing,
      prediction: PredictionsStore.get(listing.assetAddress),
    }));
    res.json(listings);
  });

  /**
   * POST /api/marketplace/buy
   * body: { assetAddress, buyerPublicKey, paymentSignature }
   * paymentSignature = the confirmed tx where buyer paid seller directly.
   */
  router.post("/buy", async (req, res) => {
    try {
      const { assetAddress, buyerPublicKey, paymentSignature } = req.body;
      const listing = ListingsStore.get(assetAddress);
      if (!listing || listing.status !== "active") {
        return res.status(404).json({ error: "listing not found or already sold" });
      }

      // Verify payment actually happened and paid the right amount to the seller.
      const txInfo = await connection.getTransaction(paymentSignature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!txInfo) return res.status(400).json({ error: "payment transaction not found or not yet confirmed" });

      const paidToSeller = verifyPaymentToSeller(txInfo, listing.sellerPublicKey, listing.priceSol);
      if (!paidToSeller) {
        return res.status(400).json({ error: "payment does not match listing price/recipient" });
      }

      const umi = getUmi(backendWallet);
      const { signature } = await transferAsset(umi, {
        assetAddress,
        fromOwnerPublicKey: listing.sellerPublicKey,
        toOwnerPublicKey: buyerPublicKey,
      });

      ListingsStore.remove(assetAddress);
      PredictionsStore.update(assetAddress, { ownerPublicKey: buyerPublicKey });

      res.json({ ok: true, transferSignature: signature });
    } catch (err) {
      console.error("buy failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /api/marketplace/cancel  body: { assetAddress, sellerPublicKey } */
  router.post("/cancel", (req, res) => {
    const { assetAddress, sellerPublicKey } = req.body;
    const listing = ListingsStore.get(assetAddress);
    if (!listing || listing.sellerPublicKey !== sellerPublicKey) {
      return res.status(403).json({ error: "not your listing" });
    }
    ListingsStore.remove(assetAddress);
    res.json({ ok: true });
  });

  return router;
}

function verifyPaymentToSeller(txInfo, sellerPublicKey, priceSol) {
  const expectedLamports = Math.round(priceSol * 1_000_000_000);
  const accountKeys = txInfo.transaction.message.staticAccountKeys ?? txInfo.transaction.message.accountKeys;
  const sellerIndex = accountKeys.findIndex((k) => k.toString() === sellerPublicKey);
  if (sellerIndex === -1) return false;

  const pre = txInfo.meta.preBalances[sellerIndex];
  const post = txInfo.meta.postBalances[sellerIndex];
  return post - pre >= expectedLamports;
}
