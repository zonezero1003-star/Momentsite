/**
 * Gemini is the primary image source for Moment NFTs — photoreal PNGs in
 * portrait orientation. If Gemini fails to generate OR fails to upload
 * (network blip, quota, refusal, timeout), we fall back to a
 * deterministic card template (cardImage.js) — but that template is
 * rasterized to a real PNG buffer before it ever gets uploaded, never
 * uploaded as SVG. Most wallets (Phantom included) don't render
 * image/svg+xml at all, so the fallback has to be an actual raster image
 * to be functional at the mint level, same as the Gemini path.
 *
 * Generalized beyond goals: goal, corner, yellow_card, red_card, shot, var
 * each get a distinct scene description. Real player names used where the
 * feed carries PlayerId (goal, cards, shot) — falls back to generic
 * description where it doesn't (corner, var) or when lookup fails.
 */
import axios from "axios";
import { buildUnresolvedCardPng, buildResolvedCardPng } from "./cardImage.js";
import { uploadImageBytes } from "./metaplex.js";

const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function buildUnresolvedPrompt({ match, predictedEvent, predictedWindow, oddsAtPrediction }) {
  const sceneByType = {
    goal: "a player mid-motion about to strike the ball toward goal, goalkeeper alert and set",
    corner: "a player standing over the ball at the corner flag, teammates and defenders jostling for position in the box",
    yellow_card: "a referee reaching for their pocket, reaching for a card, players nearby reacting",
    red_card: "a referee holding a card aloft with a stern expression, a player reacting with disbelief",
    shot: "a player striking the ball with full power, body leaning into the shot, goalkeeper reacting",
    var: "a referee at the pitch-side monitor reviewing a replay, players standing by waiting",
  };
  const scene = sceneByType[predictedEvent] || sceneByType.goal;

  return `A premium sports trading card design for a soccer NFT, portrait orientation, dark navy blue background with gold metallic accent lines and a foil border effect, holographic shine texture across the card surface. At the top, small text reading "MOMENTMARKET". The main card face shows a photorealistic dramatic soccer scene — ${scene}, stadium packed with fans under floodlights at night, motion blur, dramatic low-angle sports photography style, tension in the moment, outcome not yet decided. Below the photo, bold text reading "${match}", and underneath that, text reading "PREDICTING: ${predictedEvent.toUpperCase().replace("_", " ")} ${predictedWindow ? `(${predictedWindow})` : ""}". Odds shown as small text: "${oddsAtPrediction ?? "—"}". Collectible trading card aesthetic, high production value, sharp lighting contrast between the photorealistic action shot and the graphic card frame elements.`;
}

/**
 * Resolved-moment prompt, generalized across moment types. Never send
 * literal bracket placeholders — always interpolate real values first.
 */
function buildResolvedPrompt({ match, momentType, playerName, team, opponent, actualMinute, outcome, extra }) {
  const matchLabel = match || (team && opponent ? `${team} vs ${opponent}` : "Match");

  const outcomeLabelByType = {
    goal: outcome === "hit" ? `GOAL — ${actualMinute}'` : `NO GOAL — ${actualMinute}'`,
    corner: outcome === "hit" ? `CORNER — ${actualMinute}'` : `NO CORNER — ${actualMinute}'`,
    yellow_card: outcome === "hit" ? `YELLOW CARD — ${actualMinute}'` : `NO CARD — ${actualMinute}'`,
    red_card: outcome === "hit" ? `RED CARD — ${actualMinute}'` : `NO CARD — ${actualMinute}'`,
    shot: outcome === "hit" ? `SHOT ${extra?.shotOutcome?.toUpperCase() || ""} — ${actualMinute}'` : `NO SHOT — ${actualMinute}'`,
    var: outcome === "hit" ? `VAR: ${extra?.varType?.toUpperCase() || "REVIEWED"} — ${actualMinute}'` : `VAR: NO REVIEW — ${actualMinute}'`,
  };
  const outcomeLabel = outcomeLabelByType[momentType] || outcomeLabelByType.goal;

  const sceneByType = {
    goal: playerName
      ? `${playerName} scoring a goal for ${team || "the attacking team"}, ball just crossing the goal line into the net, goalkeeper diving and beaten`
      : `a player in a white and light blue kit with a captain's armband scoring a goal, ball just crossing the goal line into the net, goalkeeper diving and beaten`,
    corner: `a player striking a corner kick from the flag, the ball arcing into a crowded penalty box`,
    yellow_card: playerName
      ? `a referee showing a yellow card to ${playerName}, ${playerName} reacting with hands raised`
      : `a referee showing a yellow card to a player, the player reacting with hands raised`,
    red_card: playerName
      ? `a referee showing a red card to ${playerName}, ${playerName} walking off with head down`
      : `a referee showing a red card to a player, the player walking off with head down`,
    shot: playerName
      ? `${playerName} striking a powerful shot on goal, ball in motion with speed lines`
      : `a player striking a powerful shot on goal, ball in motion with speed lines`,
    var: `a referee at the pitch-side monitor reviewing a play, an official signaling the review outcome`,
  };
  const scene = sceneByType[momentType] || sceneByType.goal;

  return `A premium sports trading card design for a soccer NFT, portrait orientation, dark navy blue background with gold metallic accent lines and a foil border effect, holographic shine texture across the card surface. At the top, small text reading "MOMENTMARKET". The main card face features a photorealistic dynamic action photo of ${scene}, stadium packed with fans under floodlights, motion blur, dramatic low-angle sports photography style. Below the photo, bold text reading "${matchLabel}", and underneath that, text reading "${outcomeLabel}". Collectible trading card aesthetic, high production value, sharp lighting contrast between the photorealistic action shot and the graphic card frame elements.`;
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      // "2:3" is the closest of Gemini 2.5 Flash Image's supported portrait
      // ratios to this card's actual layout (640x900 ≈ 0.71, vs 2:3 ≈ 0.67)
      // — without this, the model defaults to square and the frontend's
      // object-cover crop loses a meaningful chunk of the generated scene.
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "2:3" } },
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

export async function generateUnresolvedImage(umi, params) {
  try {
    const prompt = buildUnresolvedPrompt(params);
    const { bytes, mimeType } = await callGemini(prompt);
    const uri = await uploadImageBytes(umi, bytes, mimeType);
    return { imageUri: uri, source: "gemini" };
  } catch (err) {
    console.warn("Gemini image generation/upload failed, falling back to rendered PNG template:", err.message);
    try {
      const pngBytes = await buildUnresolvedCardPng(params);
      const uri = await uploadImageBytes(umi, pngBytes, "image/png");
      console.log("PNG fallback uploaded successfully. imageUri:", uri);
      return { imageUri: uri, source: "png-fallback" };
    } catch (fallbackErr) {
      console.error("PNG fallback upload ALSO failed:", fallbackErr);
      throw fallbackErr;
    }
  }
}

export async function generateResolvedImage(umi, params) {
  try {
    const prompt = buildResolvedPrompt(params);
    const { bytes, mimeType } = await callGemini(prompt);
    const uri = await uploadImageBytes(umi, bytes, mimeType);
    return { imageUri: uri, source: "gemini" };
  } catch (err) {
    console.warn("Gemini image generation/upload failed, falling back to rendered PNG template:", err.message);
    try {
      const pngBytes = await buildResolvedCardPng({
        match: params.match,
        actualMinute: params.actualMinute,
        outcome: params.outcome,
        momentType: params.momentType,
      });
      const uri = await uploadImageBytes(umi, pngBytes, "image/png");
      console.log("PNG fallback uploaded successfully. imageUri:", uri);
      return { imageUri: uri, source: "png-fallback" };
    } catch (fallbackErr) {
      console.error("PNG fallback upload ALSO failed:", fallbackErr);
      throw fallbackErr;
    }
  }
}
