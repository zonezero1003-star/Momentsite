# MomentMarket

A fan-first Solana dApp built for the TxODDS World Cup Hackathon (Trading Tools & Agents / Prediction Markets track). Users predict live World Cup moments (goals), mint the prediction as an NFT the instant they lock it in, and watch it resolve on-chain the moment TxLINE's live data confirms the event actually happened — with a real cryptographic proof behind the resolution, not just "the API said so."

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Vercel)                          │
│  Static HTML/JS — Phantom wallet connect, mint UI, marketplace UI  │
│  momentsite-sigma.vercel.app                                        │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ fetch() — REST
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        BACKEND (Railway)                           │
│                     Node.js / Express server                       │
│                                                                       │
│  ┌───────────────┐   ┌───────────────┐   ┌────────────────────┐    │
│  │ /api/predictions│  │/api/marketplace│  │   Resolver          │    │
│  │  preview, mint  │  │ list/buy/cancel│  │ (background worker) │    │
│  └───────┬───────┘   └───────┬───────┘   └─────────┬──────────┘    │
│          │                   │                       │              │
│          ▼                   ▼                       ▼              │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │                    Service Layer                            │    │
│  │  txlineAuth.js   — on-chain subscribe + API token activation │    │
│  │  txlineData.js   — Scores/Odds streams, goal detection,      │    │
│  │                    player name lookup, on-chain validation   │    │
│  │  geminiImage.js  — AI card art w/ real player names (default),│   │
│  │                    SVG fallback                              │    │
│  │  cardImage.js    — deterministic SVG card generator           │    │
│  │  metaplex.js     — mint / update / transfer NFTs             │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  In-memory store (db/store.js) — predictions + marketplace listings │
└──────────┬───────────────────────┬──────────────────┬───────────────┘
           │                       │                  │
           ▼                       ▼                  ▼
  ┌─────────────────┐   ┌────────────────────┐  ┌──────────────┐
  │  TxLINE (TxODDS) │   │  Solana (devnet)    │  │ Gemini API    │
  │  Scores + Odds   │   │  Metaplex Core NFTs │  │ (image gen,   │
  │  streams, lineup  │   │  validateStat       │  │ default path) │
  │  data, Merkle     │   │  on-chain program   │  └──────────────┘
  │  proof validation │   └────────────────────┘
  └─────────────────┘
```

**Deployment split follows the existing pattern**: frontend on Vercel, backend on Railway — same as the CycleMind/BitEdge projects.

---

## How a Moment Actually Works, End to End

1. **Predict** — user picks a live fixture and an event type ("goal, before minute 60") in the frontend, connects Phantom, and hits mint.
2. **Preview** — backend calls Gemini to generate a photorealistic trading-card image (falls back to a deterministic SVG card if Gemini fails, refuses, or is out of quota). User sees the card before anything is minted.
3. **Mint** — backend uploads the image + metadata (match, predicted event, odds at prediction time) to Arweave via Irys, then mints a Metaplex Core NFT straight to the user's wallet. The backend wallet pays gas and holds mint/update authority; the user never needs SOL or a signing step for this part.
4. **Detect** — a background resolver subscribes to TxLINE's live Scores stream and watches for the literal `Action: "goal"` message, which carries the scoring team, minute, and the scorer's `PlayerId`.
5. **Verify on-chain** — before resolving anything, the backend calls TxLINE's `validateStat` Anchor program as a read-only simulation, checking a Merkle proof against the on-chain daily-scores root for that fixture's goal count. Only if this returns `true` does resolution proceed — a goal appearing in the live feed alone is not enough.
6. **Identify the scorer** — the `PlayerId` from the goal event is looked up against the fixture's lineup data to get the real player name (e.g., "Kane, Harry"). This is feed-level data, not part of the on-chain proof — see the trust model note below.
7. **Resolve** — the NFT's metadata updates in place: new Gemini/SVG image showing the real player scoring, the on-chain validation timestamp/epoch stored so anyone can independently re-run the same check later, and a Hit/Miss outcome based on whether it landed in the predicted window.
8. **Trade** — resolved (or still-open) Moments can be listed and bought via a fixed-price marketplace. Payment is a direct SOL transfer from buyer to seller; the backend verifies the payment actually landed on-chain before transferring the NFT.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | Static HTML/JS, Tailwind, Phantom wallet (`window.solana`) |
| Backend | Node.js, Express |
| Blockchain | Solana (devnet), Anchor |
| NFTs | Metaplex Core |
| Storage | Arweave via Irys (Umi uploader) |
| Sports data | TxLINE (TxODDS) — Scores, Odds, lineup/player data, on-chain validation |
| Image generation | Gemini (`gemini-2.5-flash-image`), SVG fallback |
| Data store | In-memory (predictions + listings) — swap for Postgres post-hackathon |

---

## Trust Model — What's Actually Proven vs. What's Feed-Level Trust

This is the part worth being precise about, since "on-chain verified" can mean different things:

- **Proven on-chain, trustlessly:** the goal *count* for a team reached a specific number at a specific time. This comes from TxLINE's `validateStat` Merkle proof check against the on-chain daily-scores root — independently re-checkable by anyone, not just trusted because we say so.
- **NOT part of the on-chain proof:** *which player* scored. `PlayerId` → name resolution is TxODDS's own feed-level data (their scouts/data pipeline), not something the Merkle proof covers. The NFT metadata says this explicitly (`on_chain_validation.note`).
- **Also not guaranteed:** player-level data isn't available for every fixture — depends on the fixture's `CoverageSecondaryData` flag. When unavailable, both the metadata and the Gemini prompt fall back to a generic, non-identifying description automatically.

**Deliberate risk accepted:** using real player names/likeness in photorealistic, mintable, tradeable card art carries genuine right-of-publicity exposure — this was discussed explicitly and accepted as a choice, not an oversight. The generic-description fallback path still exists in the code for fixtures without player data, or if this decision gets revisited later.

---

## What's Confirmed vs. What to Verify Before Demo Day

**Fully implemented against confirmed TxLINE documentation:**
- On-chain subscribe + API token activation
- Scores/Odds live streams
- Real goal detection via the literal `Action: "goal"` message (not inferred from stat-diffing)
- Real on-chain `validateStat` Merkle proof validation
- Player name resolution via lineup data lookup
- Metaplex Core mint / update / transfer
- Marketplace list/buy/cancel with on-chain payment verification
- Gemini-first image generation (real player names when available) with automatic SVG fallback

**Needs your action before it runs:**
- `src/idl/txoracle.json` — placeholder, needs the real Anchor IDL from TxLINE's devnet examples repo (`txodds/tx-on-chain`)
- `BACKEND_WALLET_SECRET_KEY` — generate and fund with devnet SOL
- `GEMINI_API_KEY` — check your own Google AI Studio quota page for current free-tier limits; this has been genuinely unclear/contested in available sources
- Frontend `API_BASE` — point at your deployed Railway URL

**One structural assumption to confirm against a real stream message:** the Soccer Feed docs show goal event fields wrapped under an `Update` object in one example, but flattened directly in another doc's snippets. `detectGoal()` checks both shapes defensively, but hasn't been confirmed against one real live message yet.

**Deliberate scope cuts, worth being upfront about if judges ask:**
- Marketplace trust model is backend-mediated (buyer pays seller directly, backend verifies then transfers), not a fully trustless on-chain escrow program — a natural post-hackathon upgrade
- Goal resolution validates against live in-progress score records, not `game_finalised` records — per TxLINE's own docs, this proves "true at that observed moment," which is the right semantics for a live moment-prediction product, but distinct from final-match-outcome settlement

---

## Setup

```bash
# Backend
cd backend
npm install
cp .env.example .env
# fill in BACKEND_WALLET_SECRET_KEY, GEMINI_API_KEY
# replace src/idl/txoracle.json with the real IDL
npm start
```

```bash
# Frontend
# edit API_BASE in index.html to point at your deployed backend
# deploy as static site to Vercel
```

Full endpoint list and deploy notes are in `backend/README.md`.

---

## Repo Structure

```
/frontend
  index.html          — landing + mint UI + marketplace UI
  hero.mp4            — background video
  vercel.json

/backend
  src/
    server.js          — entry point, wires everything together
    config.js          — network config, TxLINE program IDs
    services/
      solana.js         — connection + backend wallet loader
      txlineAuth.js     — subscribe + activate (confirmed)
      txlineData.js     — Scores/Odds streams, goal detection, player
                          name lookup, on-chain validateStat (confirmed)
      metaplex.js        — mint / update / transfer / uploads
      geminiImage.js     — Gemini-first image gen w/ real player names,
                          SVG fallback
      cardImage.js        — deterministic SVG card generator
      resolver.js          — background worker, ties it all together
    routes/
      predictions.js       — preview + mint
      marketplace.js         — list/buy/cancel
    db/store.js               — in-memory data store
    idl/txoracle.json           — ⚠️ placeholder, needs the real IDL
  README.md
  .env.example
  package.json
```
