// Builds nte/banner-schedule-nte.json and nte/images/*.webp — the NTE
// equivalent of the other 3 games' bannerFetch.js output, but computed +
// confirmed instead of pulled from the Hoyoverse API (NTE has none).
//
// Pipeline:
//   1. Compute phase time windows from the fixed 21-day cadence (schedule.js).
//   2. Scrape gamewith.net for which character/arc is actually featured in
//      the phases it has announced (gamewith.js) — this is the only source
//      for WHO, never for WHEN.
//   3. Resolve each confirmed name against nanoka.cc's character/weapon
//      roster (nanoka.js) to get a stable numeric/key id, rarity, and an
//      image URL, then download the image if not already cached.
//   4. Merge into the existing banner-schedule-nte.json by (type, start) —
//      never regress an already-resolved entry back to a placeholder, and
//      never write more than one entry per (type, start).
//
// Run with: node nte/scripts/build.js
// (from the repo root, so the relative output paths below resolve correctly)

const fs = require('fs');
const path = require('path');

const { computePhaseWindows } = require('./lib/schedule');
const { scrapeGamewithBanners } = require('./lib/gamewith');
const { loadNanokaRoster, nanokaImageUrl, fetchBuffer } = require('./lib/nanoka');
const { knownHistoryEntries } = require('./lib/knownHistory');

const OUT_DIR = path.join(__dirname, '..');
const SCHEDULE_PATH = path.join(OUT_DIR, 'banner-schedule-nte.json');
const IMAGES_DIR = path.join(OUT_DIR, 'images');
const ROSTER_IMAGES_PATH = path.join(OUT_DIR, 'roster-images.json');

function entryKey(entry) { return `${entry.type}|${entry.start}`; }

function loadExistingSchedule() {
  try {
    const raw = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

async function downloadImageIfMissing(filename, url) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const filePath = path.join(IMAGES_DIR, filename);
  if (fs.existsSync(filePath)) return false;
  const buf = await fetchBuffer(url);
  fs.writeFileSync(filePath, buf);
  return true;
}

async function main() {
  console.log('[1/4] Loading nanoka.cc character/arc roster...');
  const { version, charactersByName, arcsByName } = await loadNanokaRoster();
  console.log(`  version=${version} characters=${charactersByName.size} arcs=${arcsByName.size}`);

  console.log('[2/4] Computing phase windows...');
  // Only the 1.2+ cadence is computed (phasesBack: 0 — the anchor IS 1.2
  // Phase 1). Everything before that (1.0/1.1, both irregular — see
  // knownHistory.js) is hardcoded, not computed. phasesForward: 0 —
  // no next-phase placeholder. The workflow runs 3x around every real
  // boundary (Wed 06:00, Wed 08:00, Thu 06:00 UTC+8), so the phase gets
  // picked up for real within hours of going live; there's no need to
  // pre-populate a dates-only placeholder for it ahead of time.
  const windows = computePhaseWindows({ phasesBack: 0, phasesForward: 0 });
  console.log(`  ${windows.length} phase windows computed`);

  console.log('[3/4] Scraping gamewith.net for confirmed phase content...');
  let scraped = [];
  try {
    scraped = await scrapeGamewithBanners(charactersByName.keys(), arcsByName.keys());
    console.log(`  ${scraped.length} confirmed entries scraped`);
  } catch (e) {
    console.warn(`  gamewith.net scrape failed, continuing with placeholders only: ${e.message}`);
  }

  const scrapedByStart = new Map(); // start -> { character?, arc? }
  for (const s of scraped) {
    if (!scrapedByStart.has(s.start)) scrapedByStart.set(s.start, {});
    scrapedByStart.get(s.start)[s.kind] = s;
  }

  console.log('[4/4] Resolving IDs/images and merging schedule...');
  const existing = loadExistingSchedule();
  const merged = new Map(existing.map(e => [entryKey(e), e]));
  const newImageDownloads = [];

  // Hardcoded 1.0/1.1 history — always present, never recomputed. Set
  // unconditionally (not "only if missing") since this is a fixed constant
  // table, not something a later run could have better data for.
  for (const entry of knownHistoryEntries()) {
    merged.set(entryKey(entry), entry);
    const roster = entry.type === 'character' ? charactersByName : arcsByName;
    newImageDownloads.push({ id: entry.featuredId, iconPath: roster.get(entry.name)?.iconPath });
  }

  for (const win of windows) {
    const confirmed = scrapedByStart.get(win.start) || {};

    // Character slot
    {
      const key = `character|${win.start}`;
      const prior = merged.get(key);
      const scrapedChar = confirmed.character;
      let entry;
      if (scrapedChar && !scrapedChar.unresolved && charactersByName.has(scrapedChar.name)) {
        const c = charactersByName.get(scrapedChar.name);
        entry = {
          type: 'character', version: win.version, start: win.start, end: scrapedChar.end ?? win.end,
          name: c.name, featured: [c.name], featuredId: c.id, phase: win.phase,
        };
        newImageDownloads.push({ id: c.id, iconPath: c.iconPath });
      } else if (scrapedChar) {
        // Name scraped but not yet in nanoka's roster (unreleased) — keep
        // the best-effort name, no id/image until nanoka catches up.
        entry = {
          type: 'character', version: win.version, start: win.start, end: scrapedChar.end ?? win.end,
          name: scrapedChar.name, featured: [scrapedChar.name], featuredId: null, phase: win.phase,
          unresolved: true,
        };
      } else if (prior && prior.name) {
        entry = prior; // keep previously-resolved data, don't regress to a placeholder
      } else {
        entry = { type: 'character', version: win.version, start: win.start, end: win.end, name: null, featured: [], featuredId: null, phase: win.phase };
      }
      merged.set(key, entry);
    }

    // Arc slot
    {
      const key = `arc|${win.start}`;
      const prior = merged.get(key);
      const scrapedArc = confirmed.arc;
      let entry;
      if (scrapedArc && arcsByName.has(scrapedArc.name)) {
        const a = arcsByName.get(scrapedArc.name);
        entry = {
          type: 'arc', version: win.version, start: win.start, end: scrapedArc.end ?? win.end,
          name: a.name, featured: [a.name], featuredId: a.key, phase: win.phase,
        };
        newImageDownloads.push({ id: a.key, iconPath: a.iconPath });
      } else if (prior && prior.name) {
        entry = prior;
      } else {
        entry = { type: 'arc', version: win.version, start: win.start, end: win.end, name: null, featured: [], featuredId: null, phase: win.phase };
      }
      merged.set(key, entry);
    }
  }

  // Full roster backfill — GI/HSR/ZZZ needed enka.network as a second source
  // because Hoyolab's own API only ever returns recent/current banner data.
  // NTE doesn't have that problem: nanoka's bulk character.json/weapon.json
  // (already loaded above) already contains every character and arc, not
  // just ones tied to a real banner phase. So instead of only downloading
  // images for schedule-linked entries, download the entire roster —
  // downloadImageIfMissing already no-ops on anything already on disk, so
  // this is cheap on every rerun after the first.
  for (const c of charactersByName.values()) newImageDownloads.push({ id: c.id, iconPath: c.iconPath });
  for (const a of arcsByName.values()) newImageDownloads.push({ id: a.key, iconPath: a.iconPath });

  // Images — the small icon (~30KB avatar/weapon art, already on the bulk
  // character.json/weapon.json roster entries) is what this app uses for
  // banner display. Deliberately NOT icon_gacha (the ~300KB splash art) —
  // that's reserved for a future showcase feature, not the banner panel.
  const seenIds = new Set();
  let downloadedCount = 0;
  for (const job of newImageDownloads) {
    if (!job.iconPath || seenIds.has(job.id)) continue;
    seenIds.add(job.id);
    try {
      const filename = `${job.id}.webp`;
      const wrote = await downloadImageIfMissing(filename, nanokaImageUrl(job.iconPath));
      if (wrote) downloadedCount++;
    } catch (e) {
      console.warn(`  image download failed for ${job.id}: ${e.message}`);
    }
  }
  console.log(`  downloaded ${downloadedCount} new image(s)`);

  // 'character' before 'arc' within the same phase — not alphabetical
  // (localeCompare would put 'arc' first), matches the order the app cares
  // about (character is the primary pull, arc is the accompanying one).
  const TYPE_ORDER = { character: 0, arc: 1 };
  const finalSchedule = [...merged.values()].sort((a, b) => a.start.localeCompare(b.start) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(finalSchedule, null, 2));
  console.log(`Wrote ${finalSchedule.length} entries to ${SCHEDULE_PATH}`);

  // Full roster id manifest — lets the app preload every character/arc image
  // (not just schedule-tied ones) during the loading screen, the same way
  // GI/HSR/ZZZ bulk-preload their full character/Live2D libraries, without
  // needing to re-fetch/re-derive nanoka's roster client-side itself.
  const rosterImageIds = [
    ...[...charactersByName.values()].map(c => c.id),
    ...[...arcsByName.values()].map(a => a.key),
  ];
  fs.writeFileSync(ROSTER_IMAGES_PATH, JSON.stringify(rosterImageIds, null, 2));
  console.log(`Wrote ${rosterImageIds.length} ids to ${ROSTER_IMAGES_PATH}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
