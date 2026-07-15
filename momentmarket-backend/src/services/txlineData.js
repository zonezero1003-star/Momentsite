/**
 * Updated with a real correction: earlier I said TxLINE doesn't expose a
 * literal "goal" event — that was based on an incomplete read of the Soccer
 * Feed page. The full Soccer Feed PDF (txodds-soccer-feed-v1.1.pdf) confirms
 * there IS a literal `Action: "goal"` message, carrying `Data.PlayerId`.
 * detectGoal() below is rewritten to use that directly instead of the
 * stat-key-diffing workaround from before — this is more accurate, not just
 * different.
 *
 * ⚠️ ONE REMAINING ASSUMPTION: the PDF's JSON example wraps fields under a
 * top-level `Update` object (`{ FixtureInfo, Update: { Action, Data, ... } }`),
 * but the On-Chain Validation doc's own snippets access fields flattened
 * (`scoreRecord.FixtureId`, `scoreRecord.Seq`) with no `Update` wrapper shown.
 * Handled defensively below (checks both shapes) — worth confirming against
 * one real stream message before relying on this in production.
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

/** Live score events via SSE. Confirmed path. */
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
 * Which moment types have a dedicated on-chain stat-key (per the Soccer
 * Feed doc's Full Game Stats table) vs. which don't. This distinction
 * matters a lot: goal/corner/card moments can be proven via validateStat.
 * shot and var CANNOT — there's no stat key for shots or VAR reviews, so
 * those moments can only ever be "feed-confirmed" (TxODDS says it happened,
 * Confirmed: true), never cryptographically proven the same way.
 */
const STAT_KEY_MAP = {
  goal: { p1: 1, p2: 2, scoreField: "Goals" },
  yellow_card: { p1: 3, p2: 4, scoreField: "YellowCards" },
  red_card: { p1: 5, p2: 6, scoreField: "RedCards" },
  corner: { p1: 7, p2: 8, scoreField: "Corners" },
};

// shot and var have no stat key — listed here for clarity, not used for lookup.
const FEED_ONLY_TYPES = new Set(["shot", "var"]);

export const SUPPORTED_MOMENT_TYPES = [...Object.keys(STAT_KEY_MAP), ...FEED_ONLY_TYPES];

/**
 * Generalized moment detection across goal/corner/card (on-chain provable)
 * and shot/var (feed-confirmation only). Handles both the wrapped
 * (`{ Update: {...} }`) and flattened shapes defensively.
 */
export function detectMoment(scoreEvent) {
  const u = scoreEvent.Update ?? scoreEvent;
  const action = u.Action ?? u.action;
  if (!SUPPORTED_MOMENT_TYPES.includes(action)) return null;

  const fixtureId = u.FixtureId ?? u.fixtureId;
  const seq = u.Seq ?? u.seq;
  const participant = u.Participant ?? u.participant ?? u.Data?.Participant ?? null;
  const playerId = u.Data?.PlayerId ?? u.data?.PlayerId ?? null; // null for corner/var — not carried in the feed
  const clockSeconds = u.Clock?.Seconds ?? u.clock?.seconds ?? null;
  const statusId = u.StatusId ?? u.statusId;
  const confirmed = u.Confirmed ?? u.confirmed ?? null;

  if (!fixtureId || !seq) return null;

  const minute = clockSeconds != null ? clockFromSeconds(clockSeconds, statusId) : null;
  const config = STAT_KEY_MAP[action];

  if (!config) {
    // shot or var — feed-confirmation only, no on-chain stat to check
    return {
      fixtureId, seq, participant, playerId, minute,
      actionType: action,
      onChainVerifiable: false,
      feedConfirmed: confirmed === true,
      statKey: null,
      newValue: null,
      // extra context depending on type
      shotOutcome: action === "shot" ? (u.Data?.Outcome ?? null) : null,
      varType: action === "var" ? (u.Data?.Type ?? null) : null,
    };
  }

  if (!participant) return null;

  const scoreBlock = u.Score ?? u.score;
  const totalValue = participant === 1
    ? scoreBlock?.Participant1?.Total?.[config.scoreField]
    : scoreBlock?.Participant2?.Total?.[config.scoreField];

  return {
    fixtureId, seq, participant, playerId, minute,
    actionType: action,
    onChainVerifiable: true,
    feedConfirmed: confirmed === true,
    statKey: participant === 1 ? config.p1 : config.p2,
    scoreField: config.scoreField,
    newValue: totalValue ?? null, // may be null if Score wasn't attached — fetchCurrentStatTotal covers this
  };
}

// Clock.Seconds counts DOWN from the period length — convert to an
// approximate match minute for display/window-checking purposes.
function clockFromSeconds(secondsRemaining, statusId) {
  const periodLengthSeconds = statusId === 4 ? 2700 : 2700; // 45 min halves; refine per statusId if needed for ET
  const elapsed = periodLengthSeconds - secondsRemaining;
  const baseMinute = Math.floor(elapsed / 60);
  return statusId === 4 ? baseMinute + 45 : baseMinute; // add 45 if second half
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

/**
 * Fallback for when detectMoment() couldn't read a Score block off the
 * action directly — scans the fixture's score history for the most recent
 * message that included a Score object and returns that participant's
 * current total for the given field (Goals, Corners, YellowCards, RedCards).
 * Needed before calling runOnChainValidation, since its `expectedValue`
 * predicate needs a real number to check against.
 */
export async function fetchCurrentStatTotal(session, fixtureId, participant, scoreField) {
  const snapshot = await fetchScoresSnapshot(session, fixtureId);
  const history = Array.isArray(snapshot) ? snapshot : snapshot.data ?? [];

  for (let i = history.length - 1; i >= 0; i--) {
    const u = history[i].Update ?? history[i];
    const scoreBlock = u.Score ?? u.score;
    if (!scoreBlock) continue;
    const total = participant === 1
      ? scoreBlock.Participant1?.Total?.[scoreField]
      : scoreBlock.Participant2?.Total?.[scoreField];
    if (total != null) return total;
  }
  return null;
}

// --- Player name resolution (PlayerId -> preferredName) ---

const lineupCache = new Map(); // fixtureId -> Map<playerId, {name, team}>

/**
 * Builds a PlayerId -> name map for a fixture by finding the "lineups"
 * action in the fixture's score history. Cached per fixture since lineups
 * don't change mid-match (barring rare correction messages).
 *
 * NOTE: player-level data availability depends on the fixture's
 * `CoverageSecondaryData` flag (see Fixtures endpoint) — not guaranteed
 * for every match. Falls back gracefully to null if not found.
 */
export async function buildLineupMap(session, fixtureId) {
  if (lineupCache.has(fixtureId)) return lineupCache.get(fixtureId);

  const snapshot = await fetchScoresSnapshot(session, fixtureId);
  const history = Array.isArray(snapshot) ? snapshot : snapshot.data ?? [];
  const lineupsMsg = history.find((m) => (m.Update ?? m).Action === "lineups");

  const map = new Map();
  if (lineupsMsg) {
    const lineups = (lineupsMsg.Update ?? lineupsMsg).Lineups ?? [];
    for (const teamLineup of lineups) {
      for (const playerLineup of teamLineup.lineups ?? []) {
        map.set(playerLineup.fixturePlayerId, {
          name: playerLineup.player?.preferredName ?? null,
          teamId: teamLineup.id,
        });
      }
    }
  }

  lineupCache.set(fixtureId, map);
  return map;
}

export async function resolvePlayerName(session, fixtureId, playerId) {
  if (playerId == null) return null;
  const map = await buildLineupMap(session, fixtureId);
  return map.get(playerId)?.name ?? null;
}

// --- On-chain validation (validateStat), confirmed against the real docs ---

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

export async function fetchStatValidationData(session, { fixtureId, seq, statKey }) {
  const res = await client(session).get("/api/scores/stat-validation", {
    params: { fixtureId, seq, statKey },
  });
  return res.data;
}

/**
 * Runs the actual on-chain check via `validateStat` as a view/simulated call.
 * `expectedValue` should be the aggregate goal count for that participant —
 * if detectGoal() couldn't determine it (Score block wasn't attached to the
 * goal action), fetch a fresh snapshot to get the current total before
 * calling this, or the predicate has nothing correct to check against.
 */
export async function runOnChainValidation(session, program, { fixtureId, seq, statKey, expectedValue }) {
  if (expectedValue == null) {
    throw new Error("expectedValue is required — fetch the current goal total for this participant first");
  }

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

  const predicate = { threshold: expectedValue, comparison: { equalTo: {} } };

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
