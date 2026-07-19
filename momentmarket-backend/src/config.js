import "dotenv/config";
import { PublicKey } from "@solana/web3.js";

const NETWORK = process.env.SOLANA_NETWORK || "mainnet";   // ← Changed to mainnet

// Confirmed from TxLINE's World Cup Free Tier docs.
const TXLINE_NETWORKS = {
  mainnet: {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    apiOrigin: "https://txline.txodds.com",
    programId: new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
    txlTokenMint: new PublicKey("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"),
    freeServiceLevels: [1, 12], // 1 = 60s delay, 12 = real-time
  },
  devnet: {
    rpcUrl: "https://api.devnet.solana.com",
    apiOrigin: "https://txline-dev.txodds.com",
    programId: new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
    txlTokenMint: new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
    freeServiceLevels: [1],
  },
};

export const config = {
  network: NETWORK,
  txline: TXLINE_NETWORKS[NETWORK],
  serviceLevel: Number(process.env.TXLINE_SERVICE_LEVEL || 1),
  port: Number(process.env.PORT || 8080),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  rpcUrl: process.env.SOLANA_RPC_URL || TXLINE_NETWORKS[NETWORK].rpcUrl,
  editionCap: Number(process.env.EDITION_CAP || 10),
};
