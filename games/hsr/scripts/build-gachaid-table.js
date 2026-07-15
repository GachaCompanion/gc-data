// Scans StarRailStation's public warp_fetch API to resolve their internal,
// private gachaId (banner-instance ID) for every HSR character/light-cone
// banner — cross-referenced against this repo's own banner-schedule-hsr.json
// so the output table is keyed by something meaningful (featuredId/version),
// not just a raw ID dump.
//
// Why this exists: gacha-companion's HSR .dat export needs a real gachaId
// per pull to be importable back into StarRailStation. That ID is
// StarRailStation's own private bookkeeping — no official source (not
// mihoyo's API, not any game data file) exposes it. The only way to learn
// it is to ask StarRailStation's own site, which is what this script does.
// The shipped app never calls their API directly — it only reads the static
// table this script produces, refreshed periodically by CI.
//
// Endpoint (public, unauthenticated, no key needed):
//   GET https://starrailstation.com/api/v1/warp_fetch/{id}
//   -> { stats: { day, rateup, rerun, companion_banner_id, ... } }
//   day:    a proleptic-Gregorian ordinal date (day 1 = 0000-01-01).
//           Converts to a real date via (day - 719163) days after the Unix
//           epoch (719163 = the same ordinal for 1970-01-01).
//   rateup: the featured item's real, official numeric ID — matches
//           banner-schedule-hsr.json's own `featuredId` field exactly.
//
// Banner-ID ranges (StarRailStation's own scheme, inferred from
// observation, not returned by the API): 1001/4001/5001 = fixed singleton
// banners (Stellar/Departure/special — never rotate, no lookup needed);
// 2000-2999 = character event; 3000-3999 = light cone event.
//
// Merge logic is additive-only (same precedent as wuwa/scripts/build.js) —
// a rerun never removes or overwrites an already-resolved entry, only adds
// newly-discovered ones past the previous frontier. Safe to run on every
// scheduled trigger without ever losing history.
//
// Run with: node hsr/scripts/build-gachaid-table.js
// (from the repo root, so the relative output paths below resolve correctly)

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://starrailstation.com/api/v1/warp_fetch/';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

const OUT_DIR       = path.join(__dirname, '..');
const SCHEDULE_PATH = path.join(OUT_DIR, 'banner-schedule-hsr.json');
const RAW_PATH      = path.join(OUT_DIR, 'gachaid-scan-raw.json');
const TABLE_PATH    = path.join(OUT_DIR, 'gachaid-table.json');

const CONCURRENCY      = 5;
const DELAY_MS         = 150;
const MISS_STREAK_STOP = 40; // consecutive misses before assuming we've hit the frontier
const LOOKBACK         = 20; // rescan a few IDs behind the last-known frontier in case of gaps

const ORDINAL_EPOCH_OFFSET = 719163;

function ordinalDayToISODate(day) {
  if (day == null) return null;
  return new Date((day - ORDINAL_EPOCH_OFFSET) * 86400000).toISOString().slice(0, 10);
}

function guessType(id) {
  if (id === 1001) return 'standard';
  if (id === 4001) return 'beginner';
  if (id === 5001) return 'special';
  if (id >= 2000 && id < 3000) return 'character';
  if (id >= 3000 && id < 4000) return 'weapon';
  return 'unknown';
}

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return fallback; }
}

async function fetchOne(id) {
  try {
    const res = await fetch(API_BASE + id, { headers: HEADERS });
    if (!res.ok) return null;
    const json = await res.json();
    const s = json?.stats;
    if (!s || s.rateup == null) return null;
    return {
      id,
      type:   guessType(id),
      day:    s.day ?? null,
      date:   ordinalDayToISODate(s.day),
      rateup: s.rateup ?? null,
      rerun:  !!s.rerun,
    };
  } catch (_) {
    return null;
  }
}

async function scanRange(from, to) {
  const results = {};
  let missStreak = 0;

  for (let start = from; start <= to; start += CONCURRENCY) {
    const batch = [];
    for (let id = start; id < Math.min(start + CONCURRENCY, to + 1); id++) batch.push(id);

    const settled = await Promise.all(batch.map(fetchOne));
    let batchHadHit = false;
    for (let i = 0; i < batch.length; i++) {
      const r = settled[i];
      if (r) { results[batch[i]] = r; batchHadHit = true; }
    }

    missStreak = batchHadHit ? 0 : missStreak + batch.length;
    if (missStreak >= MISS_STREAK_STOP) break;
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  return results;
}

function crossReference(raw, schedule) {
  const byFeaturedId = {};
  for (const b of schedule) {
    if (b.featuredId == null) continue;
    (byFeaturedId[b.featuredId] ??= []).push(b);
  }

  const table = {};
  const unmatched = [];

  for (const entry of Object.values(raw)) {
    if (entry.type !== 'character' && entry.type !== 'weapon') continue;
    const candidates = byFeaturedId[entry.rateup];
    if (!candidates?.length) { unmatched.push(entry); continue; }

    let best = candidates.find(b => b.start && b.end && entry.date >= b.start.slice(0, 10) && entry.date <= b.end.slice(0, 10));
    if (!best) {
      best = [...candidates].sort((a, b) =>
        Math.abs(new Date(a.start) - new Date(entry.date)) - Math.abs(new Date(b.start) - new Date(entry.date)),
      )[0];
    }

    const key = `${entry.type}:${best.featuredId}:${best.version}:${best.phase ?? ''}`;
    table[key] = { gachaId: entry.id, bannerName: best.name, version: best.version, phase: best.phase ?? null };
  }

  return { table, unmatched };
}

async function main() {
  const existingRaw = loadJson(RAW_PATH, {});
  const knownIds = Object.keys(existingRaw).map(Number);

  const charFrontier = Math.max(2000, ...knownIds.filter(id => id >= 2000 && id < 3000), 1999) - LOOKBACK;
  const lcFrontier    = Math.max(3000, ...knownIds.filter(id => id >= 3000 && id < 4000), 2999) - LOOKBACK;

  console.log(`scanning from char=${charFrontier}, lc=${lcFrontier}...`);
  const [charScan, lcScan] = await Promise.all([
    scanRange(charFrontier, charFrontier + 400),
    scanRange(lcFrontier, lcFrontier + 400),
  ]);

  const merged = { ...existingRaw, ...charScan, ...lcScan };
  fs.writeFileSync(RAW_PATH, JSON.stringify(merged, null, 2));
  console.log(`raw cache: ${Object.keys(merged).length} total entries (${Object.keys(merged).length - knownIds.length} new)`);

  const schedule = loadJson(SCHEDULE_PATH, []);
  const { table, unmatched } = crossReference(merged, schedule);

  fs.writeFileSync(TABLE_PATH, JSON.stringify(table, null, 2));
  console.log(`gachaid-table.json: ${Object.keys(table).length} entries, ${unmatched.length} unmatched`);
  for (const u of unmatched) console.log(`  unmatched: id=${u.id} type=${u.type} rateup=${u.rateup} date=${u.date}`);
}

main();
