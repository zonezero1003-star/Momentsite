import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import http from "http";

const PROGRAM_ID = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"; // devnet
const RPC_URL = "https://api.devnet.solana.com";
const PORT = process.env.PORT || 8080;

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const programId = new PublicKey(PROGRAM_ID);

  console.log(`Fetching on-chain IDL for ${PROGRAM_ID} on devnet...`);
  const idl = await anchor.Program.fetchIdl(programId, { connection });

  if (!idl) {
    http.createServer((req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("No on-chain IDL found for this program.");
    }).listen(PORT, () => console.log(`Serving 404 on port ${PORT}`));
    return;
  }

  const json = JSON.stringify(idl, null, 2);
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(json);
  }).listen(PORT, () => console.log(`Serving IDL JSON on port ${PORT}`));
}

main().catch((err) => {
  console.error("Failed to fetch IDL:", err);
  process.exit(1);
});
