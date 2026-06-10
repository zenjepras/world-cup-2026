#!/usr/bin/env node
/* Fetches World Cup results + standings from API-Football (api-football.com)
   and writes results.json. Runs on a schedule via GitHub Actions.
   Requires env var API_FOOTBALL_KEY (free key from api-football.com). */

const fs = require("fs");

const KEY = process.env.API_FOOTBALL_KEY;
if (!KEY) {
  console.error("API_FOOTBALL_KEY is not set. Add it as a repository secret.");
  process.exit(1);
}

const BASE = "https://v3.football.api-sports.io";
const HEADERS = { "x-apisports-key": KEY };
const LEAGUE = "league=1&season=2026"; // league 1 = FIFA World Cup

async function get(path) {
  const res = await fetch(BASE + path, { headers: HEADERS });
  if (!res.ok) throw new Error("API " + res.status + " on " + path);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length)
    throw new Error("API error on " + path + ": " + JSON.stringify(data.errors).slice(0, 300));
  return data;
}

/* normalise API-Football round names to the stage codes index.html expects */
function stage(round) {
  const r = String(round || "").toLowerCase();
  if (r.includes("group")) return "GROUP_STAGE";
  if (r.includes("32")) return "LAST_32";
  if (r.includes("16")) return "LAST_16";
  if (r.includes("quarter")) return "QUARTER_FINALS";
  if (r.includes("semi")) return "SEMI_FINALS";
  if (r.includes("3rd") || r.includes("third")) return "THIRD_PLACE";
  if (r.includes("final")) return "FINAL";
  return "";
}

const FINISHED = { FT: 1, AET: 1, PEN: 1 };

(async () => {
  const [fixData, standData] = await Promise.all([
    get("/fixtures?" + LEAGUE),
    get("/standings?" + LEAGUE).catch(e => { console.warn("standings unavailable:", e.message); return null; })
  ]);

  const matches = (fixData.response || []).map(m => {
    const out = {
      stage: stage(m.league && m.league.round),
      utcDate: m.fixture && m.fixture.date,
      home: m.teams && m.teams.home && m.teams.home.name,
      away: m.teams && m.teams.away && m.teams.away.name,
      status: (m.fixture && m.fixture.status && m.fixture.status.short) || ""
    };
    if (FINISHED[out.status] && m.goals && m.goals.home != null) {
      out.score = [m.goals.home, m.goals.away];
      const p = m.score && m.score.penalty;
      if (out.status === "PEN" && p && p.home != null) out.pens = [p.home, p.away];
    }
    return out;
  });

  const standings = {};
  if (standData && standData.response && standData.response[0]) {
    const groups = standData.response[0].league.standings || [];
    for (const table of groups) {
      if (!table.length) continue;
      const g = String(table[0].group || "").replace(/group\s*/i, "").trim();
      if (!g) continue;
      standings[g] = table.map(r => ({
        team: r.team && r.team.name,
        p: r.all.played, w: r.all.win, d: r.all.draw, l: r.all.lose,
        gf: r.all.goals.for, ga: r.all.goals.against, gd: r.goalsDiff, pts: r.points
      }));
    }
  }

  const out = {
    updated: new Date().toISOString(),
    source: "api-football.com",
    matches,
    standings
  };

  fs.writeFileSync("results.json", JSON.stringify(out));
  const finished = matches.filter(m => m.score).length;
  console.log("Wrote results.json:", matches.length, "matches,", finished, "with scores,",
    Object.keys(standings).length, "group tables.");
})().catch(e => { console.error(e.message); process.exit(1); });
