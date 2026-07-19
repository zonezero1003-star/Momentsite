import {
  subscribeScoreEvents, subscribeOddsEvents, detectMoment,
  runOnChainValidation, resolvePlayerName, fetchCurrentStatTotal,
} from "./txlineData.js";
import { getUmi, uploadMetadata, resolveAsset } from "./metaplex.js";
import { generateResolvedImage } from "./geminiImage.js";
import { PredictionsStore } from "../db/store.js";

/**
 * Two trust tiers, and the NFT metadata says which one applies — this
 * matters more now that moments beyond goals are supported:
 *
 *  - ON-CHAIN VERIFIED (goal, corner, yellow_card, red_card): the Soccer
 *    Feed doc's Full Game Stats table gives these dedicated stat keys, so
 *    validateStat can cryptographically prove the count. Same trust level
 *    as goals had before.
 *  - FEED-CONFIRMED ONLY (shot, var): there is no stat key for shots or
 *    VAR reviews in the on-chain spec. These can only be resolved based on
 *    the feed's own `Confirmed: true` flag — real TxODDS data, but not
 *    independently re-checkable on-chain the way the other four are.
 *
 * Player name resolution only applies where the feed carries PlayerId:
 * goal, yellow_card, red_card, shot all do; corner and var do not.
 */
export function startResolver({ session, backendWallet, latestOdds }) {
  const stopOdds = subscribeOddsEvents(
    session,
    (odds) => {
      const fixtureId = odds?.FixtureId ?? odds?.fixtureId;
      if (fixtureId) latestOdds.set(fixtureId, odds.nextGoalProbability ?? odds.value ?? null);
    },
    (err) => console.error("odds stream error:", err.message || err)
  );

  const stopScores = subscribeScoreEvents(
    session,
    async (event) => {
      const moment = detectMoment(event);
      if (!moment) return;

      const allOpenPredictions = await PredictionsStore.findOpenByFixtureAndType(moment.fixtureId, moment.actionType);
      // A prediction with a predictedParticipant only resolves off a moment
      // by that same team — otherwise (no team picked) it resolves on
      // either team's occurrence, same as before this feature existed.
      const openPredictions = allOpenPredictions.filter(
        (p) => p.predictedParticipant == null || Number(p.predictedParticipant) === moment.participant
      );
      if (openPredictions.length === 0) return;

      let verification;
      if (moment.onChainVerifiable) {
        verification = await verifyOnChain(session, moment);
        if (!verification) return; // logged inside verifyOnChain, bail without resolving
      } else {
        // shot / var — feed-confirmation only, no Merkle proof possible
        if (!moment.feedConfirmed) {
          console.warn(`${moment.actionType} on fixture ${moment.fixtureId} not yet Confirmed — waiting.`);
          return;
        }
        verification = { isValid: true, onChainVerified: false, note: "Feed-confirmed only — no on-chain stat key exists for this moment type." };
      }

      let playerName = null;
      if (moment.playerId != null) {
        try {
          playerName = await resolvePlayerName(session, moment.fixtureId, moment.playerId);
        } catch (err) {
          console.warn(`Player name lookup failed for fixture ${moment.fixtureId}:`, err.message);
        }
      }

      const umi = getUmi(backendWallet);
      for (const prediction of openPredictions) {
        try {
          const withinWindow = checkWindow(prediction.predictedWindow, moment.minute);
          const outcome = withinWindow ? "hit" : "miss";
          const [team, opponent] = (prediction.match || "").split(/ vs /i);

          const { imageUri, source } = await generateResolvedImage(umi, {
            match: prediction.match || prediction.fixtureId,
            momentType: moment.actionType,
            playerName,
            team: team?.trim(),
            opponent: opponent?.trim(),
            actualMinute: moment.minute,
            outcome,
            extra: { shotOutcome: moment.shotOutcome, varType: moment.varType },
          });

          const metadata = {
            name: prediction.match ? `${labelFor(moment.actionType)} Moment - ${prediction.match}` : `${labelFor(moment.actionType)} Moment`,
            description: verification.onChainVerified
              ? "A resolved MomentMarket prediction, verified via TxLINE's on-chain validateStat check."
              : "A resolved MomentMarket prediction, confirmed via TxLINE's live feed (no on-chain stat key exists for this moment type).",
            image: imageUri,
            attributes: [
              { trait_type: "Moment Type", value: moment.actionType },
              { trait_type: "Status", value: withinWindow ? "Resolved: Hit" : "Resolved: Miss" },
              { trait_type: "Actual Minute", value: moment.minute ?? "unknown" },
              { trait_type: "Scorer/Player", value: playerName ?? "Unknown" },
              { trait_type: "Image Source", value: source },
              { trait_type: "On-Chain Verified", value: String(verification.onChainVerified ?? true) },
            ],
            properties: {
              files: [{ uri: imageUri, type: "image/png" }],
              category: "image",
              txline_fixture_id: moment.fixtureId,
              txline_seq: moment.seq,
              txline_player_id: moment.playerId,
              verification: verification.onChainVerified
                ? { targetTs: verification.targetTs, epochDay: verification.epochDay, isValid: true }
                : { note: verification.note },
            },
          };

          const metadataUri = await uploadMetadata(umi, metadata);
          await resolveAsset(umi, { assetAddress: prediction.assetAddress, newMetadataUri: metadataUri });

          await PredictionsStore.update(prediction.assetAddress, {
            status: "resolved",
            outcome,
            scorer: playerName,
            onChainVerified: verification.onChainVerified,
            resolvedAt: Date.now(),
            imageUri,
            imageSource: source,
          });
        } catch (err) {
          console.error(`failed to resolve prediction ${prediction.assetAddress}:`, err.message);
        }
      }
    },
    (err) => console.error("scores stream error:", err.message || err)
  );

  return () => {
    stopOdds();
    stopScores();
  };
}

async function verifyOnChain(session, moment) {
  let expectedValue = moment.newValue;
  if (expectedValue == null) {
    expectedValue = await fetchCurrentStatTotal(session, moment.fixtureId, moment.participant, moment.scoreField);
    if (expectedValue == null) {
      console.error(`Could not determine ${moment.scoreField} total for fixture ${moment.fixtureId}, skipping validation`);
      return null;
    }
  }

  try {
    const onChain = await runOnChainValidation(session, session.program, {
      fixtureId: moment.fixtureId,
      seq: moment.seq,
      statKey: moment.statKey,
      expectedValue,
    });
    if (!onChain.isValid) {
      console.warn(
        `${moment.actionType} detected in live feed for fixture ${moment.fixtureId} but on-chain validation ` +
        `did NOT confirm it — not resolving predictions.`
      );
      return null;
    }
    return { isValid: true, onChainVerified: true, targetTs: onChain.targetTs, epochDay: onChain.epochDay };
  } catch (err) {
    console.error(`on-chain validation failed for fixture ${moment.fixtureId}:`, err.message);
    return null;
  }
}

function labelFor(actionType) {
  return { goal: "Goal", corner: "Corner", yellow_card: "Yellow Card", red_card: "Red Card", shot: "Shot", var: "VAR Review" }[actionType] ?? actionType;
}

function checkWindow(predictedWindow, actualMinute) {
  if (!predictedWindow || actualMinute == null) return true;

  switch (predictedWindow) {
    case "first_half":  return actualMinute <= 45;
    case "second_half": return actualMinute > 45;
    case "final_15":    return actualMinute >= 75;
  }

  const before = /before (\d+)/i.exec(predictedWindow);
  if (before) return actualMinute <= Number(before[1]);

  const after = /after (\d+)/i.exec(predictedWindow);
  if (after) return actualMinute > Number(after[1]);

  return true; // unrecognized format — don't fail a mint over a display string
}
