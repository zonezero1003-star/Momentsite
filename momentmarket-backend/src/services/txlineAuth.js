import anchorPkg from "@coral-xyz/anchor";
const anchor = anchorPkg;
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import axios from "axios";
import nacl from "tweetnacl";
import { connection } from "./solana.js";
import { config } from "../config.js";
import txoracleIdl from "../idl/txoracle.json" with { type: "json" };
// NOTE: Replace this placeholder IDL with the real one from TxLINE's devnet examples repo.

let cachedSession = null; // { jwt, apiToken, expiresAt, program }

/**
 * Ensures we have a valid TxLINE session (on-chain subscribe + API token).
 * Creates required ATAs if they don't exist.
 * Safe to call on every startup.
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

  // PDAs and ATAs
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

  // Create ATAs if missing (this was causing the AccountNotInitialized crash)
  await ensureAtaExists(provider, userTokenAccount, provider.wallet.publicKey, txline.txlTokenMint, "user");
  await ensureAtaExists(provider, tokenTreasuryVault, tokenTreasuryPda, txline.txlTokenMint, "treasury vault");

  // Subscribe + Activate
  try {
    console.log("Setting up TxLINE session (subscribe + activate)...");

    const txSig = await program.methods
      .subscribe(config.serviceLevel, 4)
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

    const messageString = `\( {txSig}:: \){jwt}`;
    const signatureBytes = nacl.sign.detached(
      new TextEncoder().encode(messageString),
      backendWallet.secretKey
    );
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
      expiresAt: Date.now() + (28 - 1) * 24 * 60 * 60 * 1000,
    };

    console.log("TxLINE session established successfully.");
    return cachedSession;

  } catch (err) {
    console.error("Failed to establish TxLINE session:", err.message || err);

    if (cachedSession) {
      console.warn("Using previously cached TxLINE session as fallback.");
      return cachedSession;
    }

    throw new Error(`TxLINE session setup failed: ${err.message || err}`);
  }
}

/** Helper: Create ATA if it doesn't exist */
async function ensureAtaExists(provider, ataAddress, owner, mint, label) {
  const info = await connection.getAccountInfo(ataAddress);
  if (!info) {
    console.log(`Creating ${label} ATA...`);
    const ix = createAssociatedTokenAccountInstruction(
      provider.wallet.publicKey,
      ataAddress,
      owner,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const tx = new anchor.web3.Transaction().add(ix);
    const sig = await provider.sendAndConfirm(tx);
    console.log(`${label} ATA created: ${sig}`);
  } else {
    console.log(`${label} ATA already exists.`);
  }
}
