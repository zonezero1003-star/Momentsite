import { Connection, Keypair } from "@solana/web3.js";
import { config } from "../config.js";

export const connection = new Connection(config.rpcUrl, "confirmed");

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Minimal base58 decoder (no extra dependency) — same algorithm bs58/base-x use.
function base58Decode(str) {
  const bytes = [0];
  for (const char of str) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) throw new Error(`Invalid base58 character: "${char}"`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // preserve leading "1"s, which represent leading zero bytes
  for (let k = 0; str[k] === "1" && k < str.length - 1; k++) {
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

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
  const trimmed = raw.trim();
  let secretKey;
  try {
    // Accept either a JSON array string or a base58 string
    secretKey = trimmed.startsWith("[")
      ? Uint8Array.from(JSON.parse(trimmed))
      : base58Decode(trimmed);
  } catch (err) {
    throw new Error("Could not parse BACKEND_WALLET_SECRET_KEY: " + err.message);
  }
  if (secretKey.length !== 64) {
    throw new Error(
      `BACKEND_WALLET_SECRET_KEY decoded to ${secretKey.length} bytes, expected 64. ` +
      "Double-check you copied the full key."
    );
  }
  return Keypair.fromSecretKey(secretKey);
}
