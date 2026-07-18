/**
 * Generates the entire visual face of a Moment NFT as hand-designed SVG —
 * no AI image generation, no player photos/likeness, no external API
 * calls or failure modes. Every value on the card comes directly from
 * TxLINE's data (or the prediction record derived from it). This is the
 * ONLY image source for Moment NFTs — there is no fallback path because
 * there is nothing to fall back from.
 *
 * Design language: dark foil card stock, thin gold rule lines, a
 * monogram crest, serif display type for the headline stat, monospace
 * for data labels — closer to a numbered trading card / stock certificate
 * than a poster. Renders identically every time, in every wallet/
 * marketplace that supports SVG `image` fields (Phantom, Magic Eden).
 */

const INK = "#050B14";
const PANEL = "#0B1830";
const GOLD = "#D4AF37";
const GOLD_SOFT = "#8C7A3E";
const WHITE = "#F4F1E8";
const MUTED = "#6C7C93";
const RED = "#8A2B2B";

export function buildUnresolvedCardSvg({ match, predictedEvent, predictedWindow, oddsAtPrediction, editionNumber, editionCap }) {
  const eventLabel = (predictedEvent || "").toUpperCase().replace(/_/g, " ");
  return `
<svg width="640" height="900" viewBox="0 0 640 900" xmlns="http://www.w3.org/2000/svg">
  ${defs()}
  <rect width="640" height="900" fill="url(#cardBg)"/>
  ${frame()}
  ${crest()}

  <text x="320" y="118" font-family="'Courier New', monospace" font-size="13" letter-spacing="6" fill="${MUTED}" text-anchor="middle">MOMENTMARKET</text>
  <text x="320" y="140" font-family="'Courier New', monospace" font-size="11" letter-spacing="4" fill="${GOLD_SOFT}" text-anchor="middle">UNRESOLVED PREDICTION</text>

  ${goldRule(170)}

  <text x="320" y="230" font-family="Georgia, 'Times New Roman', serif" font-size="30" font-weight="bold" fill="${WHITE}" text-anchor="middle">${escapeXml(match)}</text>

  <text x="320" y="330" font-family="'Courier New', monospace" font-size="12" letter-spacing="3" fill="${MUTED}" text-anchor="middle">PREDICTED EVENT</text>
  <text x="320" y="395" font-family="Georgia, serif" font-size="54" font-weight="bold" fill="url(#metallicGold)" text-anchor="middle" letter-spacing="2">${escapeXml(eventLabel)}</text>

  ${goldRule(440)}

  ${statRow(480, "WINDOW", predictedWindow || "Full match")}
  ${statRow(540, "ODDS AT PREDICTION", String(oddsAtPrediction ?? "—"))}

  ${goldRule(600)}

  ${statusBadge(650, "UNRESOLVED", false)}

  ${editionStamp(editionNumber, editionCap)}
  ${footer("Anchored via TxLINE · Settled on Solana")}
</svg>`.trim();
}

export function buildResolvedCardSvg({ match, momentType, playerName, team, actualMinute, outcome, editionNumber, editionCap, onChainVerified }) {
  const hit = outcome === "hit";
  const accent = hit ? GOLD : MUTED;
  const resultFill = hit ? "url(#metallicGold)" : MUTED;
  const eventLabel = (momentType || "").toUpperCase().replace(/_/g, " ");
  const resultLabel = hit ? eventLabel : "NO EVENT";

  return `
<svg width="640" height="900" viewBox="0 0 640 900" xmlns="http://www.w3.org/2000/svg">
  ${defs()}
  <rect width="640" height="900" fill="url(#cardBg)"/>
  ${frame(accent)}
  ${crest(accent)}

  <text x="320" y="118" font-family="'Courier New', monospace" font-size="13" letter-spacing="6" fill="${MUTED}" text-anchor="middle">MOMENTMARKET</text>
  <text x="320" y="140" font-family="'Courier New', monospace" font-size="11" letter-spacing="4" fill="${accent}" text-anchor="middle">RESOLVED MOMENT</text>

  ${goldRule(170, accent)}

  <text x="320" y="225" font-family="Georgia, 'Times New Roman', serif" font-size="26" font-weight="bold" fill="${WHITE}" text-anchor="middle">${escapeXml(match)}</text>

  <text x="320" y="315" font-family="'Courier New', monospace" font-size="12" letter-spacing="3" fill="${MUTED}" text-anchor="middle">RESULT</text>
  <text x="320" y="${resultLabel.length > 10 ? 380 : 400}" font-family="Georgia, serif" font-size="${resultLabel.length > 10 ? 42 : 56}" font-weight="bold" fill="${resultFill}" text-anchor="middle" letter-spacing="2">${escapeXml(resultLabel)}</text>

  ${goldRule(440, accent)}

  ${playerName ? statRow(480, "PLAYER", playerName) : statRow(480, "TEAM", team || "—")}
  ${statRow(540, "MINUTE", actualMinute != null ? `${actualMinute}'` : "—")}

  ${goldRule(600, accent)}

  ${statusBadge(650, hit ? `HIT · ${eventLabel}` : "MISS", hit)}

  <text x="320" y="700" font-family="'Courier New', monospace" font-size="10" letter-spacing="1.5" fill="${MUTED}" text-anchor="middle">${onChainVerified ? "ON-CHAIN VERIFIED" : "FEED-CONFIRMED (NO ON-CHAIN STAT KEY)"}</text>

  ${editionStamp(editionNumber, editionCap)}
  ${footer("Verified via TxLINE · Settled on Solana")}
</svg>`.trim();
}

// ---- shared building blocks ----

function defs() {
  return `
  <defs>
    <radialGradient id="cardBg" cx="50%" cy="8%" r="95%">
      <stop offset="0%" stop-color="${PANEL}"/>
      <stop offset="60%" stop-color="${INK}"/>
      <stop offset="100%" stop-color="#020509"/>
    </radialGradient>
    <linearGradient id="foilLine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${GOLD}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${GOLD}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="metallicGold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFF3C4"/>
      <stop offset="20%" stop-color="#D4AF37"/>
      <stop offset="45%" stop-color="#FFE9A8"/>
      <stop offset="60%" stop-color="#B8860B"/>
      <stop offset="80%" stop-color="#FFF3C4"/>
      <stop offset="100%" stop-color="#D4AF37"/>
    </linearGradient>
    <radialGradient id="sparkleGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FFF9E5" stop-opacity="1"/>
      <stop offset="100%" stop-color="#FFF9E5" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
}

function frame(accent = GOLD) {
  const stroke = accent === GOLD ? "url(#metallicGold)" : accent;
  return `
  <rect x="24" y="24" width="592" height="852" fill="none" stroke="${stroke}" stroke-width="2" opacity="0.75"/>
  <rect x="32" y="32" width="576" height="836" fill="none" stroke="${stroke}" stroke-width="0.9" opacity="0.4"/>
  <path d="M24 60 L24 24 L60 24" fill="none" stroke="${stroke}" stroke-width="2.5"/>
  <path d="M580 24 L616 24 L616 60" fill="none" stroke="${stroke}" stroke-width="2.5"/>
  <path d="M616 840 L616 876 L580 876" fill="none" stroke="${stroke}" stroke-width="2.5"/>
  <path d="M60 876 L24 876 L24 840" fill="none" stroke="${stroke}" stroke-width="2.5"/>`;
}

function crest(accent = GOLD) {
  // An actual soccer ball (pentagon/hexagon panel pattern), matching
  // MomentMarket's ⚽ branding — not a shield/crest.
  const stroke = accent === GOLD ? "url(#metallicGold)" : accent;
  return `
  <g transform="translate(320,72)" opacity="0.97">
    <circle r="22" fill="none" stroke="${stroke}" stroke-width="2"/>
    <polygon points="0,-10 9.5,-3 6,8 -6,8 -9.5,-3" fill="none" stroke="${stroke}" stroke-width="1.3"/>
    <path d="M0,-10 L0,-22 M9.5,-3 L20,-9 M6,8 L14,19 M-6,8 L-14,19 M-9.5,-3 L-20,-9" fill="none" stroke="${stroke}" stroke-width="1.1"/>
  </g>`;
}

function goldRule(y, accent = GOLD) {
  const fill = accent === GOLD ? "url(#metallicGold)" : accent;
  const sparkles = accent === GOLD ? `${sparkle(64, y + 0.75)}${sparkle(576, y + 0.75)}` : "";
  return `<rect x="64" y="${y}" width="512" height="2" fill="${fill}" opacity="0.85"/>${sparkles}`;
}

function sparkle(x, y) {
  return `
  <g transform="translate(${x},${y})">
    <circle r="7" fill="url(#sparkleGlow)"/>
    <path d="M0,-5 L1,0 L5,0 L1,1 L0,5 L-1,1 L-5,0 L-1,0 Z" fill="#FFF9E5"/>
  </g>`;
}

function statRow(y, label, value) {
  return `
  <text x="64" y="${y - 22}" font-family="'Courier New', monospace" font-size="11" letter-spacing="2.5" fill="${MUTED}">${escapeXml(label)}</text>
  <text x="64" y="${y + 10}" font-family="Georgia, serif" font-size="22" fill="${WHITE}">${escapeXml(String(value))}</text>`;
}

function statusBadge(y, text, positive) {
  const width = 90 + text.length * 10;
  const x = 320 - width / 2;
  const color = positive ? "url(#metallicGold)" : MUTED;
  const sparkles = positive ? `${sparkle(x - 4, y - 28)}${sparkle(x + width + 4, y - 28)}` : "";
  return `
  ${sparkles}
  <rect x="${x}" y="${y - 28}" width="${width}" height="46" rx="23" fill="none" stroke="${color}" stroke-width="2"/>
  <text x="320" y="${y + 2}" font-family="'Courier New', monospace" font-size="13" letter-spacing="2" fill="${positive ? GOLD : color}" text-anchor="middle">${escapeXml(text)}</text>`;
}

function editionStamp(editionNumber, editionCap) {
  if (editionNumber == null || editionCap == null) return "";
  return `
  <text x="576" y="860" font-family="'Courier New', monospace" font-size="12" letter-spacing="1" fill="${GOLD_SOFT}" text-anchor="end">No. ${editionNumber} / ${editionCap}</text>`;
}

function footer(text) {
  return `<text x="64" y="860" font-family="'Courier New', monospace" font-size="10" fill="${MUTED}">${escapeXml(text)}</text>`;
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  }[c]));
}
