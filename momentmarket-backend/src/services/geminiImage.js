/**
 * Gemini is the default image source. SVG (cardImage.js) is the automatic
 * fallback if Gemini fails, refuses, times out, or the API key has no quota
 * left — a mint should never break just because an external model had a
 * bad moment mid-demo.
 *
 * Model + free-tier status: unconfirmed and contested as of writing — check
 * your own Google AI Studio quota page for the real numbers on your account
 * rather than trusting any fixed number here.
 */
import axios from "axios";
import { buildUnresolvedCardSvg, buildResolvedCardSvg } from "./cardImage.js";
import { uploadSvg, uploadImageBytes } from "./metaplex.js";

const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function buildUnresolvedPrompt({ match, predictedEvent, predictedWindow, oddsAtPrediction }) {
  return `A premium sports trading card design for a soccer NFT, portrait orientation, dark navy blue background with gold metallic accent lines and a foil border effect, holographic shine texture across the card surface. At the top, small text reading "MOMENTMARKET". The main card face shows a photorealistic dramatic soccer action scene — a player mid-motion about to strike the ball toward goal, stadium packed with fans under floodlights at night, motion blur, dramatic low-angle sports photography style, tension in the moment, no goal scored yet. Below the photo, bold text reading "${match}", and underneath that, text reading "PREDICTING: ${predictedEvent.toUpperCase()} ${predictedWindow ? `(${predictedWindow})` : ""}". Odds shown as small text: "${oddsAtPrediction ?? "—"}". Collectible trading card aesthetic, high production value, sharp lighting contrast between the photorealistic action shot and the graphic card frame elements.`;
}

function buildResolvedPrompt({ match, playerDescription, actualMinute, outcome }) {
  const outcomeText = outcome === "hit" ? "GOAL" : "NO GOAL";
  return `A premium sports trading card design for a soccer NFT, portrait orientation, dark navy blue background with gold metallic accent lines and a foil border effect, holographic shine texture across the card surface. At the top, small text reading "MOMENTMARKET". The main card face features a photorealistic dynamic action photo of ${playerDescription}, ball just crossing the goal line into the net, goalkeeper diving and beaten, stadium packed with fans under floodlights, motion blur on the ball, dramatic low-angle sports photography style. Below the photo, bold text reading "${match}", and underneath that, text reading "${outcomeText} — ${actualMinute}'". Collectible trading card aesthetic, high production value, sharp lighting contrast between the photorealistic action shot and the graphic card frame elements.`;
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    },
    {
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      timeout: 45000,
    }
  );

  const parts = res.data?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart) throw new Error("Gemini response contained no image data (likely refused or filtered)");

  return {
    bytes: Buffer.from(imagePart.inlineData.data, "base64"),
    mimeType: imagePart.inlineData.mimeType || "image/png",
  };
}

/**
 * Generates the unresolved (just-predicted) card image. Tries Gemini first,
 * falls back to the SVG generator on any failure.
 */
export async function generateUnresolvedImage(umi, params) {
  try {
    const prompt = buildUnresolvedPrompt(params);
    const { bytes, mimeType } = await callGemini(prompt);
    const uri = await uploadImageBytes(umi, bytes, mimeType);
    return { imageUri: uri, source: "gemini" };
  } catch (err) {
    console.warn("Gemini image generation failed, falling back to SVG:", err.message);
    const svg = buildUnresolvedCardSvg(params);
    const uri = await uploadSvg(umi, svg);
    return { imageUri: uri, source: "svg-fallback" };
  }
}

/**
 * Generates the resolved (goal confirmed) card image. Same fallback pattern.
 * `playerDescription` should stay generic ("a player in a white and light
 * blue kit with a captain's armband") unless you've deliberately accepted
 * the real-likeness tradeoff discussed earlier.
 */
export async function generateResolvedImage(umi, params) {
  try {
    const prompt = buildResolvedPrompt(params);
    const { bytes, mimeType } = await callGemini(prompt);
    const uri = await uploadImageBytes(umi, bytes, mimeType);
    return { imageUri: uri, source: "gemini" };
  } catch (err) {
    console.warn("Gemini image generation failed, falling back to SVG:", err.message);
    const svg = buildResolvedCardSvg(params);
    const uri = await uploadSvg(umi, svg);
    return { imageUri: uri, source: "svg-fallback" };
  }
}
