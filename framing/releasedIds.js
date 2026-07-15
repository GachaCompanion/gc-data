'use strict';

// Whitelist of released character/weapon IDs for nanoka.cc downloads, built from
// HoYoverse's own banner-schedule data (public, unauthenticated —
// raw.githubusercontent.com/DeKadey/gacha-companion). nanoka sometimes lists
// datamined/unreleased characters before they've officially shipped — this
// gates every nanoka fetch in downloader.js so we only ever pull content
// HoYoverse has actually released. Mirrors electron/engine/releasedIds.js in
// the main app.

const SCHEDULE_BASE = 'https://raw.githubusercontent.com/DeKadey/gacha-companion/main';

const _cache = {}; // game -> Set<string> | null

async function load(game) {
  try {
    const res = await fetch(`${SCHEDULE_BASE}/${game}/banner-schedule-${game}.json`);
    if (!res.ok) return null;
    const schedule = await res.json();
    const now = Date.now();
    const ids = new Set();
    for (const b of schedule) {
      if (b.featuredId == null) continue;
      const start = b.start ? Date.parse(b.start.replace(' ', 'T') + 'Z') : NaN;
      if (!Number.isNaN(start) && start > now) continue; // pre-announced, not live yet
      ids.add(String(b.featuredId));
    }
    return ids;
  } catch {
    return null;
  }
}

// Call once at startup, before any isReleased() check.
async function init(games) {
  for (const game of games) {
    _cache[game] = await load(game);
  }
}

function isReleased(game, id) {
  const set = _cache[game];
  if (!set) return false; // schedule unavailable — fail closed, nothing to sync until it loads
  return set.has(String(id));
}

module.exports = { init, isReleased };
