import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";
import { create, update, transfer, fetchAsset } from "@metaplex-foundation/mpl-core";
import { generateSigner, keypairIdentity, publicKey as toUmiPublicKey, createGenericFile } from "@metaplex-foundation/umi";
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
 * Uploads JSON metadata to Arweave via Irys and returns the URI.
 */
export async function uploadMetadata(umi, metadata) {
  const [uri] = await umi.uploader.uploadJson([metadata]);
  return uri;
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
  return uri;
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
  return uri;
}

/**
 * Mints a Prediction NFT the instant a user locks in a prediction.
 * Ownership goes straight to the user's wallet (their public key),
 * even though the backend wallet pays and signs the mint.
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
