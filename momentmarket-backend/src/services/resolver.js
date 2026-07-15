import { subscribeScoreEvents, subscribeOddsEvents, detectGoal, runOnChainValidation } from "./txlineData.js";
import { getUmi, uploadMetadata, resolveAsset } from "./metaplex.js";
import { generateResolvedImage } from "./geminiImage.js";
import { PredictionsStore } from "../db/store.js";

/**
 * Runs in the background for the life of the server:
 *  - keeps `latestOdds` updated so new predictions capture a fresh number
 *  - watches Scores for goals (stat-key comparison, see txlineData.js)
 *  - runs the REAL on-chain validateStat check before treating a goal as
 *    confirmed — this is what makes "resolved" a trustless guarantee
 *    instead of just "the live feed said so."
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
      const goal = detectGoal(event);
      if (!goal) return;

      const openPredictions = PredictionsStore.findOpenByFixtureAndType(goal.fixtureId, "goal");
      if (openPredictions.length === 0) return;

      // Run the real on-chain check ONCE per goal event, reuse the result
      // for every open prediction on this fixture.
      let onChain;
      try {
        onChain = await runOnChainValidation(session, session.program, {
          fixtureId: goal.fixtureId,
          seq: goal.seq,
          statKey: goal.statKey,
          expectedValue: goal.newValue,
        });
      } catch (err) {
        console.error(`on-chain validation failed for fixture ${goal.fixtureId}:`, err.message);
        return; // don't resolve anything if we can't get a real proof
      }

      if (!onChain.isValid) {
        console.warn(
          `Goal detected in live feed for fixture ${goal.fixtureId} but on-chain validation ` +
          `did NOT confirm it (predicate rejected or proof mismatch) — not resolving predictions.`
        );
        return;
      }

      const umi = getUmi(backendWallet);
      for (const prediction of openPredictions) {
        try {
          const withinWindow = checkWindow(prediction.predictedWindow, goal.minute);
          const outcome = withinWindow ? "hit" : "miss";
          const status = withinWindow ? "Resolved: Hit" : "Resolved: Miss";

          const { imageUri, source } = await generateResolvedImage(umi, {
            match: prediction.match || prediction.fixtureId,
            playerDescription: "a player in a white and light blue kit with a captain's armband", // generic by default — see likeness discussion before using a real name here
            actualMinute: goal.minute,
            outcome,
          });

          const metadata = {
            name: prediction.match ? `Goal Moment - ${prediction.match}` : "Goal Moment",
            description: "A resolved MomentMarket prediction, verified via TxLINE's on-chain validateStat check.",
            image: imageUri,
            attributes: [
              { trait_type: "Status", value: status },
              { trait_type: "Actual Minute", value: goal.minute ?? "unknown" },
              { trait_type: "Image Source", value: source },
              { trait_type: "On-Chain Verified", value: "true" },
            ],
            properties: {
              files: [{ uri: imageUri, type: source === "gemini" ? "image/png" : "image/svg+xml" }],
              category: "image",
              txline_fixture_id: goal.fixtureId,
              txline_seq: goal.seq,
              txline_stat_key: goal.statKey,
              // Store enough that anyone can independently re-run validateStat
              // themselves later — this is the actual trustless part.
              on_chain_validation: {
                targetTs: onChain.targetTs,
                epochDay: onChain.epochDay,
                isValid: onChain.isValid,
              },
            },
          };

          const metadataUri = await uploadMetadata(umi, metadata);
          await resolveAsset(umi, { assetAddress: prediction.assetAddress, newMetadataUri: metadataUri });

          PredictionsStore.update(prediction.assetAddress, {
            status: "resolved",
            outcome,
            onChainVerified: true,
            resolvedAt: Date.now(),
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

function checkWindow(predictedWindow, actualMinute) {
  if (!predictedWindow || actualMinute == null) return true;
  const match = /before (\d+)/i.exec(predictedWindow);
  if (!match) return true;
  return actualMinute <= Number(match[1]);
}
