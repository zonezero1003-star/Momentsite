/**
 * TxLINE data layer for MomentMarket.
 *
 * - Supports literal Action: "goal", "corner", "yellow_card", "red_card", "shot", "var"
 * - goal/corner/cards → on-chain verifiable via validateStat
 * - shot/var → feed-confirmed only
 * - Handles both { Update: {...} } and flat message shapes
 */
import EventSource from "eventsource";
import axios from "axios";
import anchorPkg from "@coral-xyz/anchor";
const { BN } = anchorPkg;
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

/** Live score events via SSE */
export function subscribeScoreEvents(session, onEvent, onError) {
  const es = new EventSource(`${config.txline.apiOrigin}/api/scores/stream`, {
    headers: { Authorization: `Bearer ${session.jwt}`, "X-Api-Token": session.apiToken },
  });

  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data));
    } catch (err) {
      console.error("Failed to parse score event:", err.message);
      onError?.(err);
    }
  };

  es.onerror = (err) => {
    console.error("Scores stream error:", err.message || err);
    onError?.(err);
  };

  return () => es.close();
}

/** Live odds updates via SSE */
export function subscribeOddsEvents(session, onUpdate, onError) {
  const es = new EventSource(`${config.txline.apiOrigin}/api/odds/stream`, {
    headers: { Authorization: `Bearer ${session.jwt}`, "X-Api-Token": session.apiToken },
  });

  es.onmessage = (msg) => {
    try {
      onUpdate(JSON.parse(msg.data));
    } catch (err) {
      console.error("Failed to parse odds event:", err.message);
      onError?.(err);
    }
  };

  es.onerror = (err) => {
    console.error("Odds stream error:", err.message || err);
    onError?.(err);
  };

  return () => es.close();
}

const STAT_KEY_MAP = {
  goal:        { p1: 1, p2: 2, scoreField: "Goals" },
  yellow_card: { p1: 3, p2: 4, scoreField: "YellowCards" },
  red_card:    { p1: 5, p2: 6, scoreField: "RedCards" },
  corner:      { p1: 7, p2: 8, scoreField: "Corners" },
};

const FEED_ONLY_TYPES = new Set(["shot", "var"]);
export const SUPPORTED_MOMENT_TYPES = [...Object.keys(STAT_KEY_MAP), ...FEED_ONLY_TYPES];

export function detectMoment(scoreEvent) {
  const u = scoreEvent.Update ?? scoreEvent;
  const action = u.Action ?? u.action;

  if (!SUPPORTED_MOMENT_TYPES.includes(action)) return null;

  const fixtureId   = u.FixtureId ?? u.fixtureId;
  const seq         = u.Seq ?? u.seq;
  const participant = u.Participant ?? u.participant ?? u.Data?.Participant ?? null;
  const playerId    = u.Data?.PlayerId ?? u.data?.PlayerId ?? null;
  const clockSeconds = u.Clock?.Seconds ?? u.clock?.seconds ?? null;
  const statusId    = u.StatusId ?? u.statusId;
  const confirmed   = u.Confirmed ?? u.confirmed ?? null;

  if (!fixtureId || !seq) return null;

  const minute = clockSeconds != null ? clockFromSeconds(clockSeconds, statusId) : null;
  const statConfig = STAT_KEY_MAP[action];

  if (!statConfig) {
    return {
      fixtureId,
      seq,
      participant,
      playerId,
      minute,
      actionType: action,
      onChainVerifiable: false,
      feedConfirmed: confirmed === true,
      statKey: null,
      newValue: null,
      shotOutcome: action === "shot" ? (u.Data?.Outcome ?? null) : null,
      varType: action === "var" ? (u.Data?.Type ?? null) : null,
    };
  }

  if (!participant) return null;

  const scoreBlock = u.Score ?? u.score;
  const totalValue = participant === 1
    ? scoreBlock?.Participant1?.Total?.[statConfig.scoreField]
    : scoreBlock?.Participant2?.Total?.[statConfig.scoreField];

  return {
    fixtureId,
    seq,
    participant,
    playerId,
    minute,
    actionType: action,
    onChainVerifiable: true,
    feedConfirmed: confirmed === true,
    statKey: participant === 1 ? statConfig.p1 : statConfig.p2,
    scoreField: statConfig.scoreField,
    newValue: totalValue ?? null,
  };
}

function clockFromSeconds(secondsRemaining, statusId) {
  const periodLength = 2700;
  const elapsed = periodLength - secondsRemaining;
  const baseMinute = Math.floor(elapsed / 60);
  return statusId === 4 ? baseMinute + 45 : baseMinute;
}

export async function fetchScoresSnapshot(session, fixtureId) {
  const res = await client(session).get(`/api/scores/snapshot/${fixtureId}`, {
    params: { asOf: Date.now() },
  });
  return res.data;
}

export async function fetchFixture(session, fixtureId) {
  const res = await client(session).get("/api/fixtures/snapshot");
  const fixtures = res.data || [];
  return fixtures.find((f) => (f.FixtureId ?? f.fixtureId) === fixtureId) ?? null;
}

export async function fetchCurrentStatTotal(session, fixtureId, participant, scoreField) {
  const snapshot = await fetchScoresSnapshot(session, fixtureId);
  const history = Array.isArray(snapshot) ? snapshot : (snapshot.data ?? []);

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

// Player name resolution
const lineupCache = new Map();

export async function buildLineupMap(session, fixtureId) {
  if (lineupCache.has(fixtureId)) return lineupCache.get(fixtureId);

  const snapshot = await fetchScoresSnapshot(session, fixtureId);
  const history = Array.isArray(snapshot) ? snapshot : (snapshot.data ?? []);
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

// On-chain validation
function toBytes32(value) {
  let bytes;
  if (Array.isArray(value)) bytes = Uint8Array.from(value);
  else if (value instanceof Uint8Array) bytes = value;
  else if (typeof value === "string" && value.startsWith("0x")) bytes = Buffer.from(value.slice(2), "hex");
  else bytes = Buffer.from(value, "base64");

  if (bytes.length !== 32) throw new Error(`Expected 32 bytes, received ${bytes.length}`);
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

export async function runOnChainValidation(session, program, { fixtureId, seq, statKey, expectedValue }) {
  if (expectedValue == null) {
    throw new Error("expectedValue is required — fetch current stat total first");
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
