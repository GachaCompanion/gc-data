'use strict';

// Downloads Spine assets (skel + atlas + textures) for a character from nanoka's CDN.
// Extracted from the main app's electron/live2d.js — kept in sync manually.

const fs   = require('fs');
const path = require('path');
const releasedIds = require('./releasedIds');

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

const RECIPES = {
  hsr: {
    manifest:    'https://static.nanoka.cc/assets/hsr/spine/manifest.json',
    base:        'https://static.nanoka.cc/assets/hsr/spine',
    headers:     { Referer: 'https://hsr.nanoka.cc/', Origin: 'https://hsr.nanoka.cc' },
  },
  zzz: {
    characterUrl: (id) => `https://static.nanoka.cc/zzz/3.1.3+17077339/en/character/${id}.json`,
    base:         'https://static.nanoka.cc/assets/zzz/live2d',
    flat:         true,
    headers:      { Referer: 'https://zzz.nanoka.cc/', Origin: 'https://zzz.nanoka.cc' },
  },
};

// PNG character art — HSR only. ZZZ has its own separate, already-working PNG
// framing approach and doesn't go through this pipeline. Kept in sync manually
// with electron/charImages.js's NANOKA_URL_BY_GAME in the main app.
const PNG_RECIPES = {
  hsr: { url: (id) => `https://static.nanoka.cc/assets/hsr/avatardrawcard/${id}.webp`, headers: RECIPES.hsr.headers },
};

// Enka's own avatars.json — the full character roster for a game, independent
// of whether nanoka has a Live2D rig for them. PNG framing should cover every
// character (PNG mode works for all of them), not just the Live2D subset
// RECIPES.manifest/characterUrl above are scoped to.
const ENKA_STORE_BASE = 'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store';
async function listAllAvatarIds(game) {
  const res = await fetch(`${ENKA_STORE_BASE}/${game}/avatars.json`);
  if (!res.ok) return [];
  return Object.keys(await res.json());
}

const _manifests    = {};
const _zzzSpineNames = {};

function hdrs(recipe) {
  return { ...BASE_HEADERS, ...(recipe.headers ?? {}) };
}

async function fetchBuffer(url, recipe) {
  const res = await fetch(url, { headers: hdrs(recipe) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getManifest(game) {
  if (_manifests[game]) return _manifests[game];
  const recipe = RECIPES[game];
  const res = await fetch(recipe.manifest, { headers: hdrs(recipe) });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  _manifests[game] = await res.json();
  return _manifests[game];
}

async function resolveZzzSpineName(id, recipe) {
  if (_zzzSpineNames[id] !== undefined) return _zzzSpineNames[id];
  const res = await fetch(recipe.characterUrl(id), { headers: hdrs(recipe) });
  if (!res.ok) { _zzzSpineNames[id] = null; return null; }
  const data = await res.json();
  _zzzSpineNames[id] = data.live2_d || null;
  return _zzzSpineNames[id];
}

function texturesFromAtlas(atlasText) {
  const out = [];
  for (const raw of atlasText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.includes(':')) continue;
    if (/\.(webp|png|jpg|jpeg)$/i.test(line)) out.push(line);
  }
  return [...new Set(out)];
}

async function resolveTexture(baseUrl, claimed, recipe) {
  const stem = claimed.replace(/\.[^.]+$/, '');
  for (const name of [...new Set([claimed, `${stem}.webp`, `${stem}.png`, `${stem}.jpg`])]) {
    const res = await fetch(`${baseUrl}/${name}`, { method: 'HEAD', headers: hdrs(recipe) });
    if (res.ok) return name;
  }
  return null;
}

// Downloads all spine assets for a character to <root>/<game>/<id>/.
// Returns { ok, dir, bases } or { ok: false, reason, error }.
async function downloadCharAssets(root, game, characterId) {
  const recipe = RECIPES[game];
  if (!recipe) return { ok: false, error: `no recipe for game "${game}"` };

  const id  = String(characterId);
  const dir = path.join(root, game, id);

  // nanoka sometimes lists datamined characters before HoYoverse ships them —
  // only download for IDs confirmed released via the official banner schedule,
  // unless this character was already cached before the whitelist existed.
  if (!releasedIds.isReleased(game, id) && !fs.existsSync(dir)) {
    return { ok: false, reason: 'unreleased' };
  }

  let bases;
  try {
    if (recipe.characterUrl) {
      const spineName = await resolveZzzSpineName(id, recipe);
      if (!spineName) return { ok: false, reason: 'none' };
      bases = [spineName];
    } else {
      const manifest = await getManifest(game);
      const entry = manifest[id];
      if (!entry) return { ok: false, reason: 'none' };
      bases = String(entry).split('|').map(s => s.trim()).filter(Boolean);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const cdnDir = recipe.flat ? recipe.base : `${recipe.base}/${id}`;

  try {
    for (const base of bases) {
      const skelName  = `${base}.skel`;
      const atlasName = `${base}.atlas`;
      const skelDest  = path.join(dir, skelName);
      const atlasDest = path.join(dir, atlasName);

      if (fs.existsSync(skelDest) && fs.existsSync(atlasDest)) continue;

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(skelDest, await fetchBuffer(`${cdnDir}/${skelName}`, recipe));

      let atlasText = (await fetchBuffer(`${cdnDir}/${atlasName}`, recipe)).toString('utf8');
      for (const claimed of texturesFromAtlas(atlasText)) {
        const real = await resolveTexture(cdnDir, claimed, recipe);
        if (!real) throw new Error(`texture "${claimed}" not found for ${id}/${base}`);
        if (real !== claimed) atlasText = atlasText.split(claimed).join(real);
        const texDest = path.join(dir, real);
        if (!fs.existsSync(texDest)) fs.writeFileSync(texDest, await fetchBuffer(`${cdnDir}/${real}`, recipe));
      }
      fs.writeFileSync(atlasDest, atlasText);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  return { ok: true, dir, bases };
}

// Returns all character IDs for a game from the nanoka manifest.
const _zzzCharacterIds = [];
async function listManifestIds(game) {
  const recipe = RECIPES[game];
  if (!recipe) return [];
  if (recipe.characterUrl) {
    if (_zzzCharacterIds.length) return [..._zzzCharacterIds];
    const res = await fetch('https://static.nanoka.cc/zzz/3.1.3+17077339/character.json', { headers: hdrs(recipe) });
    if (!res.ok) return [];
    const data = await res.json();
    const ids = Object.entries(data)
      .filter(([, c]) => c.rank === 4)
      .map(([id]) => id);
    _zzzCharacterIds.push(...ids);
    return ids;
  }
  const manifest = await getManifest(game);
  return Object.keys(manifest);
}

// Downloads a character's PNG art to <root>/<game>/<id>.webp for face detection.
// Returns { ok, path } or { ok: false, reason/error }.
async function downloadPngAsset(root, game, characterId) {
  const recipe = PNG_RECIPES[game];
  if (!recipe) return { ok: false, error: `no PNG recipe for game "${game}"` };

  const id   = String(characterId);
  const dir  = path.join(root, game);
  const dest = path.join(dir, `${id}.webp`);

  if (fs.existsSync(dest)) return { ok: true, path: dest };

  // Same released-only gate as downloadCharAssets — nanoka's avatardrawcard art
  // can exist before HoYoverse ships the character, even though the ID list
  // itself here comes from Enka's roster.
  if (!releasedIds.isReleased(game, id)) return { ok: false, reason: 'unreleased' };

  fs.mkdirSync(dir, { recursive: true });
  try {
    const buffer = await fetchBuffer(recipe.url(id), recipe);
    fs.writeFileSync(dest, buffer);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, path: dest };
}

module.exports = { downloadCharAssets, listManifestIds, downloadPngAsset, listAllAvatarIds };
