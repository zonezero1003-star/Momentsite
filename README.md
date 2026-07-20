# MomentMarket

A fan-first Solana dApp built for the TxODDS World Cup Hackathon — submitted under **Prediction Markets and Settlement**. Users predict a live football moment (goal, card, corner, shot, or VAR review), mint the prediction as an NFT the instant they lock it in, and watch the same NFT update in place — new card art, new metadata — the moment TxLINE's live data confirms whether it actually happened. Where a stat is verifiable on-chain, resolution is backed by a real cryptographic proof, not just "the feed said so."

**Live:**
- Frontend: `https://momentmarket.vercel.app` — verify this matches your current Vercel dashboard, domains can drift
- Backend: `https://momentsite-production.up.railway.app` — verify against your current Railway deployment

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Vercel)                           │
│  Static HTML/JS — Phantom wallet connect, mint UI, marketplace UI   │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ fetch() — REST
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        BACKEND (Railway)                            │
│                     Node.js / Express server                        │
│                                                                       │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────┐               │
│  │/api/predictions │  │/api/marketplace│  │/api/     │  Resolver     │
│  │ preview, build,  │  │ list, listings, │  │fixtures  │  (bg worker) │
│  │ confirm,         │  │ build-buy-tx,   │  │          │              │
│  │ availability      │  │ buy, cancel     │  │          │              │
│  └────────┬─────────┘  └───────┬────────┘  └────┬─────┘               │
│           │                    │                 │                    │
│           ▼                    ▼                 ▼                    │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                       Service Layer                            │ │
│  │  txlineAuth.js   — on-chain subscribe + API token activation    │ │
│  │  txlineData.js   — Scores/Odds streams, fixture snapshot, goal  │ │
│  │                    detection, player name lookup, validateStat  │ │
│  │  cardImage.js    — deterministic PNG card art (rasterized via   │ │
│  │                    @resvg/resvg-js, embedded fonts), Gold/      │ │
│  │                    Silver/Diamond metallic themes — DEFAULT     │ │
│  │  geminiImage.js  — OPTIONAL photoreal image gen, off by default │ │
│  │                    (GEMINI_ENABLED=false); falls back to        │ │
│  │                    cardImage.js on any failure regardless       │ │
│  │  metaplex.js     — mint / update / transfer NFTs, builds        │ │
│  │                    user-pays-gas transactions for the frontend  │ │
│  │                    to sign, rather than backend-signed mints    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  Postgres (Neon) — db/store.js — predictions, listings, used         │
│  payment signatures. Survives redeploys, unlike the earlier          │
│  in-memory/SQLite versions.                                          │
└──────────┬───────────────────────┬──────────────────┬───────────────┘
           │                       │                  │
           ▼                       ▼                  ▼
  ┌─────────────────┐   ┌────────────────────┐  ┌──────────────┐
  │  TxLINE (TxODDS) │   │  Solana (mainnet)   │  │ Neon Postgres │
  │  Scores + Odds   │   │  Metaplex Core NFTs │  │              │
  │  streams, fixture│   │  validateStat        │  └──────────────┘
  │  + lineup data,   │   │  on-chain program   │
  │  Merkle proof     │   └────────────────────┘
  └─────────────────┘
```

---

## How a Moment Actually Works, End to End

1. **Connect** — user connects a Solana wallet (Phantom) via `window.solana`.
2. **Pick** — `GET /api/fixtures` for live/upcoming matches, `GET /api/fixtures/moment-types` for the six supported event types (goal, corner, yellow_card, red_card, shot, var).
3. **Check availability** — `GET /api/predictions/availability` returns how many of the capped edition (`EDITION_CAP`, default 10) for that exact (fixture, event type) pair are still open.
4. **Preview** — `POST /api/predictions/preview` generates the card art — the deterministic PNG template by default, or Gemini if `GEMINI_ENABLED=true` (falling back to the template automatically on any failure) — so the user sees the exact card before minting anything.
5. **Mint — user pays gas, not the backend.** `POST /api/predictions/build` uploads the previewed card + metadata and builds an unsigned mint transaction with the **user's wallet as fee payer**. The frontend has the user sign and submit it via Phantom. `POST /api/predictions/confirm` then verifies on-chain that the transaction actually landed and created the expected asset before persisting anything — never trusts the frontend's word alone. The backend wallet still holds **update authority**, which is what lets it resolve the NFT later even though it never paid to mint it.
6. **Detect** — a background resolver subscribes to TxLINE's live Scores stream and watches for the real event.
7. **Verify on-chain (where possible)** — for goal/corner/yellow_card/red_card, the backend calls TxLINE's `validateStat` Anchor program, checking a Merkle proof against the on-chain daily-scores root. Shot/VAR have no on-chain stat key and resolve on the feed's own confirmation instead — the NFT metadata records which trust tier applied.
8. **Resolve** — the same NFT's metadata updates in place: new card art reflecting the real outcome, `Status: Resolved: Hit` or `Resolved: Miss`.
9. **Reopen** — resolving frees that edition slot back up for the next occurrence of the same event type in the same match — the cap is "at most N people holding an open bet on the next goal," not a lifetime supply.
10. **Trade — buyer pays gas, not the backend.** `POST /api/marketplace/build-buy-tx` builds a plain SOL transfer with the buyer as fee payer (built server-side so the RPC endpoint, which may be a keyed provider, never has to be exposed to the browser). `POST /api/marketplace/buy` then verifies the payment actually landed — checking both that the seller's balance rose *and* the buyer's genuinely dropped, not just that money moved from somewhere — before transferring the NFT. An atomic claim on the listing plus a permanent record of used payment signatures close two real races: two buyers claiming the same listing at once, and the same valid payment being replayed against a second listing.

---

## Exclusivity model

Anyone can generate a similar-looking image. What makes a Moment NFT actually scarce:

- Each (fixture, predicted event type) pair has a capped edition of `EDITION_CAP` (default 10) concurrently open mints.
- The cap counts only **unresolved** predictions — deliberate, since a match can have multiple goals, so the cap represents "at most 10 people holding an open bet on the next goal," not a lifetime cap on goals ever.
- The instant a real event resolves, those slots reopen for the next occurrence of the same type in the same match.
- Be precise about this in any external messaging: it's exclusivity *per round*, not exclusivity *forever*.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | Static HTML/JS, Tailwind, Phantom wallet (`window.solana`) |
| Backend | Node.js, Express |
| Blockchain | Solana (**mainnet**) |
| NFTs | Metaplex Core |
| Storage | Arweave via Irys (Umi uploader) |
| Sports data | TxLINE (TxODDS) — fixtures, Scores, Odds, lineup/player data, on-chain validation |
| Card art | Deterministic PNG (SVG → `@resvg/resvg-js`, embedded IBM Plex fonts), Gold/Silver/Diamond metallic themes — Gemini available as an optional, off-by-default alternate path |
| Data store | Postgres (Neon) — `db/store.js` |

---

## Trust Model — What's Actually Proven vs. Feed-Level Trust

- **Proven on-chain, trustlessly:** the goal/card/corner *count* for a team reached a specific number at a specific time — via TxLINE's `validateStat` Merkle proof check, independently re-checkable by anyone.
- **NOT part of the on-chain proof:** *which player* did it — feed-level data, not covered by the Merkle proof.
- **No on-chain proof at all:** shot and VAR — no on-chain stat key exists for these, so they resolve on the feed's confirmation flag. Metadata records which tier applied.

---

## Known Gaps / Things To Verify

- **Backend wallet needs mainnet SOL** — it no longer pays to mint or buy (users do), but it still pays for card/metadata uploads to Irys and for resolving predictions later. Its address prints to Railway's logs at startup.
- **`src/idl/txoracle.json`** — confirm this is the real Anchor IDL, not a placeholder, or `validateStat` calls will fail.
- **CORS** — `CORS_ORIGIN` must exactly match the deployed frontend's real URL (no trailing slash). The `.env.example` default is a placeholder domain, not a real one — don't ship it as-is.
- **If `GEMINI_ENABLED=true`,** using real player names/likeness in mintable, tradeable art carries real right-of-publicity exposure — a decision to make deliberately, not by default.

---

## Setup

```bash
cd momentmarket-backend
npm install
cp .env.example .env
# fill in BACKEND_WALLET_SECRET_KEY, DATABASE_URL (Neon Postgres)
# confirm src/idl/txoracle.json is the real IDL, not a placeholder
npm start
```

Frontend is plain static HTML — no build step. `API_BASE` is hardcoded in `frontend/index.html` to the deployed Railway URL; update it there if the backend URL ever changes, then redeploy.

---

## Repo Structure

```
/frontend
  index.html          — landing + mint UI (preview → sign in Phantom → confirm) + marketplace UI
  hero.mp4             — background video
  vercel.json

/momentmarket-backend
  src/
    server.js           — entry point, wires everything together
    config.js           — network config, TxLINE program IDs, edition cap
    services/
      solana.js           — connection + backend wallet loader
      txlineAuth.js       — subscribe + activate
      txlineData.js       — fixtures, Scores/Odds streams, goal detection,
                            player name lookup, on-chain validateStat
      metaplex.js          — mint / update / transfer, builds user-pays-gas
                            transactions
      cardImage.js          — deterministic PNG card generator (default),
                            Gold/Silver/Diamond themes
      geminiImage.js          — optional photoreal path, off by default
      resolver.js               — background worker, ties it all together
    routes/
      predictions.js          — preview, build, confirm, availability
      marketplace.js            — list, listings, build-buy-tx, buy, cancel
      fixtures.js                 — live fixtures + supported moment types
    db/store.js                    — Postgres (Neon) data store
    idl/txoracle.json               — ⚠️ confirm this is the real IDL
  README.md
  .env.example
  package.json
```
