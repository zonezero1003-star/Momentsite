import { Connection, Keypair } from "@solana/web3.js";
import { config } from "../config.js";

export const connection = new Connection(config.rpcUrl, "confirmed");

/**
 * The backend holds one custodial "operator" wallet that:
 *  - pays for the one-time TxLINE subscription
 *  - pays gas + acts as mint/update authority for Moment NFTs
 * Users never hand over their keys — they only sign the buy/list
 * transactions in their own wallet (Phantom), built client-side.
 */
export function loadBackendWallet() {
  const raw = process.env.BACKEND_WALLET_SECRET_KEY;
  if (!raw) {
    throw new Error(
      "BACKEND_WALLET_SECRET_KEY is not set. Generate one with `solana-keygen new` " +
      "and paste the secret key array (or base58 string) into your .env"
    );
  }
  let secretKey;
  try {
    // Accept either a JSON array string or a base58 string
    secretKey = raw.trim().startsWith("[")
      ? Uint8Array.from(JSON.parse(raw))
      : Uint8Array.from(Buffer.from(raw, "base64"));
  } catch (err) {
    throw new Error("Could not parse BACKEND_WALLET_SECRET_KEY: " + err.message);
  }
  return Keypair.fromSecretKey(secretKey);
}
