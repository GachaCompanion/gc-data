// Fetches character/weapon reference data from nanoka.cc's public JSON API
// for Wuthering Waves (game key "ww" in the shared manifest) — the same
// undocumented-but-stable API nte/scripts/lib/nanoka.js already uses for
// NTE, reverse-engineered from ww.nanoka.cc's own client-side fetches.
//
// Endpoint shapes (confirmed working, no auth/referer required beyond a
// normal browser UA):
//   https://static.nanoka.cc/manifest.json
//     -> { ww: { live: "3.5", latest: "3.5", available: [...], new: {...} }, ... }
//   https://static.nanoka.cc/ww/{version}/character.json
//     -> { "1610": { icon, background, rank, weapon, element, en, ko, zh, ja, nickname, desc }, ... }
//   https://static.nanoka.cc/ww/{version}/weapon.json
//     -> { "21010011": { icon, rank, type, en, ko, zh, ja, atk, sub, desc }, ... }
//
// Unlike NTE (matched by English display name — see nte's nanoka.js), WuWa
// entries are matched by their `zh` field: Kuro's own live gacha calendar
// (kuroApi.js) only ever gives us the Chinese banner/character name, so
// resolving to English goes zh -> en via nanoka's own roster instead of
// trying to bridge Kuro's wiki entryId scheme against nanoka's numeric id
// scheme (confirmed these two ID spaces don't correspond to each other —
// e.g. Kuro's entryId for Yangyang's "Xuanling" variant is
// 1519669180526559232, nanoka's own id for the same character is 1610).
//
// Icon URL transform (confirmed against a real captured request, NOT
// guessed/brute-forced): the `icon` field is a raw Unreal asset reference
// like "/Game/Aki/UI/UIResources/Common/Image/IconRoleHead256/T_Foo.T_Foo"
// — strip the "/Game/Aki/UI" prefix, drop everything from the last "."
// onward (the duplicated class-name suffix), append ".webp", and prefix
// with the assets base below.

const https = require('https');

const STATIC_BASE = 'https://static.nanoka.cc';
const ASSET_PREFIX = '/Game/Aki/UI';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (wuwa-banner-schedule-bot)' },
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
      headers: { 'User-Agent': 'Mozilla/5.0 (wuwa-banner-schedule-bot)' },
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

async function resolveWwVersion() {
  const manifest = await fetchJson(`${STATIC_BASE}/manifest.json`);
  const ww = manifest.ww || {};
  return ww.live || ww.latest;
}

// Returns { version, charactersByZh: Map<zh, entry>, weaponsByZh: Map<zh, entry> }
// where entry = { key, id, name (en), zh, rarity, iconPath (raw asset ref) }.
async function loadNanokaRoster() {
  const version = await resolveWwVersion();
  const [characterMap, weaponMap] = await Promise.all([
    fetchJson(`${STATIC_BASE}/ww/${version}/character.json`),
    fetchJson(`${STATIC_BASE}/ww/${version}/weapon.json`),
  ]);

  const charactersByZh = new Map();
  for (const [key, entry] of Object.entries(characterMap)) {
    if (!entry.en || !entry.zh) continue;
    charactersByZh.set(entry.zh, {
      key, id: Number(key), name: entry.en, zh: entry.zh,
      rarity: entry.rank, iconPath: entry.icon,
    });
  }

  const weaponsByZh = new Map();
  for (const [key, entry] of Object.entries(weaponMap)) {
    if (!entry.en || !entry.zh) continue;
    weaponsByZh.set(entry.zh, {
      key, id: Number(key), name: entry.en, zh: entry.zh,
      rarity: entry.rank, iconPath: entry.icon,
    });
  }

  return { version, charactersByZh, weaponsByZh };
}

// Converts a raw Unreal asset reference (nanoka's `icon` field) into the
// actual served image URL. See the module comment for how this was derived.
function nanokaImageUrl(iconPath) {
  if (!iconPath) return null;
  const rest = iconPath.startsWith(ASSET_PREFIX) ? iconPath.slice(ASSET_PREFIX.length) : iconPath;
  const base = rest.includes('.') ? rest.slice(0, rest.lastIndexOf('.')) : rest;
  return `${STATIC_BASE}/assets/ww${base}.webp`;
}

module.exports = { loadNanokaRoster, nanokaImageUrl, fetchBuffer, fetchJson };
