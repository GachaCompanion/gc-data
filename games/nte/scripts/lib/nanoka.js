// Fetches character/arc reference data from nanoka.cc's public JSON API
// (reverse-engineered from nte.nanoka.cc's SvelteKit bundle — there is no
// documented API, this is the same data nte.nanoka.cc's own pages fetch
// client-side).
//
// Endpoint shapes (confirmed working, no auth/referer required beyond a
// normal browser UA):
//   https://static.nanoka.cc/manifest.json
//     -> { nte: { live: "1.2", latest: "1.2.14", ... }, gi: {...}, ... }
//   https://static.nanoka.cc/nte/{version}/character.json
//     -> { "1075": { id, rarity, en, ko, zh, ja, icon, icon_gacha, ... }, ... }
//     (no locale in the path for the bulk list — "en" etc. are top-level
//     fields on each entry)
//   https://static.nanoka.cc/nte/{version}/weapon.json
//     -> { "fork_Arachne": { id, rarity, en, ko, zh, ja, icon, atk, ... }, ... }
//   Images: https://static.nanoka.cc/assets/nte{icon_path}.webp
//
// Character keys are numeric-string IDs; arc/weapon keys are the game's own
// "fork_<name>" identifiers with inconsistent casing (nanoka lowercases
// everything, the real wire protocol does not — see rewardMappings.js in the
// main app). This module always returns nanoka's own casing for `key`; the
// caller is responsible for preferring its own already-verified casing when
// one exists (see build.js).

const https = require('https');

const STATIC_BASE = 'https://static.nanoka.cc';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (nte-banner-schedule-bot)' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timed out: ${url}`)); });
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (nte-banner-schedule-bot)' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timed out: ${url}`)); });
  });
}

async function resolveNteVersion() {
  const manifest = await fetchJson(`${STATIC_BASE}/manifest.json`);
  const nte = manifest.nte || {};
  return nte.live || nte.latest;
}

// Returns { charactersByName: Map<name, entry>, arcsByName: Map<name, entry> }
// where entry = { key, id/en name, rarity, iconPath, gachaIconPath? }.
// Matching is done by exact display-name text (nanoka's "en" field), which is
// the same text gamewith.net's Pickup Target lines use.
async function loadNanokaRoster() {
  const version = await resolveNteVersion();
  const [characterMap, weaponMap] = await Promise.all([
    fetchJson(`${STATIC_BASE}/nte/${version}/character.json`),
    fetchJson(`${STATIC_BASE}/nte/${version}/weapon.json`),
  ]);

  const charactersByName = new Map();
  for (const [key, entry] of Object.entries(characterMap)) {
    if (!entry.en) continue;
    charactersByName.set(entry.en, {
      key,
      id: Number(key),
      name: entry.en,
      rarity: entry.rarity,
      // Small avatar icon (~30KB) — used for the banner panel. NOT
      // icon_gacha (the ~300KB splash art on the per-character detail
      // endpoint, static.nanoka.cc/nte/{version}/{locale}/character/{id}.json)
      // — that's reserved for a future showcase feature, fetched separately
      // if/when that's built.
      iconPath: entry.icon,
    });
  }

  const arcsByName = new Map();
  for (const [key, entry] of Object.entries(weaponMap)) {
    if (!entry.en) continue;
    arcsByName.set(entry.en, {
      key,
      name: entry.en,
      rarity: entry.rarity,
      iconPath: entry.icon,
    });
  }

  return { version, charactersByName, arcsByName };
}

function nanokaImageUrl(iconPath) {
  return `${STATIC_BASE}/assets/nte${iconPath}.webp`;
}

module.exports = { loadNanokaRoster, nanokaImageUrl, fetchBuffer, fetchJson };
