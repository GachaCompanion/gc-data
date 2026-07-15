// Orchestrates full framing computation for all characters across all games.
// Runs on GitHub Actions; outputs framing_hsr.json, framing_zzz.json, framing_version.json
// (Live2D) and framing_hsr_png.json, framing_zzz_png.json, framing_version_png.json (PNG)
// to the framing-output/ directory, then publishes them to a GitHub release.
//
// Usage: node framing/compute-framing.js
//
// Environment variables:
//   ASSET_CACHE_DIR     — where to store downloaded spine assets (default: .framing-cache/assets)
//   PNG_ASSET_CACHE_DIR — where to store downloaded character PNGs (default: .framing-cache/png-assets)
//   ONNX_MODEL_PATH     — path to yolov8_animeface.onnx (default: .framing-cache/yolov8_animeface.onnx)
//   OUTPUT_DIR          — where to write framing_*.json (default: framing-output)

'use strict';

const fs   = require('fs');
const path = require('path');

const { downloadCharAssets, listManifestIds, downloadPngAsset, listAllAvatarIds } = require('./downloader');
const { computeFraming } = require('./live2dFraming');
const { getAnimatedBounds, detectFaceOnImage } = require('./live2dFaceDetect');
const releasedIds = require('./releasedIds');

const ASSET_DIR     = path.resolve(process.env.ASSET_CACHE_DIR     ?? path.join(__dirname, '..', '.framing-cache', 'assets'));
const PNG_ASSET_DIR = path.resolve(process.env.PNG_ASSET_CACHE_DIR ?? path.join(__dirname, '..', '.framing-cache', 'png-assets'));
const ONNX_PATH     = path.resolve(process.env.ONNX_MODEL_PATH ?? path.join(__dirname, '..', '.framing-cache', 'yolov8_animeface.onnx'));
const OUTPUT_DIR    = path.resolve(process.env.OUTPUT_DIR      ?? path.join(__dirname, '..', 'framing-output'));

const GAMES     = ['hsr', 'zzz']; // Live2D — both games
const PNG_GAMES = ['hsr'];        // PNG — HSR only; ZZZ has its own separate, working approach

function loadExisting(game) {
  const file = path.join(OUTPUT_DIR, `framing_${game}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: parsed.version ?? 0, data: parsed.data ?? parsed };
  } catch {
    return { version: 0, data: {} };
  }
}

function saveOutput(game, version, data) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `framing_${game}.json`),
    JSON.stringify({ version, generated: new Date().toISOString(), data }, null, 2),
  );
}

async function processGame(game) {
  console.log(`\n=== ${game.toUpperCase()} ===`);
  const existing = loadExisting(game);
  const ids = await listManifestIds(game);
  console.log(`  ${ids.length} characters in manifest`);

  const data    = { ...existing.data };
  let   changed = false;

  for (const id of ids) {
    const existing  = data[id];
    const hasAnchor = !!existing && existing.cx !== undefined;
    const hasBounds = !!existing && existing.topY !== undefined && existing.bottomY !== undefined;

    if (hasAnchor && hasBounds) {
      console.log(`  [${id}] cached — skip`);
      continue;
    }

    process.stdout.write(`  [${id}] downloading assets…`);
    const dl = await downloadCharAssets(ASSET_DIR, game, id).catch((e) => ({ ok: false, error: e.message }));
    if (!dl.ok) {
      process.stdout.write(` skip (${dl.reason ?? dl.error})\n`);
      continue;
    }

    if (!hasAnchor) {
      // No cached anchor (new character, or never computed) — full compute, gets both anchor + bounds.
      process.stdout.write(` computing framing…`);
      const result = await computeFraming(dl.dir, dl.bases, id, ONNX_PATH, game).catch((e) => {
        process.stdout.write(` ERROR: ${e.message}\n`);
        return null;
      });
      if (!result) continue;
      data[id] = result;
      changed = true;
      process.stdout.write(` done (cx=${result.cx.toFixed(0)}, cy=${result.cy.toFixed(0)})\n`);
      continue;
    }

    // Anchor already cached, just missing the bounds — backfill only that (cheap:
    // skeleton pose + getBounds, no atlas/skin scan, no face-detect render/inference).
    process.stdout.write(` backfilling bounds…`);
    const bounds = await getAnimatedBounds(dl.dir, dl.bases).catch((e) => {
      process.stdout.write(` ERROR: ${e.message}\n`);
      return null;
    });
    if (!bounds) continue;
    data[id] = { ...existing, ...bounds };
    changed = true;
    process.stdout.write(` done (topY=${bounds.topY.toFixed(0)}, bottomY=${bounds.bottomY.toFixed(0)})\n`);
  }

  const version = changed ? existing.version + 1 : existing.version;
  saveOutput(game, version, data);
  console.log(`  ${game}: version=${version}, entries=${Object.keys(data).length}, changed=${changed}`);
  return { version, changed };
}

// ── PNG framing (separate from the Live2D pipeline above) ─────────────────────
// No posing/rendering step — the downloaded image already IS the final frame,
// so this is just download → detect → done. Covers every character in Enka's
// roster (listAllAvatarIds), not just the ones with a Live2D rig, since PNG
// mode works for all of them.

function loadExistingPng(game) {
  const file = path.join(OUTPUT_DIR, `framing_${game}_png.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: parsed.version ?? 0, data: parsed.data ?? parsed };
  } catch {
    return { version: 0, data: {} };
  }
}

function saveOutputPng(game, version, data) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `framing_${game}_png.json`),
    JSON.stringify({ version, generated: new Date().toISOString(), data }, null, 2),
  );
}

async function processGamePng(game) {
  console.log(`\n=== ${game.toUpperCase()} (PNG) ===`);
  const existing = loadExistingPng(game);
  const ids = await listAllAvatarIds(game);
  console.log(`  ${ids.length} characters in roster`);

  const data    = { ...existing.data };
  let   changed = false;

  for (const id of ids) {
    if (data[id] && data[id].cxFrac !== undefined) {
      console.log(`  [${id}] cached — skip`);
      continue;
    }

    process.stdout.write(`  [${id}] downloading PNG…`);
    const dl = await downloadPngAsset(PNG_ASSET_DIR, game, id).catch((e) => ({ ok: false, error: e.message }));
    if (!dl.ok) {
      process.stdout.write(` skip (${dl.reason ?? dl.error})\n`);
      continue;
    }

    process.stdout.write(` detecting face…`);
    const boxes = await detectFaceOnImage(fs.readFileSync(dl.path), ONNX_PATH).catch((e) => {
      process.stdout.write(` ERROR: ${e.message}\n`);
      return null;
    });
    if (!boxes || !boxes.length) {
      process.stdout.write(` no face found\n`);
      continue;
    }

    const best = boxes[0];
    data[id] = { cxFrac: best.cxFrac, cyFrac: best.cyFrac, hFrac: best.hFrac };
    changed = true;
    process.stdout.write(` done (cx=${best.cxFrac.toFixed(3)}, cy=${best.cyFrac.toFixed(3)})\n`);
  }

  const version = changed ? existing.version + 1 : existing.version;
  saveOutputPng(game, version, data);
  console.log(`  ${game} (png): version=${version}, entries=${Object.keys(data).length}, changed=${changed}`);
  return { version, changed };
}

async function main() {
  fs.mkdirSync(ASSET_DIR,     { recursive: true });
  fs.mkdirSync(PNG_ASSET_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR,    { recursive: true });

  if (!fs.existsSync(ONNX_PATH)) {
    console.error(`ONNX model not found at ${ONNX_PATH}. Set ONNX_MODEL_PATH or ensure the cache step ran.`);
    process.exit(1);
  }

  // Load the released-IDs whitelist (HoYoverse's own banner schedule) before any
  // nanoka download — gates downloadCharAssets/downloadPngAsset in downloader.js.
  await releasedIds.init(GAMES);

  const results = {};
  for (const game of GAMES) {
    results[game] = await processGame(game);
  }

  // Per-game versions, independent of each other — framingSync checks each
  // game's own field only, so one game's version can never mask the other's.
  const versions = Object.fromEntries(GAMES.map((game) => [game, results[game].version]));
  const versionFile = path.join(OUTPUT_DIR, 'framing_version.json');
  fs.writeFileSync(versionFile, JSON.stringify({ ...versions, generated: new Date().toISOString() }, null, 2));
  console.log(`\nDone. Live2D versions: ${JSON.stringify(versions)}`);

  const pngResults = {};
  for (const game of PNG_GAMES) {
    pngResults[game] = await processGamePng(game);
  }
  const pngVersions = Object.fromEntries(PNG_GAMES.map((game) => [game, pngResults[game].version]));
  const pngVersionFile = path.join(OUTPUT_DIR, 'framing_version_png.json');
  fs.writeFileSync(pngVersionFile, JSON.stringify({ ...pngVersions, generated: new Date().toISOString() }, null, 2));
  console.log(`Done. PNG versions: ${JSON.stringify(pngVersions)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
