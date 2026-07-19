/**
 * Postgres-backed store (Neon). Replaces the old in-memory Maps, which
 * wiped every redeploy/restart. Nothing else in the app touches storage
 * directly — it all goes through this file, same exported shape as before.
 */
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL; this matches its default setup
});

/**
 * Creates tables if they don't exist yet. Call once at server startup,
 * before anything else touches the store.
 */
export async function initStore() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS predictions (
      asset_address       TEXT PRIMARY KEY,
      owner_public_key    TEXT NOT NULL,
      fixture_id          TEXT NOT NULL,
      match                TEXT,
      predicted_event      TEXT NOT NULL,
      predicted_window     TEXT,
      odds_at_prediction    TEXT,
      status               TEXT NOT NULL DEFAULT 'unresolved',
      mint_signature        TEXT,
      image_source          TEXT,
      resolved_at           BIGINT,
      created_at            BIGINT NOT NULL,
      data                 JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_predictions_fixture_type_status
      ON predictions (fixture_id, predicted_event, status);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS listings (
      asset_address  TEXT PRIMARY KEY,
      status         TEXT NOT NULL DEFAULT 'active',
      created_at     BIGINT NOT NULL,
      data           JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  // Reserves an edition slot the moment a mint transaction is built for
  // the user to sign (POST /api/predictions/build), released either when
  // /confirm succeeds (becomes a real PredictionsStore record) or expires
  // (user abandoned the Phantom signing popup). Without this, two people
  // building a transaction for the same fixture+event at nearly the same
  // time could both land "edition 3 of 10".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_mints (
      asset_address    TEXT PRIMARY KEY,
      fixture_id       TEXT NOT NULL,
      predicted_event  TEXT NOT NULL,
      edition_number   INTEGER NOT NULL,
      created_at       BIGINT NOT NULL,
      expires_at       BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pending_mints_fixture_event
      ON pending_mints (fixture_id, predicted_event);
  `);
  // Prevents a valid payment signature from being submitted more than
  // once to buy an NFT (replay protection) — without this, the same
  // confirmed payment tx could be reused to claim a second listing.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS used_signatures (
      signature      TEXT PRIMARY KEY,
      asset_address  TEXT NOT NULL,
      used_at        BIGINT NOT NULL
    );
  `);
  console.log("store initialized (Postgres/Neon)");
}

// Every "record" is stored as its known columns PLUS the full object in
// `data` (JSONB), so any field the app already reads/writes (e.g. from the
// video's plans: pending edition counts, etc.) keeps working without a
// migration every time a new field gets added — read it back merged.
function rowToPrediction(row) {
  if (!row) return null;
  return {
    ...row.data,
    assetAddress: row.asset_address,
    ownerPublicKey: row.owner_public_key,
    fixtureId: row.fixture_id,
    match: row.match,
    predictedEvent: row.predicted_event,
    predictedWindow: row.predicted_window,
    oddsAtPrediction: row.odds_at_prediction,
    status: row.status,
    mintSignature: row.mint_signature,
    imageSource: row.image_source,
    createdAt: Number(row.created_at),
  };
}

function rowToListing(row) {
  if (!row) return null;
  return {
    ...row.data,
    assetAddress: row.asset_address,
    status: row.status,
    createdAt: Number(row.created_at),
  };
}

export const PredictionsStore = {
  async create(record) {
    await pool.query(
      `INSERT INTO predictions
         (asset_address, owner_public_key, fixture_id, match, predicted_event,
          predicted_window, odds_at_prediction, status, mint_signature,
          image_source, created_at, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (asset_address) DO UPDATE SET
         status = EXCLUDED.status, data = EXCLUDED.data`,
      [
        record.assetAddress,
        record.ownerPublicKey,
        record.fixtureId,
        record.match ?? null,
        record.predictedEvent,
        record.predictedWindow ?? null,
        record.oddsAtPrediction != null ? String(record.oddsAtPrediction) : null,
        record.status ?? "unresolved",
        record.mintSignature ?? null,
        record.imageSource ?? null,
        record.createdAt ?? Date.now(),
        JSON.stringify(record),
      ]
    );
    return record;
  },

  async get(assetAddress) {
    const { rows } = await pool.query(`SELECT * FROM predictions WHERE asset_address = $1`, [assetAddress]);
    return rowToPrediction(rows[0]);
  },

  async update(assetAddress, patch) {
    const existing = await this.get(assetAddress);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    await pool.query(
      `UPDATE predictions SET
         status = $2, mint_signature = $3, image_source = $4, data = $5
       WHERE asset_address = $1`,
      [assetAddress, updated.status, updated.mintSignature ?? null, updated.imageSource ?? null, JSON.stringify(updated)]
    );
    return updated;
  },

  async findOpenByFixtureAndType(fixtureId, predictedEvent) {
    const { rows } = await pool.query(
      `SELECT * FROM predictions WHERE fixture_id = $1 AND predicted_event = $2 AND status = 'unresolved'`,
      [fixtureId, predictedEvent]
    );
    return rows.map(rowToPrediction);
  },

  async all() {
    const { rows } = await pool.query(`SELECT * FROM predictions ORDER BY created_at DESC`);
    return rows.map(rowToPrediction);
  },
};

export const ListingsStore = {
  async create(record) {
    await pool.query(
      `INSERT INTO listings (asset_address, status, created_at, data)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (asset_address) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data`,
      [record.assetAddress, record.status ?? "active", record.createdAt ?? Date.now(), JSON.stringify(record)]
    );
    return record;
  },

  async get(assetAddress) {
    const { rows } = await pool.query(`SELECT * FROM listings WHERE asset_address = $1`, [assetAddress]);
    return rowToListing(rows[0]);
  },

  async remove(assetAddress) {
    await pool.query(`DELETE FROM listings WHERE asset_address = $1`, [assetAddress]);
  },

  async active() {
    const { rows } = await pool.query(`SELECT * FROM listings WHERE status = 'active'`);
    return rows.map(rowToListing);
  },

  /**
   * Atomically flips a listing from 'active' to 'pending' — only succeeds
   * if it was still 'active' at that exact instant. Closes the race where
   * two buyers both pass an earlier "is this still active?" read-check
   * before either one finishes the purchase, which could otherwise sell
   * the same NFT twice.
   * Returns true if this call successfully claimed it.
   */
  async claim(assetAddress) {
    const { rowCount } = await pool.query(
      `UPDATE listings SET status = 'pending' WHERE asset_address = $1 AND status = 'active'`,
      [assetAddress]
    );
    return rowCount > 0;
  },

  /** Roll back a claim if payment verification or transfer fails afterward. */
  async releaseClaim(assetAddress) {
    await pool.query(`UPDATE listings SET status = 'active' WHERE asset_address = $1 AND status = 'pending'`, [assetAddress]);
  },
};

const MINT_RESERVATION_TTL_MS = 5 * 60 * 1000; // 5 minutes to sign in Phantom before the slot frees up

export const PendingMintsStore = {
  async reserve(assetAddress, fixtureId, predictedEvent, editionNumber) {
    const now = Date.now();
    await pool.query(
      `INSERT INTO pending_mints (asset_address, fixture_id, predicted_event, edition_number, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (asset_address) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [assetAddress, fixtureId, predictedEvent, editionNumber, now, now + MINT_RESERVATION_TTL_MS]
    );
  },

  async release(assetAddress) {
    await pool.query(`DELETE FROM pending_mints WHERE asset_address = $1`, [assetAddress]);
  },

  /** How many unexpired reservations currently exist for this (fixture, event) — counts toward the edition cap alongside confirmed mints. */
  async countActive(fixtureId, predictedEvent) {
    await pool.query(`DELETE FROM pending_mints WHERE expires_at < $1`, [Date.now()]); // sweep stale reservations opportunistically
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pending_mints WHERE fixture_id = $1 AND predicted_event = $2 AND expires_at >= $3`,
      [fixtureId, predictedEvent, Date.now()]
    );
    return rows[0].n;
  },
};

export const UsedSignaturesStore = {
  /** Returns true if this signature was newly claimed (wasn't already used anywhere) — false means it's a replay. */
  async claim(signature, assetAddress) {
    const { rowCount } = await pool.query(
      `INSERT INTO used_signatures (signature, asset_address, used_at) VALUES ($1,$2,$3) ON CONFLICT (signature) DO NOTHING`,
      [signature, assetAddress, Date.now()]
    );
    return rowCount > 0;
  },

  /** Roll back if the rest of the purchase fails after claiming the signature. */
  async release(signature) {
    await pool.query(`DELETE FROM used_signatures WHERE signature = $1`, [signature]);
  },
};
