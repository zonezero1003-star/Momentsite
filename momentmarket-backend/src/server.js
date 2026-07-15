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

  // fixtureId -> latest odds snapshot, read by predictions.js when minting
  const latestOdds = new Map();

  app.use("/api/predictions", predictionsRouter({ backendWallet, latestOdds }));
  app.use("/api/marketplace", marketplaceRouter({ backendWallet }));

  // Bind the port immediately so Railway's healthcheck passes and the
  // service stays up even if TxLINE is unreachable or rejects us.
  app.listen(config.port, () => {
    console.log(`MomentMarket backend listening on :${config.port}`);
  });

  console.log("Setting up TxLINE session (subscribe + activate)...");
  try {
    const session = await ensureTxLineSession(backendWallet);
    console.log("TxLINE session ready.");
    startResolver({ session, backendWallet, latestOdds });
  } catch (err) {
    console.error("TxLINE session setup failed — server is up, but odds resolution is disabled:", err.message);
  }
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
