/**
 * Generates the entire visual face of a Moment NFT as hand-designed SVG —
 * no AI image generation, no player photos/likeness, no external API
 * calls or failure modes. Every value on the card comes directly from
 * TxLINE's data (or the prediction record derived from it). This is the
 * ONLY image source for Moment NFTs — there is no fallback path because
 * there is nothing to fall back from.
 *
 * ONE layout/structure (the original design) — variety comes from THREE
 * metallic color themes instead: Gold, Silver, Diamond, each with its
 * own sparkle tone. Theme choice is DETERMINISTIC — derived from
 * editionNumber, not Math.random() — so a /preview call and the /build
 * call that actually mints it always render the identical card. It
 * still looks "random" from one mint to the next since edition numbers
 * increment, but never inconsistent within a single mint. Never switch
 * this to true per-call randomness: a preview the user approved must
 * match what actually gets minted.
 */

const INK = "#050B14";
const PANEL = "#0B1830";
const GOLD_SOFT = "#8C7A3E";
const WHITE = "#F4F1E8";
const MUTED = "#6C7C93";

const THEMES = ["gold", "silver", "diamond"];

const THEME_GRADIENT_ID = {
  gold: "metallicGold",
  silver: "metallicSilver",
  diamond: "metallicDiamond",
};
const THEME_SPARKLE_ID = {
  gold: "sparkleGlowGold",
  silver: "sparkleGlowSilver",
  diamond: "sparkleGlowDiamond",
};
const THEME_SPARKLE_FILL = {
  gold: "#FFF9E5",
  silver: "#EEF0F2",
  diamond: "#4FE0F0",
};
const THEME_SPARKLE_FILL_2 = {
  // Diamond gets a second, contrasting sparkle color for a prismatic
  // flash — real diamonds refract light into more than one hue, which
  // is what actually reads as "diamond" instead of just "pale blue".
  diamond: "#E39EF0",
};
const THEME_LABEL_TINT = {
  gold: "#8C7A3E",
  silver: "#7A828A",
  diamond: "#3FAFC7",
};

function pickTheme(editionNumber) {
  const n = Number(editionNumber);
  if (!Number.isFinite(n)) return THEMES[0];
  const i = ((n - 1) % THEMES.length + THEMES.length) % THEMES.length;
  return THEMES[i];
}

export function buildUnresolvedCardSvg(params) {
  return classicUnresolved(params, pickTheme(params.editionNumber));
}

export function buildResolvedCardSvg(params) {
  return classicResolved(params, pickTheme(params.editionNumber));
}

// ============================================================
// The one layout — themed by pickTheme() above.
// ============================================================

function windowLabel(predictedWindow) {
  return {
    first_half: "First Half",
    second_half: "Second Half",
    final_15: "Final 15 Minutes",
  }[predictedWindow] || predictedWindow || "Full Match";
}

function classicUnresolved({ match, predictedEvent, predictedWindow, oddsAtPrediction, editionNumber, editionCap, backingTeamName }, theme) {
  const eventLabel = (predictedEvent || "").toUpperCase().replace(/_/g, " ");
  const metal = `url(#${THEME_GRADIENT_ID[theme]})`;
  return `
<svg width="640" height="900" viewBox="0 0 640 900" xmlns="http://www.w3.org/2000/svg">
  ${defs()}
  <rect width="640" height="900" fill="url(#cardBg)"/>
  ${cornerFrame(metal)}
  ${soccerBall(320, 72, 22, metal)}

  <text x="320" y="118" font-family="'Courier New', monospace" font-size="13" letter-spacing="6" fill="${MUTED}" text-anchor="middle">MOMENTMARKET</text>
  <text x="320" y="140" font-family="'Courier New', monospace" font-size="11" letter-spacing="4" fill="${THEME_LABEL_TINT[theme]}" text-anchor="middle">UNRESOLVED PREDICTION</text>

  ${goldRule(64, 170, 512, metal, theme)}

  <text x="320" y="230" font-family="Georgia, 'Times New Roman', serif" font-size="30" font-weight="bold" fill="${WHITE}" text-anchor="middle">${escapeXml(match)}</text>

  <text x="320" y="330" font-family="'Courier New', monospace" font-size="12" letter-spacing="3" fill="${MUTED}" text-anchor="middle">PREDICTED EVENT</text>
  <text x="320" y="395" font-family="Georgia, serif" font-size="54" font-weight="bold" fill="${metal}" text-anchor="middle" letter-spacing="2">${escapeXml(eventLabel)}</text>

  ${goldRule(64, 440, 512, metal, theme)}

  ${statRow(64, 480, "WINDOW", windowLabel(predictedWindow))}
  ${statRow(64, 540, backingTeamName ? "BACKING" : "ODDS AT PREDICTION", backingTeamName ? backingTeamName.toUpperCase() : String(oddsAtPrediction ?? "—"))}

  ${goldRule(64, 600, 512, metal, theme)}

  ${statusBadge(320, 650, "UNRESOLVED", true, theme)}

  ${editionStamp(editionNumber, editionCap, theme)}
  ${footer("Anchored via TxLINE · Settled on Solana")}
</svg>`.trim();
}

function classicResolved({ match, momentType, playerName, team, actualMinute, outcome, editionNumber, editionCap, onChainVerified }, theme) {
  const hit = outcome === "hit";
  const metal = `url(#${THEME_GRADIENT_ID[theme]})`;
  const accentStroke = hit ? metal : MUTED;
  const resultFill = hit ? metal : MUTED;
  const eventLabel = (momentType || "").toUpperCase().replace(/_/g, " ");
  const resultLabel = hit ? eventLabel : "NO EVENT";

  return `
<svg width="640" height="900" viewBox="0 0 640 900" xmlns="http://www.w3.org/2000/svg">
  ${defs()}
  <rect width="640" height="900" fill="url(#cardBg)"/>
  ${cornerFrame(accentStroke)}
  ${soccerBall(320, 72, 22, accentStroke)}

  <text x="320" y="118" font-family="'Courier New', monospace" font-size="13" letter-spacing="6" fill="${MUTED}" text-anchor="middle">MOMENTMARKET</text>
  <text x="320" y="140" font-family="'Courier New', monospace" font-size="11" letter-spacing="4" fill="${hit ? THEME_LABEL_TINT[theme] : MUTED}" text-anchor="middle">RESOLVED MOMENT</text>

  ${goldRule(64, 170, 512, accentStroke, hit ? theme : null)}

  <text x="320" y="225" font-family="Georgia, 'Times New Roman', serif" font-size="26" font-weight="bold" fill="${WHITE}" text-anchor="middle">${escapeXml(match)}</text>

  <text x="320" y="315" font-family="'Courier New', monospace" font-size="12" letter-spacing="3" fill="${MUTED}" text-anchor="middle">RESULT</text>
  <text x="320" y="${resultLabel.length > 10 ? 380 : 400}" font-family="Georgia, serif" font-size="${resultLabel.length > 10 ? 42 : 56}" font-weight="bold" fill="${resultFill}" text-anchor="middle" letter-spacing="2">${escapeXml(resultLabel)}</text>

  ${goldRule(64, 440, 512, accentStroke, hit ? theme : null)}

  ${playerName ? statRow(64, 480, "PLAYER", playerName) : statRow(64, 480, "TEAM", team || "—")}
  ${statRow(64, 540, "MINUTE", actualMinute != null ? `${actualMinute}'` : "—")}

  ${goldRule(64, 600, 512, accentStroke, hit ? theme : null)}

  ${statusBadge(320, 650, hit ? `HIT · ${eventLabel}` : "MISS", hit, theme)}

  <text x="320" y="700" font-family="'Courier New', monospace" font-size="10" letter-spacing="1.5" fill="${MUTED}" text-anchor="middle">${onChainVerified ? "ON-CHAIN VERIFIED" : "FEED-CONFIRMED (NO ON-CHAIN STAT KEY)"}</text>

  ${editionStamp(editionNumber, editionCap, theme)}
  ${footer("Verified via TxLINE · Settled on Solana")}
</svg>`.trim();
}

// ============================================================
// Shared building blocks
// ============================================================

function defs() {
  return `
  <defs>
    <radialGradient id="cardBg" cx="50%" cy="8%" r="95%">
      <stop offset="0%" stop-color="${PANEL}"/>
      <stop offset="60%" stop-color="${INK}"/>
      <stop offset="100%" stop-color="#020509"/>
    </radialGradient>

    <linearGradient id="metallicGold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFF3C4"/>
      <stop offset="20%" stop-color="#D4AF37"/>
      <stop offset="45%" stop-color="#FFE9A8"/>
      <stop offset="60%" stop-color="#B8860B"/>
      <stop offset="80%" stop-color="#FFF3C4"/>
      <stop offset="100%" stop-color="#D4AF37"/>
    </linearGradient>

    <linearGradient id="metallicSilver" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="20%" stop-color="#9AA1A8"/>
      <stop offset="45%" stop-color="#EDEEEF"/>
      <stop offset="60%" stop-color="#6E747A"/>
      <stop offset="80%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#9AA1A8"/>
    </linearGradient>

    <linearGradient id="metallicDiamond" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="15%" stop-color="#3FD4E8"/>
      <stop offset="35%" stop-color="#F0FEFF"/>
      <stop offset="50%" stop-color="#E39EF0"/>
      <stop offset="65%" stop-color="#2FB8D9"/>
      <stop offset="85%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#3FD4E8"/>
    </linearGradient>

    <radialGradient id="sparkleGlowGold" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FFF9E5" stop-opacity="1"/>
      <stop offset="100%" stop-color="#FFF9E5" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="sparkleGlowSilver" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#F1F4F7" stop-opacity="1"/>
      <stop offset="100%" stop-color="#F1F4F7" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="sparkleGlowDiamond" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#A8F2FF" stop-opacity="1"/>
      <stop offset="100%" stop-color="#A8F2FF" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
}

function cornerFrame(stroke) {
  return `
  <rect x="24" y="24" width="592" height="852" fill="none" stroke="${stroke}" stroke-width="2" opacity="0.75"/>
  <rect x="32" y="32" width="576" height="836" fill="none" stroke="${stroke}" stroke-width="0.9" opacity="0.4"/>
  <path d="M24 60 L24 24 L60 24" fill="none" stroke="${stroke}" stroke-width="2.5"/>
  <path d="M580 24 L616 24 L616 60" fill="none" stroke="${stroke}" stroke-width="2.5"/>
  <path d="M616 840 L616 876 L580 876" fill="none" stroke="${stroke}" stroke-width="2.5"/>
  <path d="M60 876 L24 876 L24 840" fill="none" stroke="${stroke}" stroke-width="2.5"/>`;
}

function soccerBall(cx, cy, r, stroke) {
  return `
  <g transform="translate(${cx},${cy})" opacity="0.97">
    <circle r="${r}" fill="none" stroke="${stroke}" stroke-width="2"/>
    <polygon points="0,-10 9.5,-3 6,8 -6,8 -9.5,-3" fill="none" stroke="${stroke}" stroke-width="1.3"/>
    <path d="M0,-10 L0,-22 M9.5,-3 L20,-9 M6,8 L14,19 M-6,8 L-14,19 M-9.5,-3 L-20,-9" fill="none" stroke="${stroke}" stroke-width="1.1"/>
  </g>`;
}

/** theme=null means "no sparkle" (used for the miss/muted state). */
function goldRule(x, y, width, stroke, theme) {
  const sparkles = theme ? `${sparkle(x, y + 0.75, theme)}${sparkle(x + width, y + 0.75, theme)}` : "";
  return `<rect x="${x}" y="${y}" width="${width}" height="2" fill="${stroke}" opacity="0.85"/>${sparkles}`;
}

function sparkle(x, y, theme) {
  const fill = THEME_SPARKLE_FILL[theme] || THEME_SPARKLE_FILL.gold;
  const glowId = THEME_SPARKLE_ID[theme] || THEME_SPARKLE_ID.gold;
  const secondFlash = theme === "diamond"
    ? `<path d="M0,-5 L1,0 L5,0 L1,1 L0,5 L-1,1 L-5,0 L-1,0 Z" fill="${THEME_SPARKLE_FILL_2.diamond}" opacity="0.65" transform="rotate(45)"/>`
    : "";
  return `
  <g transform="translate(${x},${y})">
    <circle r="7" fill="url(#${glowId})"/>
    <path d="M0,-5 L1,0 L5,0 L1,1 L0,5 L-1,1 L-5,0 L-1,0 Z" fill="${fill}"/>
    ${secondFlash}
  </g>`;
}

function statRow(x, y, label, value) {
  return `
  <text x="${x}" y="${y - 22}" font-family="'Courier New', monospace" font-size="11" letter-spacing="2.5" fill="${MUTED}">${escapeXml(label)}</text>
  <text x="${x}" y="${y + 10}" font-family="Georgia, serif" font-size="22" fill="${WHITE}">${escapeXml(String(value))}</text>`;
}

function statusBadge(cx, y, text, positive, theme) {
  const width = 90 + text.length * 10;
  const x = cx - width / 2;
  const metal = `url(#${THEME_GRADIENT_ID[theme]})`;
  const color = positive ? metal : MUTED;
  const sparkles = positive ? `${sparkle(x - 4, y - 28, theme)}${sparkle(x + width + 4, y - 28, theme)}` : "";
  return `
  ${sparkles}
  <rect x="${x}" y="${y - 28}" width="${width}" height="46" rx="23" fill="none" stroke="${color}" stroke-width="2"/>
  <text x="${cx}" y="${y + 2}" font-family="'Courier New', monospace" font-size="13" letter-spacing="2" fill="${color}" text-anchor="middle">${escapeXml(text)}</text>`;
}

function editionStamp(editionNumber, editionCap, theme) {
  if (editionNumber == null || editionCap == null) return "";
  return `
  <text x="576" y="860" font-family="'Courier New', monospace" font-size="12" letter-spacing="1" fill="${THEME_LABEL_TINT[theme]}" text-anchor="end">No. ${editionNumber} / ${editionCap}</text>`;
}

function footer(text) {
  return `<text x="64" y="860" font-family="'Courier New', monospace" font-size="10" fill="${MUTED}">${escapeXml(text)}</text>`;
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  }[c]));
}
