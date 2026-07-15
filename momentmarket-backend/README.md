# MomentMarket Backend

## What's real vs. placeholder

**Fully implemented, confirmed against TxLINE's docs:**
- On-chain subscribe + API token activation (`services/txlineAuth.js`)
- Metaplex Core mint / update / transfer (`services/metaplex.js`)
- Predictions API (`routes/predictions.js`)
- Marketplace list/buy/cancel with on-chain payment verification (`routes/marketplace.js`)
- Resolver that ties Scores → Validation Proof → NFT update (`services/resolver.js`)

**Still placeholder — needs your input:**
- `services/txlineData.js` — the Scores stream, Odds stream, and Validation
  Proof endpoints have unconfirmed paths and payload shapes. Everything else
  is wired to consume whatever these return, so once you paste the real API
  Reference pages (Scores, Odds, Validation Proofs), only this one file
  needs edits.
- `src/idl/txoracle.json` — placeholder. Needs the real Anchor IDL from
  TxLINE's devnet/mainnet examples repo, or `program.methods.subscribe()`
  will fail immediately.

## Setup

```bash
cd backend
npm install
cp .env.example .env
```

1. Generate a backend wallet: `solana-keygen new --outfile backend-wallet.json`
2. Airdrop devnet SOL to it: `solana airdrop 2 <pubkey> --url devnet`
3. Put its secret key into `.env` as `BACKEND_WALLET_SECRET_KEY` (paste the JSON array from the keyfile, or base64-encode it)
4. Drop the real TxLINE IDL into `src/idl/txoracle.json`
5. `npm start`

## Deploy to Railway

Matches your existing pattern (Railway backend / Vercel frontend, same as CycleMind):
- Push this `backend/` folder as its own repo or subfolder
- Set the env vars from `.env.example` in Railway's dashboard
- Railway auto-detects `npm start`

## Wire up the frontend

In `frontend/index.html`, set:
```js
const API_BASE = "https://YOUR-BACKEND.up.railway.app/api";
```

`connectWallet()` uses Phantom's injected `window.solana` directly — no
wallet-adapter library needed since this is plain HTML, not React.

## Trust model note (for judges)

Marketplace buy/sell is backend-mediated, not a fully trustless on-chain
escrow — the buyer pays the seller directly, the backend verifies that
payment landed, then transfers the NFT using its update authority. This
was a deliberate scope cut to ship in 5 days; a real Anchor escrow program
(list = lock in PDA, buy = atomic swap) is the natural next step post-hackathon.
