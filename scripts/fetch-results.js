#!/usr/bin/env node
/* Fetches World Cup results + standings and writes results.json.
   Works with EITHER provider — set whichever secret you have:
     FOOTBALL_DATA_TOKEN  -> football-data.org (free tier covers the World Cup)
     API_FOOTBALL_KEY     -> api-football.com  (requires a paid plan for 2026)
   If both are set, football-data.org is used. */

const fs = require("fs");

const FD_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const AF_KEY = process.env.API_FOOTBALL_KEY;

if (!FD_TOKEN && !AF_KEY) {
  console.error("No API key found. Add FOOTBALL_DATA_TOKEN (or API_FOOTBALL_KEY) as a repository secret.");
  process.exit(1);
}

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

/* ---------------- football-data.org ---------------- */
async function fromFootballData() {
  const BASE = "https://api.football-data.org/v4/competitions/WC";
  const HEADERS = { "X-Auth-Token": FD_TOKEN };
  async function get(path) {
    const res = await fetch(BASE + path, { headers: HEADERS });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error("API " + res.status + " on " + path + ": " + body.slice(0, 300));
    }
    return res.json();
  }
  const [matchData, standingData, scorerData] = await Promise.all([
    get("/matches"),
    get("/standings").catch(e => { console.warn("standings unavailable:", e.message); return null; }),
    get("/scorers?limit=10").catch(e => { console.warn("scorers unavailable:", e.message); return null; })
  ]);
  const matches = (matchData.matches || []).map(m => {
    const out = {
      stage: stage(m.stage),
      utcDate: m.utcDate,
      home: (m.homeTeam && (m.homeTeam.name || m.homeTeam.shortName)) || null,
      away: (m.awayTeam && (m.awayTeam.name || m.awayTeam.shortName)) || null,
      status: m.status,
      venue: m.venue ? [m.venue.name, m.venue.city].filter(Boolean).join(" \u00b7 ") : null
    };
    const ft = m.score && m.score.fullTime;
    if (m.status === "FINISHED" && ft && ft.home != null) {
      out.score = [ft.home, ft.away];
      const p = m.score.penalties;
      if (p && p.home != null) out.pens = [p.home, p.away];
    }
    return out;
  });
  const standings = {};
  if (standingData && standingData.standings) {
    for (const s of standingData.standings) {
      if (s.type && s.type !== "TOTAL") continue;
      const g = (s.group || "").replace("GROUP_", "");
      if (!g) continue;
      standings[g] = (s.table || []).map(r => ({
        team: r.team && (r.team.shortName || r.team.name),
        p: r.playedGames, w: r.won, d: r.draw, l: r.lost,
        gf: r.goalsFor, ga: r.goalsAgainst, gd: r.goalDifference, pts: r.points
      }));
    }
  }
  const scorers = (scorerData && scorerData.scorers || []).map(r => ({
    name: r.player && r.player.name, team: r.team && (r.team.shortName || r.team.name),
    value: r.goals
  }));
  return { source: "football-data.org", matches, standings, scorers };
}

/* ---------------- api-football.com ---------------- */
async function fromApiFootball() {
  const BASE = "https://v3.football.api-sports.io";
  const HEADERS = { "x-apisports-key": AF_KEY };
  const LEAGUE = "league=1&season=2026";
  async function get(path) {
    const res = await fetch(BASE + path, { headers: HEADERS });
    if (!res.ok) throw new Error("API " + res.status + " on " + path);
    const data = await res.json();
    if (data.errors && Object.keys(data.errors).length)
      throw new Error("API error on " + path + ": " + JSON.stringify(data.errors).slice(0, 300));
    return data;
  }
  const FINISHED = { FT: 1, AET: 1, PEN: 1 };
  const [fixData, standData, scorerData] = await Promise.all([
    get("/fixtures?" + LEAGUE),
    get("/standings?" + LEAGUE).catch(e => { console.warn("standings unavailable:", e.message); return null; }),
    get("/players/topscorers?" + LEAGUE).catch(e => { console.warn("topscorers unavailable:", e.message); return null; })
  ]);
  function players(data, key) {
    if (!data || !data.response) return [];
    return data.response.slice(0, 10).map(p => ({
      name: p.player && p.player.name,
      team: p.statistics && p.statistics[0] && p.statistics[0].team && p.statistics[0].team.name,
      value: p.statistics && p.statistics[0] && p.statistics[0].goals
        ? p.statistics[0].goals.total : 0
    })).filter(p => p.name && p.value > 0);
  }
  const matches = (fixData.response || []).map(m => {
    const out = {
      stage: stage(m.league && m.league.round),
      utcDate: m.fixture && m.fixture.date,
      home: m.teams && m.teams.home && m.teams.home.name,
      away: m.teams && m.teams.away && m.teams.away.name,
      status: (m.fixture && m.fixture.status && m.fixture.status.short) || "",
      venue: (m.fixture && m.fixture.venue && m.fixture.venue.name)
        ? [m.fixture.venue.name, m.fixture.venue.city].filter(Boolean).join(" \u00b7 ") : null
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
    for (const table of (standData.response[0].league.standings || [])) {
      if (!table.length) continue;
      const label = String(table[0].group || "");
      const m = label.match(/group\s+([A-L])\s*$/i);
      const g = m ? m[1].toUpperCase() : "3RD";
      standings[g] = table.map(r => ({
        team: r.team && r.team.name,
        p: r.all.played, w: r.all.win, d: r.all.draw, l: r.all.lose,
        gf: r.all.goals.for, ga: r.all.goals.against, gd: r.goalsDiff, pts: r.points
      }));
    }
  }
  return { source: "api-football.com", matches, standings,
           scorers: players(scorerData, "goals") };
}

(async () => {
  const data = FD_TOKEN ? await fromFootballData() : await fromApiFootball();
  const out = { updated: new Date().toISOString(), ...data };
  fs.writeFileSync("results.json", JSON.stringify(out));
  const finished = out.matches.filter(m => m.score).length;
  console.log("[" + out.source + "] Wrote results.json:", out.matches.length, "matches,",
    finished, "with scores,", Object.keys(out.standings).length, "group tables.");
})().catch(e => { console.error(e.message); process.exit(1); });
