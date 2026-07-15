/**
 * Confirmed against TxLINE's actual docs (Streaming Data, Fetching Snapshots,
 * On-Chain Validation, Soccer Feed pages).
 */
import EventSource from "eventsource";
import axios from "axios";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { config } from "../config.js";

function client(session) {
  return axios.create({
    baseURL: config.txline.apiOrigin,
    timeout: 30000,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.jwt}`,
      "X-Api-Token": session.apiToken,
    },
  });
}

/** Live score events (goals, cards, VAR, etc.) via SSE. Confirmed path. */
export function subscribeScoreEvents(session, onEvent, onError) {
  const es = new EventSource(`${config.txline.apiOrigin}/api/scores/stream`, {
    headers: { Authorization: `Bearer ${session.jwt}`, "X-Api-Token": session.apiToken },
  });
  es.onmessage = (msg) => {
    try { onEvent(JSON.parse(msg.data)); } catch (err) { onError?.(err); }
  };
  es.onerror = (err) => onError?.(err);
  return () => es.close();
}

/** Live odds updates via SSE. Confirmed path. */
export function subscribeOddsEvents(session, onUpdate, onError) {
  const es = new EventSource(`${config.txline.apiOrigin}/api/odds/stream`, {
    headers: { Authorization: `Bearer ${session.jwt}`, "X-Api-Token": session.apiToken },
  });
  es.onmessage = (msg) => {
    try { onUpdate(JSON.parse(msg.data)); } catch (err) { onError?.(err); }
  };
  es.onerror = (err) => onError?.(err);
  return () => es.close();
}

/**
 * Goal detection via stat-key comparison (key 1 = participant1 total goals,
 * key 2 = participant2 total goals; period-prefixed variants exist too —
 * see the Soccer Feed doc). Also carries the exact statKey used, so the
 * resolver can request on-chain validation for that specific key.
 */
const lastKnownGoals = new Map(); // fixtureId -> { p1: number, p2: number }

export function detectGoal(scoreEvent) {
  const fixtureId = scoreEvent.FixtureId ?? scoreEvent.fixtureId;
  const stats = scoreEvent.Stats ?? scoreEvent.stats;
  const seq = scoreEvent.Seq ?? scoreEvent.seq;
  if (!fixtureId || !stats || !seq) return null;

  const p1Goals = stats["1"] ?? stats[1] ?? 0;
  const p2Goals = stats["2"] ?? stats[2] ?? 0;
  const prev = lastKnownGoals.get(fixtureId) ?? { p1: 0, p2: 0 };

  let scorer = null;
  let statKey = null;
  let newValue = null;
  if (p1Goals > prev.p1) { scorer = "participant1"; statKey = 1; newValue = p1Goals; }
  else if (p2Goals > prev.p2) { scorer = "participant2"; statKey = 2; newValue = p2Goals; }

  lastKnownGoals.set(fixtureId, { p1: p1Goals, p2: p2Goals });

  if (!scorer) return null;
  return {
    fixtureId,
    scorer,
    seq,
    statKey,
    newValue,
    minute: scoreEvent.Minute ?? scoreEvent.minute ?? null,
  };
}

export async function fetchScoresSnapshot(session, fixtureId) {
  const res = await client(session).get(`/api/scores/snapshot/${fixtureId}`, {
    params: { asOf: Date.now() },
  });
  return res.data;
}

export async function fetchFixture(session, fixtureId) {
  const res = await client(session).get("/api/fixtures/snapshot");
  const fixtures = res.data;
  return fixtures.find((f) => (f.FixtureId ?? f.fixtureId) === fixtureId) ?? null;
}

/** Raw validation proof data (Merkle proofs) for a specific stat. */
export async function fetchStatValidationData(session, { fixtureId, seq, statKey }) {
  const res = await client(session).get("/api/scores/stat-validation", {
    params: { fixtureId, seq, statKey },
  });
  return res.data;
}

// --- Byte conversion helpers, straight from the docs ---

function toBytes32(value) {
  const bytes = Array.isArray(value)
    ? Uint8Array.from(value)
    : value instanceof Uint8Array
      ? value
      : value.startsWith("0x")
        ? Buffer.from(value.slice(2), "hex")
        : Buffer.from(value, "base64");

  if (bytes.length !== 32) {
    throw new Error(`Expected 32 bytes, received ${bytes.length}`);
  }
  return Array.from(bytes);
}

function toProofNodes(nodes) {
  return nodes.map((node) => ({
    hash: toBytes32(node.hash),
    isRightSibling: node.isRightSibling,
  }));
}

/**
 * Runs the actual on-chain check via `validateStat` as a view/simulated
 * call. Returns a real boolean — this is the trustless guarantee, not
 * just "the API returned some proof data."
 *
 * `expectedValue`: the goal-count value we expect this stat to equal
 * (from detectGoal's `newValue`) — validated with an exact-equality
 * predicate, which is the natural check for "did the goal count reach X."
 */
export async function runOnChainValidation(session, program, { fixtureId, seq, statKey, expectedValue }) {
  const validation = await fetchStatValidationData(session, { fixtureId, seq, statKey });

  const fixtureSummary = {
    fixtureId: new BN(validation.summary.fixtureId),
    updateStats: {
      updateCount: validation.summary.updateStats.updateCount,
      minTimestamp: new BN(validation.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(validation.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: toBytes32(validation.summary.eventStatsSubTreeRoot),
  };

  const fixtureProof = toProofNodes(validation.subTreeProof);
  const mainTreeProof = toProofNodes(validation.mainTreeProof);

  const stat1 = {
    statToProve: validation.statToProve,
    eventStatRoot: toBytes32(validation.eventStatRoot),
    statProof: toProofNodes(validation.statProof),
  };

  // Exact equality against the goal count we observed in the live feed.
  const predicate = {
    threshold: expectedValue,
    comparison: { equalTo: {} },
  };

  const targetTs = validation.summary.updateStats.minTimestamp;
  const epochDay = Math.floor(targetTs / (24 * 60 * 60 * 1000));

  const [dailyScoresPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
    program.programId
  );

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  try {
    const isValid = await program.methods
      .validateStat(new BN(targetTs), fixtureSummary, fixtureProof, mainTreeProof, predicate, stat1, null, null)
      .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
      .preInstructions([computeBudgetIx])
      .view();

    return { isValid, validationData: validation, targetTs, epochDay };
  } catch (err) {
    console.error("On-chain validation simulation failed:", err.message);
    return { isValid: false, error: err.message, validationData: validation };
  }
}
