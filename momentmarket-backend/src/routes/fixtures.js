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

      // TEMP: hit /api/fixtures?raw=1 to see the first untouched fixture
      // object exactly as TxLINE sends it, so we can fix the field mapping
      // below instead of guessing. Remove this once mapping is confirmed.
      if (req.query.raw) {
        return res.json({ ok: true, sample: raw[0] ?? null, count: raw.length });
      }

      const fixtures = raw.map((f) => ({
        fixtureId: f.FixtureId ?? f.fixtureId,
        home: f.HomeTeam ?? f.homeTeam ?? "Home",
        away: f.AwayTeam ?? f.awayTeam ?? "Away",
        status: f.StatusId ?? f.statusId ?? null,
        kickoff: f.StartTime ?? f.startTime ?? null,
      })).filter((f) => f.fixtureId != null);

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
