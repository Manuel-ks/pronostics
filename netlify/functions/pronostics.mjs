// Fonction Netlify : analyse des matchs et pronostics (modèle de Poisson).
// Données : football-data.org (FOOTBALL_DATA_API_KEY) et API-Football (API_FOOTBALL_KEY).
// Les clés restent côté serveur, jamais dans la page.

const BASE_URL = "https://api.football-data.org/v4";
const COMPETITIONS = ["PL", "FL1", "CL", "PD", "SA", "BL1", "ELC", "DED", "PPL", "BSA"];
const HALF_LIFE_DAYS = 90; // un match vieux de 90 jours compte deux fois moins
const PRIOR_MATCHES = 4; // poids de la moyenne du championnat
const MAX_GOALS = 8;
const MATCHES_SHOWN = 60;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function apiGet(path, params, key) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "X-Auth-Token": key } });
  if (r.status === 429) {
    throw new ApiError(429, "Limite de requêtes atteinte. Réessayez dans une minute.");
  }
  if (!r.ok) {
    throw new ApiError(r.status, `Erreur de l'API (${r.status}). Cette compétition n'est peut-être pas incluse dans votre offre.`);
  }
  return r.json();
}

async function loadMatches(code, key, now) {
  const season = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const current = await apiGet(`/competitions/${code}/matches`, { season }, key);
  let matches = current.matches;
  try {
    // la saison précédente donne plus de recul en début de saison
    const previous = await apiGet(`/competitions/${code}/matches`, { season: season - 1 }, key);
    matches = matches.concat(previous.matches);
  } catch {
    /* facultatif */
  }
  return matches;
}


// ---------- API-Football (championnats absents de football-data.org) ----------
const AF_URL = "https://v3.football.api-sports.io";
// Identifiants de ligue API-Football. Vérifiez-les dans votre tableau de bord si une ligue reste vide.
const AF_LEAGUES = new Set([3, 848, 62, 141, 79, 136, 144, 179, 203, 218, 207, 197, 119, 106, 345, 333, 113, 103]);
const AF_CALENDAR = new Set([113, 103]); // saisons sur l'année civile (Allsvenskan, Eliteserien)
const AF_FINISHED = new Set(["FT", "AET", "PEN"]);
const AF_UPCOMING = new Set(["NS", "TBD"]);

async function afGet(params, key) {
  const url = new URL(AF_URL + "/fixtures");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "x-apisports-key": key } });
  if (r.status === 429) throw new ApiError(429, "Limite de requêtes API-Football atteinte. Réessayez plus tard.");
  if (!r.ok) throw new ApiError(r.status, `Erreur API-Football (${r.status}).`);
  const d = await r.json();
  const errors = d.errors && !Array.isArray(d.errors) ? d.errors : {};
  if (errors.requests || errors.rateLimit) {
    throw new ApiError(429, "Limite de requêtes API-Football atteinte (100 par jour en offre gratuite).");
  }
  const messages = Object.values(errors);
  if (messages.length) throw new ApiError(403, `API-Football : ${messages.join(" ")}`);
  return d.response ?? [];
}

// Met les matchs d'API-Football dans le même format que football-data.org.
function normalizeAF(fx) {
  const short = fx.fixture.status.short;
  const ft = fx.score?.fulltime ?? {};
  return {
    status: AF_FINISHED.has(short) ? "FINISHED" : AF_UPCOMING.has(short) ? "SCHEDULED" : "OTHER",
    utcDate: fx.fixture.date,
    homeTeam: { id: fx.teams.home.id, name: fx.teams.home.name },
    awayTeam: { id: fx.teams.away.id, name: fx.teams.away.name },
    score: { fullTime: { home: ft.home ?? fx.goals?.home ?? null, away: ft.away ?? fx.goals?.away ?? null } },
  };
}

async function loadMatchesAF(leagueId, key, now) {
  const year = now.getUTCFullYear();
  const season = AF_CALENDAR.has(leagueId) ? year : now.getUTCMonth() >= 6 ? year : year - 1;
  let matches = (await afGet({ league: leagueId, season }, key)).map(normalizeAF);
  // Début de saison : on ajoute la saison précédente (1 requête de plus) pour avoir du recul.
  if (matches.filter((m) => m.status === "FINISHED").length < 40) {
    try {
      matches = matches.concat((await afGet({ league: leagueId, season: season - 1 }, key)).map(normalizeAF));
    } catch {
      /* facultatif : la saison précédente peut être refusée par l'offre gratuite */
    }
  }
  return matches;
}

function parseFinished(matches, now) {
  const rows = [];
  for (const m of matches) {
    const ft = m.score?.fullTime;
    if (m.status !== "FINISHED" || ft?.home == null || ft?.away == null) continue;
    const date = new Date(m.utcDate);
    const days = Math.max((now - date) / 86400000, 0);
    rows.push({
      h: m.homeTeam.id, a: m.awayTeam.id, hg: ft.home, ag: ft.away,
      w: 0.5 ** (days / HALF_LIFE_DAYS), date,
    });
  }
  return rows;
}

const EMPTY = { hf: 0, ha: 0, hw: 0, af: 0, aa: 0, aw: 0 };

function buildRatings(rows) {
  const total = rows.reduce((s, r) => s + r.w, 0);
  if (total === 0) return null;
  const avgH = Math.max(rows.reduce((s, r) => s + r.w * r.hg, 0) / total, 0.1);
  const avgA = Math.max(rows.reduce((s, r) => s + r.w * r.ag, 0) / total, 0.1);
  const teams = new Map();
  const slot = (id) => {
    if (!teams.has(id)) teams.set(id, { ...EMPTY });
    return teams.get(id);
  };
  for (const r of rows) {
    const h = slot(r.h);
    h.hf += r.w * r.hg; h.ha += r.w * r.ag; h.hw += r.w;
    const a = slot(r.a);
    a.af += r.w * r.ag; a.aa += r.w * r.hg; a.aw += r.w;
  }
  return { avgH, avgA, teams };
}

function expectedGoals({ avgH, avgA, teams }, homeId, awayId) {
  const h = teams.get(homeId) ?? EMPTY;
  const a = teams.get(awayId) ?? EMPTY;
  const k = PRIOR_MATCHES;
  const attH = (h.hf + k * avgH) / (h.hw + k) / avgH; // attaque à domicile
  const defH = (h.ha + k * avgA) / (h.hw + k) / avgA; // défense à domicile
  const attA = (a.af + k * avgA) / (a.aw + k) / avgA; // attaque à l'extérieur
  const defA = (a.aa + k * avgH) / (a.aw + k) / avgH; // défense à l'extérieur
  return [avgH * attH * defA, avgA * attA * defH];
}

const FACT = [1];
for (let i = 1; i <= MAX_GOALS; i++) FACT[i] = FACT[i - 1] * i;
const poisson = (k, lam) => Math.exp(-lam) * lam ** k / FACT[k];

function outcomeProbs(lamH, lamA) {
  let ph = 0, pd = 0, pa = 0, over25 = 0, btts = 0;
  let best = [0, 0, 0];
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = poisson(i, lamH) * poisson(j, lamA);
      if (i > j) ph += p; else if (i === j) pd += p; else pa += p;
      if (i + j > 2) over25 += p;
      if (i > 0 && j > 0) btts += p;
      if (p > best[2]) best = [i, j, p];
    }
  }
  const t = ph + pd + pa;
  return {
    home: ph / t, draw: pd / t, away: pa / t,
    over25: over25 / t, btts: btts / t, score: `${best[0]}-${best[1]}`,
  };
}

function form(rows, id, n = 5) {
  return rows
    .filter((r) => r.h === id || r.a === id)
    .sort((x, y) => y.date - x.date)
    .slice(0, n)
    .map((r) => {
      const [gf, ga] = r.h === id ? [r.hg, r.ag] : [r.ag, r.hg];
      return gf > ga ? "V" : gf === ga ? "N" : "D";
    })
    .reverse(); // du plus ancien au plus récent
}

function headToHead(rows, names, homeId, awayId, n = 3) {
  return rows
    .filter((r) => (r.h === homeId && r.a === awayId) || (r.h === awayId && r.a === homeId))
    .sort((x, y) => y.date - x.date)
    .slice(0, n)
    .map((r) => `${r.date.toISOString().slice(0, 10)} : ${names.get(r.h)} ${r.hg}-${r.ag} ${names.get(r.a)}`);
}

function verdict(p, home, away) {
  const top = ["home", "draw", "away"].reduce((a, b) => (p[b] > p[a] ? b : a));
  const label = { home: `Victoire ${home}`, draw: "Match nul", away: `Victoire ${away}` }[top];
  const level = p[top] >= 0.55 ? "avantage net" : p[top] >= 0.45 ? "léger avantage" : "match très ouvert";
  return [label, level];
}

function analyze(matches, now) {
  const rows = parseFinished(matches, now);
  const ratings = buildRatings(rows);
  if (!ratings) throw new ApiError(404, "Pas encore assez de matchs joués pour cette compétition.");
  const names = new Map();
  for (const m of matches) {
    for (const t of [m.homeTeam, m.awayTeam]) {
      if (t?.id) names.set(t.id, t.shortName || t.name);
    }
  }
  const upcoming = matches
    .filter((m) => ["SCHEDULED", "TIMED"].includes(m.status) && m.homeTeam?.id && m.awayTeam?.id)
    .sort((x, y) => x.utcDate.localeCompare(y.utcDate))
    .slice(0, MATCHES_SHOWN);
  return upcoming.map((m) => {
    const hid = m.homeTeam.id, aid = m.awayTeam.id;
    const home = names.get(hid), away = names.get(aid);
    const [lamH, lamA] = expectedGoals(ratings, hid, aid);
    const p = outcomeProbs(lamH, lamA);
    const [label, level] = verdict(p, home, away);
    return {
      home, away, date: m.utcDate, p, lamH, lamA, label, level,
      odds: { home: 1 / p.home, draw: 1 / p.draw, away: 1 / p.away },
      formH: form(rows, hid), formA: form(rows, aid),
      h2h: headToHead(rows, names, hid, aid),
    };
  });
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

export default async (req) => {
  const code = new URL(req.url).searchParams.get("c") || "PL";
  const af = /^AF(\d+)$/.exec(code);
  const afId = af ? Number(af[1]) : null;
  const known = afId ? AF_LEAGUES.has(afId) : COMPETITIONS.includes(code);
  if (!known) return json({ error: "Compétition inconnue." }, 400);
  const key = afId ? process.env.API_FOOTBALL_KEY : process.env.FOOTBALL_DATA_API_KEY;
  if (!key) {
    const name = afId ? "API_FOOTBALL_KEY" : "FOOTBALL_DATA_API_KEY";
    return json({ error: `Clé d'API manquante : ajoutez ${name} dans les variables d'environnement Netlify.` }, 500);
  }
  try {
    const now = new Date();
    const matches = afId ? await loadMatchesAF(afId, key, now) : await loadMatches(code, key, now);
    const results = analyze(matches, now);
    // Cache plus long pour API-Football afin d'économiser les 100 requêtes quotidiennes.
    const ttl = afId ? 10800 : 600;
    return json({ results }, 200, {
      "Cache-Control": "public, max-age=600",
      "Netlify-CDN-Cache-Control": `public, max-age=${ttl}, stale-while-revalidate=86400`,
    });
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    return json({ error: "Impossible de joindre le service de données. Réessayez plus tard." }, 502);
  }
};
