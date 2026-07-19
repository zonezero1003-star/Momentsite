import { Router } from "express";
import axios from "axios";
import { config } from "../config.js";
import { SUPPORTED_MOMENT_TYPES } from "../services/txlineData.js";

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

/**
 * GET /api/fixtures
 * Returns the live/upcoming fixture snapshot from TxLINE, trimmed down to
 * what the frontend's fixture picker needs. Session is the same TxLINE
 * session server.js already established at startup — no separate auth here.
 */
export function fixturesRouter({ session }) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const result = await client(session).get("/api/fixtures/snapshot");
      const raw = result.data || [];

      const fixtures = raw.map((f) => {
        const isP1Home = f.Participant1IsHome !== false; // default true if missing
        return {
          fixtureId: f.FixtureId,
          home: isP1Home ? f.Participant1 : f.Participant2,
          away: isP1Home ? f.Participant2 : f.Participant1,
          // Raw TxLINE participant numbers (1 or 2) behind home/away, so a
          // "backing <team>" selection in the frontend can be sent straight
          // through to the resolver for matching against detectMoment's
          // moment.participant — without the frontend needing to know
          // TxLINE's home/away convention itself.
          homeParticipant: isP1Home ? 1 : 2,
          awayParticipant: isP1Home ? 2 : 1,
          status: f.GameState ?? null,
          kickoff: f.StartTime ?? null,
          competition: f.Competition ?? null,
        };
      }).filter((f) => f.fixtureId != null);

      res.json({ ok: true, fixtures });
    } catch (err) {
      console.error("fetching fixtures failed:", err.message);
      res.status(502).json({ error: "Could not reach TxLINE fixtures feed" });
    }
  });

  /** GET /api/fixtures/moment-types — the values predictedEvent accepts */
  router.get("/moment-types", (req, res) => {
    res.json({ ok: true, momentTypes: SUPPORTED_MOMENT_TYPES });
  });

  return router;
}
