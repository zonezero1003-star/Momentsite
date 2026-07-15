/**
 * Generates the visual "face" of a Moment NFT as an SVG — no native
 * image libs (canvas/sharp) needed, which keeps the Railway deploy simple.
 * Most wallets/marketplaces (Phantom, Magic Eden) render SVG `image` fields
 * fine. Uploaded to Irys alongside the JSON metadata, same as the metadata itself.
 */

const FIFA_BLUE = "#005391";
const NAVY = "#012A4A";
const GOLD = "#FFB81C";
const WHITE = "#F5F7FA";

export function buildUnresolvedCardSvg({ match, predictedEvent, predictedWindow, oddsAtPrediction }) {
  return `
<svg width="600" height="800" viewBox="0 0 600 800" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="50%" cy="10%" r="90%">
      <stop offset="0%" stop-color="#023A63"/>
      <stop offset="55%" stop-color="${NAVY}"/>
      <stop offset="100%" stop-color="#001830"/>
    </radialGradient>
  </defs>
  <rect width="600" height="800" fill="url(#bg)"/>

  <!-- net texture -->
  <g opacity="0.12" stroke="${WHITE}" stroke-width="1">
    ${netLines()}
  </g>

  <text x="40" y="70" font-family="monospace" font-size="16" letter-spacing="3" fill="#8FB4D0">MOMENTMARKET · PREDICTION</text>

  <rect x="40" y="100" width="520" height="2" fill="${FIFA_BLUE}"/>

  <text x="40" y="180" font-family="Georgia, serif" font-size="34" font-weight="bold" fill="${WHITE}">${escapeXml(match)}</text>

  <text x="40" y="240" font-family="monospace" font-size="14" letter-spacing="2" fill="#8FB4D0">PREDICTED EVENT</text>
  <text x="40" y="285" font-family="Arial, sans-serif" font-size="42" font-weight="bold" fill="${GOLD}">${escapeXml(predictedEvent.toUpperCase())}</text>

  <text x="40" y="340" font-family="monospace" font-size="14" letter-spacing="2" fill="#8FB4D0">WINDOW</text>
  <text x="40" y="375" font-family="Arial, sans-serif" font-size="24" fill="${WHITE}">${escapeXml(predictedWindow || "Full match")}</text>

  <text x="40" y="430" font-family="monospace" font-size="14" letter-spacing="2" fill="#8FB4D0">ODDS AT PREDICTION</text>
  <text x="40" y="465" font-family="Arial, sans-serif" font-size="24" fill="${WHITE}">${escapeXml(String(oddsAtPrediction ?? "—"))}</text>

  <rect x="40" y="700" width="200" height="44" rx="22" fill="none" stroke="${GOLD}" stroke-width="2"/>
  <text x="140" y="728" font-family="monospace" font-size="14" letter-spacing="1.5" fill="${GOLD}" text-anchor="middle">UNRESOLVED</text>

  <text x="40" y="770" font-family="monospace" font-size="11" fill="#5C7C93">Anchored via TxLINE · Solana</text>
</svg>`.trim();
}

export function buildResolvedCardSvg({ match, actualMinute, outcome, momentType = "goal" }) {
  const hit = outcome === "hit";
  const accent = hit ? GOLD : "#6B7A88";

  const labelByType = {
    goal: hit ? "GOAL" : "MISS", corner: hit ? "CORNER" : "MISS",
    yellow_card: hit ? "YELLOW" : "MISS", red_card: hit ? "RED CARD" : "MISS",
    shot: hit ? "SHOT" : "MISS", var: hit ? "VAR" : "MISS",
  };
  const centerLabel = labelByType[momentType] ?? (hit ? "HIT" : "MISS");
  const badgeLabel = hit ? `RESOLVED · ${momentType.toUpperCase().replace("_", " ")}` : "RESOLVED · MISS";

  return `
<svg width="600" height="800" viewBox="0 0 600 800" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg2" cx="50%" cy="10%" r="90%">
      <stop offset="0%" stop-color="${hit ? "#04529A" : "#0A2338"}"/>
      <stop offset="55%" stop-color="${NAVY}"/>
      <stop offset="100%" stop-color="#001830"/>
    </radialGradient>
  </defs>
  <rect width="600" height="800" fill="url(#bg2)"/>

  <g opacity="0.12" stroke="${WHITE}" stroke-width="1">
    ${netLines()}
  </g>

  ${hit ? goldSparkles() : ""}

  <text x="40" y="70" font-family="monospace" font-size="16" letter-spacing="3" fill="#8FB4D0">MOMENTMARKET · MOMENT</text>
  <rect x="40" y="100" width="520" height="2" fill="${accent}"/>

  <text x="40" y="200" font-family="Georgia, serif" font-size="34" font-weight="bold" fill="${WHITE}">${escapeXml(match)}</text>

  <text x="300" y="420" font-family="'Arial Black', sans-serif" font-size="${centerLabel.length > 6 ? 60 : 90}" font-weight="900" fill="${accent}" text-anchor="middle" letter-spacing="4">${escapeXml(centerLabel)}</text>

  <text x="40" y="500" font-family="monospace" font-size="14" letter-spacing="2" fill="#8FB4D0">CONFIRMED MINUTE</text>
  <text x="40" y="535" font-family="Arial, sans-serif" font-size="24" fill="${WHITE}">${escapeXml(String(actualMinute ?? "—"))}'</text>

  <rect x="40" y="700" width="260" height="44" rx="22" fill="${accent}"/>
  <text x="170" y="728" font-family="monospace" font-size="13" letter-spacing="1.2" fill="${NAVY}" text-anchor="middle" font-weight="bold">${escapeXml(badgeLabel)}</text>

  <text x="40" y="770" font-family="monospace" font-size="11" fill="#5C7C93">Verified via TxLINE validation proof · Solana</text>
</svg>`.trim();
}

function netLines() {
  let lines = "";
  for (let i = -400; i < 700; i += 30) {
    lines += `<line x1="${i}" y1="0" x2="${i + 400}" y2="800"/>`;
    lines += `<line x1="${i + 400}" y1="0" x2="${i}" y2="800"/>`;
  }
  return lines;
}

function goldSparkles() {
  const pts = [[500, 150], [540, 220], [470, 260], [520, 320]];
  return pts.map(([x, y]) =>
    `<circle cx="${x}" cy="${y}" r="4" fill="${GOLD}" opacity="0.8"/>`
  ).join("");
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  }[c]));
}
