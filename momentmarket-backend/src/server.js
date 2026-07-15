import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { loadBackendWallet } from "./services/solana.js";
import { ensureTxLineSession } from "./services/txlineAuth.js";
import { startResolver } from "./services/resolver.js";
import { predictionsRouter } from "./routes/predictions.js";
import { marketplaceRouter } from "./routes/marketplace.js";

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, network: config.network }));

async function main() {
  const backendWallet = loadBackendWallet();
  console.log("Backend wallet:", backendWallet.publicKey.toString());

  console.log("Setting up TxLINE session (subscribe + activate)...");
  const session = await ensureTxLineSession(backendWallet);
  console.log("TxLINE session ready.");

  // fixtureId -> latest odds snapshot, read by predictions.js when minting
  const latestOdds = new Map();

  app.use("/api/predictions", predictionsRouter({ backendWallet, latestOdds }));
  app.use("/api/marketplace", marketplaceRouter({ backendWallet }));

  startResolver({ session, backendWallet, latestOdds });

  app.listen(config.port, () => {
    console.log(`MomentMarket backend listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
