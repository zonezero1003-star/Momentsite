import { Router } from "express";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getUmi, transferAsset } from "../services/metaplex.js";
import { ListingsStore, PredictionsStore, UsedSignaturesStore } from "../db/store.js";
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
  router.post("/list", async (req, res) => {
    try {
      const { assetAddress, sellerPublicKey, priceSol } = req.body;
      if (!assetAddress || !sellerPublicKey || !priceSol) {
        return res.status(400).json({ error: "assetAddress, sellerPublicKey, priceSol required" });
      }
      const prediction = await PredictionsStore.get(assetAddress);
      if (!prediction || prediction.ownerPublicKey !== sellerPublicKey) {
        return res.status(403).json({ error: "you don't own this asset" });
      }
      const listing = await ListingsStore.create({
        assetAddress,
        sellerPublicKey,
        priceSol,
        status: "active",
        createdAt: Date.now(),
      });
      res.json({ ok: true, listing });
    } catch (err) {
      console.error("list failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/marketplace/listings */
  router.get("/listings", async (req, res) => {
    try {
      const active = await ListingsStore.active();
      const listings = await Promise.all(
        active.map(async (listing) => ({
          ...listing,
          prediction: await PredictionsStore.get(listing.assetAddress),
        }))
      );
      res.json(listings);
    } catch (err) {
      console.error("list listings failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/marketplace/buy
   * body: { assetAddress, buyerPublicKey, paymentSignature }
   * paymentSignature = the confirmed tx where buyer paid seller directly.
   *
   * Two race conditions this guards against, both closed at the database
   * level rather than with an earlier read-then-write check (which leaves
   * a window two concurrent requests could both slip through):
   *   1. Two buyers hitting /buy on the same listing at once — only one
   *      can atomically claim() it; the other gets a clean 409.
   *   2. The same valid payment signature being replayed to claim a
   *      second listing — UsedSignaturesStore.claim() only succeeds once
   *      per signature, globally.
   * If anything after a successful claim fails (bad payment, transfer
   * error), both claims are rolled back so the listing goes back on sale
   * and the signature can be retried, rather than getting stuck.
   */
  router.post("/buy", async (req, res) => {
    const { assetAddress, buyerPublicKey, paymentSignature } = req.body;
    if (!assetAddress || !buyerPublicKey || !paymentSignature) {
      return res.status(400).json({ error: "assetAddress, buyerPublicKey, and paymentSignature are required" });
    }

    const listing = await ListingsStore.get(assetAddress);
    if (!listing || listing.status !== "active") {
      return res.status(404).json({ error: "listing not found or already sold" });
    }

    const claimedListing = await ListingsStore.claim(assetAddress);
    if (!claimedListing) {
      return res.status(409).json({ error: "someone else is already buying this listing — try again" });
    }

    const claimedSignature = await UsedSignaturesStore.claim(paymentSignature, assetAddress);
    if (!claimedSignature) {
      await ListingsStore.releaseClaim(assetAddress);
      return res.status(400).json({ error: "this payment signature has already been used" });
    }

    try {
      // Verify payment actually happened and paid the right amount to the seller.
      const txInfo = await connection.getTransaction(paymentSignature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!txInfo) throw new Error("payment transaction not found or not yet confirmed");

      const paidToSeller = verifyPaymentToSeller(txInfo, listing.sellerPublicKey, listing.priceSol);
      if (!paidToSeller) throw new Error("payment does not match listing price/recipient");

      const umi = getUmi(backendWallet);
      const { signature } = await transferAsset(umi, {
        assetAddress,
        fromOwnerPublicKey: listing.sellerPublicKey,
        toOwnerPublicKey: buyerPublicKey,
      });

      // Sale genuinely completed — remove the listing outright (not a
      // release; it should never go back to 'active').
      await ListingsStore.remove(assetAddress);
      await PredictionsStore.update(assetAddress, { ownerPublicKey: buyerPublicKey });

      res.json({ ok: true, transferSignature: signature });
    } catch (err) {
      console.error("buy failed, rolling back claims:", err);
      await ListingsStore.releaseClaim(assetAddress);
      await UsedSignaturesStore.release(paymentSignature);
      res.status(400).json({ error: err.message });
    }
  });

  /** POST /api/marketplace/cancel  body: { assetAddress, sellerPublicKey } */
  router.post("/cancel", async (req, res) => {
    try {
      const { assetAddress, sellerPublicKey } = req.body;
      const listing = await ListingsStore.get(assetAddress);
      if (!listing || listing.sellerPublicKey !== sellerPublicKey) {
        return res.status(403).json({ error: "not your listing" });
      }
      if (listing.status === "pending") {
        return res.status(409).json({ error: "a purchase is currently in progress for this listing — try again shortly" });
      }
      await ListingsStore.remove(assetAddress);
      res.json({ ok: true });
    } catch (err) {
      console.error("cancel failed:", err);
      res.status(500).json({ error: err.message });
    }
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
