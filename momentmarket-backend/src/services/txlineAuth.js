import anchorPkg from "@coral-xyz/anchor";
const anchor = anchorPkg;
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import axios from "axios";
import nacl from "tweetnacl";
import { connection } from "./solana.js";
import { config } from "../config.js";
import txoracleIdl from "../idl/txoracle.json" with { type: "json" };

let cachedSession = null;

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

  await ensureAtaExists(provider, userTokenAccount, provider.wallet.publicKey, txline.txlTokenMint, "user");
  await ensureAtaExists(provider, tokenTreasuryVault, tokenTreasuryPda, txline.txlTokenMint, "treasury vault");

  try {
    console.log(`Setting up TxLINE session on ${config.network}...`);

    const SELECTED_LEAGUES = []; // Free standard bundle

    // Add priority fee + compute budget to help confirmation
    const tx = await program.methods
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
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 })
      ])
      .transaction();

    const txSig = await provider.sendAndConfirm(tx, [], { commitment: "confirmed", maxRetries: 3 });

    console.log("Subscribe tx:", txSig);

    // Get guest JWT
    const authResponse = await axios.post(`${txline.apiOrigin}/auth/guest/start`);
    const jwt = authResponse.data.token;
    console.log("Guest JWT received");

    // === Message format per TxLINE docs: txSig:leagues:jwt ===
    const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
    console.log("🔑 Signing exact message:", messageString);

    const messageBytes = new TextEncoder().encode(messageString);
    const signatureBytes = nacl.sign.detached(messageBytes, backendWallet.secretKey);
    const walletSignature = Buffer.from(signatureBytes).toString("base64");

    console.log("🔑 Wallet signature (base64):", walletSignature);
    // === END ===

    // Activate
    const activationResponse = await axios.post(
      `${txline.apiOrigin}/api/token/activate`,
      { txSig, walletSignature, leagues: SELECTED_LEAGUES },
      { headers: { Authorization: `Bearer ${jwt}` } }
    );

    const apiToken = activationResponse.data.token || activationResponse.data;

    cachedSession = {
      jwt,
      apiToken,
      program,
      expiresAt: Date.now() + (28 - 1) * 24 * 60 * 60 * 1000,
    };

    console.log("✅ TxLINE session established successfully");
    return cachedSession;

  } catch (err) {
    console.error("TxLINE setup failed:", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    });
    if (cachedSession) return cachedSession;
    throw err;
  }
}

async function ensureAtaExists(provider, ataAddress, owner, mint, label) {
  const info = await connection.getAccountInfo(ataAddress);
  if (!info) {
    console.log(`Creating ${label} ATA...`);
    const ix = createAssociatedTokenAccountInstruction(
      provider.wallet.publicKey, ataAddress, owner, mint,
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const tx = new anchor.web3.Transaction().add(ix);
    const sig = await provider.sendAndConfirm(tx);
    console.log(`${label} ATA created: ${sig}`);
  } else {
    console.log(`${label} ATA already exists.`);
  }
}
