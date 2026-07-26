#!/usr/bin/env node
// Fills in character/weapon images that the official-API-driven updaters
// (update-genshin.js/update-hsr.js/update-zzz.js) and the scraped-schedule
// builds (games/wuwa/scripts/build.js, games/nte/scripts/build.js) never
// cover — those are all limited to whatever's actually been featured on a
// banner (5-star rate-ups only), since that's all their own sources ever
// expose. nanoka.cc's full roster covers every rarity for all 5 games,
// keyed by the exact same numeric/string IDs already used throughout this
// repo (confirmed: NTE's rewardKey 1021 = "Edgar", matches nanoka.cc's own
// "1021" key exactly; Genshin's 10000023 = "Xiangling" matches genshin-db's
// id too).
//
// This script only ever fills GAPS — an image the API pipeline already
// saved is never touched or overwritten (API has priority, this is
// fill-only, same convention as update-genshin.js's fs.existsSync guard).
//
// Always reads nanoka's "live" version (manifest.json's `live` field —
// e.g. "6.7" for Genshin, not "latest" which can be "6.7.54" and include
// unreleased/datamined content ahead of the actual patch). This is what
// actually resolves the unreleased-content concern: at the "live" version,
// the data snapshot itself cannot contain anything not yet released,
// there's no separate filtering step needed.
//
// Run with: node scripts/updaters/update-nanoka-images.js
// (from the repo root, so the relative output paths below resolve correctly)

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const STATIC_BASE = 'https://static.nanoka.cc';

// slug: nanoka.cc's own game code (used in its URLs).
// dir: this repo's games/<dir> folder name.
// ext: the file extension the app's existing IPC handlers expect for this
// game's cached images (electron/main.js's get<Game>BannerImage handlers)
// — must match exactly even though nanoka always serves .webp bytes; the
// app sniffs actual image bytes rather than trusting the extension (see
// detectImageMime in electron/main.js), so saving webp bytes under a .png
// filename is safe and serves correctly.
const GAMES = [
  { slug: 'gi',  dir: 'genshin', ext: 'png',  weaponFile: 'weapon.json' },
  { slug: 'hsr', dir: 'hsr',     ext: 'png',  weaponFile: 'lightcone.json' },
  { slug: 'zzz', dir: 'zzz',     ext: 'png',  weaponFile: 'weapon.json' },
  { slug: 'ww',  dir: 'wuwa',    ext: 'webp', weaponFile: 'weapon.json' },
  { slug: 'nte', dir: 'nte',     ext: 'webp', weaponFile: 'weapon.json' },
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (gc-data-nanoka-bot)' },
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
      headers: { 'User-Agent': 'Mozilla/5.0 (gc-data-nanoka-bot)' },
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// nanoka's icon paths aren't consistently formatted across games — some
// entries already start with '/' (e.g. NTE's "/Game/UI/...") and some don't
// (e.g. Genshin's "UI_AvatarIcon_Ayaka") — normalize by stripping any
// leading slash before joining, rather than assuming either format holds
// for every game.
function nanokaImageUrl(slug, iconPath) {
  return `${STATIC_BASE}/assets/${slug}/${iconPath.replace(/^\//, '')}.webp`;
}

async function resolveVersion(slug) {
  const manifest = await fetchJson(`${STATIC_BASE}/manifest.json`);
  const entry = manifest[slug] || {};
  const version = entry.live || entry.latest;
  if (!version) throw new Error(`No version found for slug "${slug}" in manifest.json`);
  return version;
}

async function processGame({ slug, dir, ext, weaponFile }) {
  console.log(`\n[${dir}] Resolving nanoka.cc version...`);
  const version = await resolveVersion(slug);
  console.log(`[${dir}] Using version ${version} (live)`);

  const [characters, weapons] = await Promise.all([
    fetchJson(`${STATIC_BASE}/${slug}/${version}/character.json`),
    fetchJson(`${STATIC_BASE}/${slug}/${version}/${weaponFile}`).catch(() => ({})),
  ]);

  const imagesDir = path.join(__dirname, '..', '..', 'games', dir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  let saved = 0, skipped = 0, failed = 0;
  for (const [key, entry] of [...Object.entries(characters), ...Object.entries(weapons)]) {
    if (!entry.icon) continue;
    const dest = path.join(imagesDir, `${key}.${ext}`);
    // API-driven pipelines (or an earlier run of this script) have
    // priority — never overwrite an image that's already there.
    if (fs.existsSync(dest)) { skipped++; continue; }
    try {
      const buf = await fetchBuffer(nanokaImageUrl(slug, entry.icon));
      fs.writeFileSync(dest, buf);
      saved++;
    } catch (e) {
      failed++;
      console.warn(`[${dir}]   Image failed for ${key}: ${e.message}`);
    }
    await sleep(200);
  }
  console.log(`[${dir}] Images: ${saved} new, ${skipped} already present, ${failed} failed.`);
}

async function main() {
  for (const game of GAMES) {
    try {
      await processGame(game);
    } catch (e) {
      console.error(`[${game.dir}] Failed: ${e.message}`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
