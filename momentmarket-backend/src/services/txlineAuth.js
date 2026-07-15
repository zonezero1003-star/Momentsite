import anchorPkg from "@coral-xyz/anchor";
const anchor = anchorPkg;
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import axios from "axios";
import nacl from "tweetnacl";
import { connection } from "./solana.js";
import { config } from "../config.js";
import txoracleIdl from "../idl/txoracle.json" with { type: "json" };
// NOTE: fetch the real IDL from TxLINE's repo/docs and drop it in src/idl/txoracle.json.
// The one referenced in their docs is network-specific (devnet vs mainnet) — don't mix them.

let cachedSession = null; // { jwt, apiToken, expiresAt, program }

/**
 * One-time on-chain subscribe, then activate to get an API token.
 * Run this once at server startup and cache the result — re-run only
 * when the token expires or the subscription lapses (4-week free tier).
 */
export async function ensureTxLineSession(backendWallet) {
  if (cachedSession && cachedSession.expiresAt > Date.now()) {
    return cachedSession;
  }

  const wallet = new anchor.Wallet(backendWallet);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const program = new anchor.Program(txoracleIdl, provider);
  const { txline } = config;

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")], program.programId
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    txline.txlTokenMint, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")], program.programId
  );
  const userTokenAccount = getAssociatedTokenAddressSync(
    txline.txlTokenMint, provider.wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const txSig = await program.methods
    .subscribe(config.serviceLevel, 4) // 4-week free tier duration
    .accounts({
      user: provider.wallet.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: txline.txlTokenMint,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const authResponse = await axios.post(`${txline.apiOrigin}/auth/guest/start`);
  const jwt = authResponse.data.token;

  const messageString = `${txSig}::${jwt}`; // empty leagues array => standard free bundle
  const signatureBytes = nacl.sign.detached(new TextEncoder().encode(messageString), backendWallet.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  const activationResponse = await axios.post(
    `${txline.apiOrigin}/api/token/activate`,
    { txSig, walletSignature, leagues: [] },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );

  const apiToken = activationResponse.data.token || activationResponse.data;

  cachedSession = {
    jwt,
    apiToken,
    program,
    // 4 weeks in ms, minus a safety buffer of 1 day
    expiresAt: Date.now() + (28 - 1) * 24 * 60 * 60 * 1000,
  };
  return cachedSession;
}
