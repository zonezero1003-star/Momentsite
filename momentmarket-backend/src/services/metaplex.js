import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";
import { create, update, transfer, fetchAsset } from "@metaplex-foundation/mpl-core";
import { generateSigner, keypairIdentity, createNoopSigner, publicKey as toUmiPublicKey, createGenericFile } from "@metaplex-foundation/umi";
import { config } from "../config.js";

let umiInstance = null;

/**
 * Umi is Metaplex's SDK context — set up once with the backend wallet
 * as the mint authority so users don't need SOL or a mint transaction
 * of their own just to receive a Moment NFT.
 */
export function getUmi(backendWallet) {
  if (umiInstance) return umiInstance;

  const umi = createUmi(config.rpcUrl).use(irysUploader());
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(backendWallet.secretKey);
  umi.use(keypairIdentity(umiKeypair));

  umiInstance = umi;
  return umi;
}

/**
 * umi-uploader-irys returns arweave.net-style URIs by default. That host
 * only serves data once it's fully finalized on the Arweave base layer
 * (50+ block confirmations — can take a long time), so a freshly-uploaded
 * file 404s there for a while. The same file is available INSTANTLY at
 * Irys's own gateway under the identical path, so we rewrite the host
 * rather than wait. See: https://docs.irys.xyz
 *
 * IMPORTANT: swap the hostname only, keep the rest of the path/query
 * exactly as returned. uploadJson() and upload() don't necessarily return
 * the same URI shape (uploadJson's path may not be a bare transaction id),
 * so reconstructing the URL from a guessed "last path segment" is unsafe
 * and silently truncates it. Use URL parsing instead of string splitting.
 */
function toIrysGatewayUrl(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.hostname === "arweave.net") {
      parsed.hostname = "gateway.irys.xyz";
    }
    return parsed.toString();
  } catch {
    return uri; // not a parseable absolute URL — return untouched rather than mangle it
  }
}

/**
 * Uploads JSON metadata to Arweave via Irys and returns the URI.
 */
export async function uploadMetadata(umi, metadata) {
  const [uri] = await umi.uploader.uploadJson([metadata]);
  return toIrysGatewayUrl(uri);
}

/**
 * Uploads a raw SVG string as the NFT's visual image and returns its URI.
 * SVG avoids needing canvas/sharp on the server to rasterize a PNG.
 */
export async function uploadSvg(umi, svgString) {
  const file = createGenericFile(new TextEncoder().encode(svgString), "moment-card.svg", {
    contentType: "image/svg+xml",
  });
  const [uri] = await umi.uploader.upload([file]);
  return toIrysGatewayUrl(uri);
}

/**
 * Uploads raw image bytes (e.g. from Gemini's response) and returns the URI.
 */
export async function uploadImageBytes(umi, bytes, mimeType = "image/png") {
  const ext = mimeType.split("/")[1] || "png";
  const file = createGenericFile(new Uint8Array(bytes), `moment-card.${ext}`, {
    contentType: mimeType,
  });
  const [uri] = await umi.uploader.upload([file]);
  return toIrysGatewayUrl(uri);
}

/**
 * Mints a Prediction NFT the instant a user locks in a prediction, with
 * the BACKEND wallet paying gas.
 *
 * NOTE: kept for reference / rollback only. The live mint flow now uses
 * buildMintTransaction() below instead, where the USER pays gas via
 * Phantom. Nothing currently calls this function.
 */
export async function mintPredictionAsset(umi, { ownerPublicKey, name, metadataUri }) {
  const asset = generateSigner(umi);
  const tx = await create(umi, {
    asset,
    name,
    uri: metadataUri,
    owner: toUmiPublicKey(ownerPublicKey),
  }).sendAndConfirm(umi);

  return {
    assetAddress: asset.publicKey.toString(),
    signature: Buffer.from(tx.signature).toString("base64"),
  };
}

/**
 * Builds (but does not send) a mint transaction where the USER is the fee
 * payer — they sign and pay gas in their own wallet via Phantom, not the
 * backend. The backend still needs to be able to resolve() this asset's
 * metadata later (goal happens, card updates), so updateAuthority is set
 * explicitly to the backend wallet's own address rather than left to
 * default to the payer.
 *
 * VERIFY BEFORE TRUSTING IN PRODUCTION: the exact parameter names
 * `payer` / `updateAuthority` below match @metaplex-foundation/mpl-core
 * ^1.1.1's create() builder as documented at the time this was written,
 * but couldn't be tested against a live network in this environment (no
 * internet access in the build sandbox). Do one real test mint and
 * confirm in Solana Explorer that: (1) the new asset's owner is the
 * user's wallet, (2) the user's wallet balance dropped by the network
 * fee, not the backend wallet's, and (3) the asset's update authority is
 * still the backend wallet (so resolveAsset() below keeps working). If
 * any of those three don't hold, the parameter names need correcting
 * against whatever version is actually installed.
 */
export async function buildMintTransaction(umi, backendWallet, { ownerPublicKey, name, metadataUri }) {
  const asset = generateSigner(umi);
  const userPayer = createNoopSigner(toUmiPublicKey(ownerPublicKey));
  const backendAuthorityPubkey = toUmiPublicKey(backendWallet.publicKey.toString());

  const builder = create(umi, {
    asset,
    name,
    uri: metadataUri,
    owner: toUmiPublicKey(ownerPublicKey),
    payer: userPayer,
    updateAuthority: backendAuthorityPubkey,
  });

  const transaction = await builder.buildAndSign(umi);
  const serialized = umi.transactions.serialize(transaction);

  return {
    assetAddress: asset.publicKey.toString(),
    transactionBase64: Buffer.from(serialized).toString("base64"),
  };
}

/**
 * Updates an existing asset's metadata URI — used to "resolve" a
 * prediction once TxLINE confirms the real event (hit or miss).
 */
export async function resolveAsset(umi, { assetAddress, newMetadataUri }) {
  const asset = await fetchAsset(umi, toUmiPublicKey(assetAddress));
  const tx = await update(umi, {
    asset,
    uri: newMetadataUri,
  }).sendAndConfirm(umi);

  return { signature: Buffer.from(tx.signature).toString("base64") };
}

/**
 * Transfers a Moment NFT from seller to buyer — called after the
 * marketplace escrow confirms payment (see marketplace.js).
 */
export async function transferAsset(umi, { assetAddress, fromOwnerPublicKey, toOwnerPublicKey }) {
  const asset = await fetchAsset(umi, toUmiPublicKey(assetAddress));
  const tx = await transfer(umi, {
    asset,
    newOwner: toUmiPublicKey(toOwnerPublicKey),
  }).sendAndConfirm(umi);

  return { signature: Buffer.from(tx.signature).toString("base64") };
}
