/**
 * In-memory store. Fine for a 5-day hackathon demo — resets on server
 * restart, no setup needed. Swap for Postgres/Railway's managed DB later
 * by replacing these functions; nothing else in the app touches storage
 * directly, it all goes through this file.
 */

const predictions = new Map(); // assetAddress -> prediction record
const listings = new Map();    // assetAddress -> listing record

export const PredictionsStore = {
  create(record) {
    predictions.set(record.assetAddress, record);
    return record;
  },
  get(assetAddress) {
    return predictions.get(assetAddress);
  },
  update(assetAddress, patch) {
    const existing = predictions.get(assetAddress);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    predictions.set(assetAddress, updated);
    return updated;
  },
  findOpenByFixtureAndType(fixtureId, predictedEvent) {
    return [...predictions.values()].filter(
      (p) => p.fixtureId === fixtureId && p.predictedEvent === predictedEvent && p.status === "unresolved"
    );
  },
  all() {
    return [...predictions.values()];
  },
};

export const ListingsStore = {
  create(record) {
    listings.set(record.assetAddress, record);
    return record;
  },
  get(assetAddress) {
    return listings.get(assetAddress);
  },
  remove(assetAddress) {
    listings.delete(assetAddress);
  },
  active() {
    return [...listings.values()].filter((l) => l.status === "active");
  },
};
