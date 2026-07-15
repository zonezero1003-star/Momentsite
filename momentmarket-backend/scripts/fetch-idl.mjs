// One-off script: pulls the real IDL directly from the deployed devnet
// program (published on-chain via `anchor idl init`), so it's guaranteed
// to match exactly — no dependency on the GitHub repo being up to date.
//
// Usage on Railway:
//   1. Temporarily set your Railway service's start command to:
//        node scripts/fetch-idl.mjs
//      (or just run it locally with network access: `node fetch-idl.mjs`)
//   2. Redeploy / run, then copy the JSON that gets printed to the logs.
//   3. Paste it into src/idl/txoracle.json, replacing the placeholder.
//   4. Revert the start command back to `npm start`.

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";

const PROGRAM_ID = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"; // devnet
const RPC_URL = "https://api.devnet.solana.com";

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const programId = new PublicKey(PROGRAM_ID);

  console.log(`Fetching on-chain IDL for ${PROGRAM_ID} on devnet...`);

  const idl = await anchor.Program.fetchIdl(programId, { connection });

  if (!idl) {
    console.error(
      "No on-chain IDL found for this program. It may not have been " +
      "published via `anchor idl init`. Fall back to the GitHub repo: " +
      "https://github.com/txodds/tx-on-chain/tree/main/idl"
    );
    process.exit(1);
  }

  console.log("--- COPY EVERYTHING BELOW THIS LINE INTO src/idl/txoracle.json ---");
  console.log(JSON.stringify(idl, null, 2));
  console.log("--- COPY EVERYTHING ABOVE THIS LINE ---");
}

main().catch((err) => {
  console.error("Failed to fetch IDL:", err);
  process.exit(1);
});
