// Builds wuwa/banner-schedule-wuwa.json and wuwa/images/*.webp — the WuWa
// equivalent of genshin/hsr/zzz's update-*.js scripts.
//
// Simpler than NTE's build.js: Kuro's own live calendar (kuroApi.js) already
// gives us real dates, real banner art, and who's featured directly — no
// computed-cadence guessing (schedule.js) or third-party scraping
// (gamewith.js) needed. The one thing Kuro's API can't give us is an
// English name (it's Chinese-only, no lang param exists), which is what
// nanoka.js resolves via a zh-field match against its own bulk roster.
//
// IMPORTANT — Kuro's calendar is CURRENT-ONLY. It has no historical/past
// banner query. This script can only ever discover what's live right now;
// older banners must be entered by hand directly in
// wuwa/banner-schedule-wuwa.json (same one-time-manual-backfill precedent
// as genshin/hsr/zzz's own schedules, which were also hand-seeded once
// before this automation took over). The merge logic below is additive and
// never touches/removes existing entries it didn't just fetch, so manually
// added historical entries are always safe across reruns.
//
// Run with: node wuwa/scripts/build.js
// (from the repo root, so the relative output paths below resolve correctly)

const fs = require('fs');
const path = require('path');

const { fetchLiveBannerTabs } = require('./lib/kuroApi');
const { loadNanokaRoster, nanokaImageUrl, fetchBuffer } = require('./lib/nanoka');

const OUT_DIR = path.join(__dirname, '..');
const SCHEDULE_PATH = path.join(OUT_DIR, 'banner-schedule-wuwa.json');
const IMAGES_DIR = path.join(OUT_DIR, 'images');

function loadExistingSchedule() {
  try {
    const raw = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

async function downloadImageIfMissing(filename, url) {
  if (!url) return false;
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const filePath = path.join(IMAGES_DIR, filename);
  if (fs.existsSync(filePath)) return false;
  const buf = await fetchBuffer(url);
  fs.writeFileSync(filePath, buf);
  return true;
}

// Resolves one Kuro calendar tab against nanoka's zh-keyed roster.
// Returns a schedule entry — resolved (featuredId/name set) if the zh name
// matches something in nanoka's roster, or a best-effort unresolved
// placeholder (Chinese name, no id/image) if nanoka hasn't caught up yet
// (e.g. a same-day new release before nanoka's own data updates).
function resolveTab(tab, type, byZh, version) {
  const match = tab.name ? byZh.get(tab.name) : null;
  if (match) {
    return {
      type, version, start: tab.start, end: tab.end,
      name: match.name, featured: [match.name], featuredId: match.id,
    };
  }
  // Not in nanoka's roster yet (brand-new/unreleased), or the entry-detail
  // lookup itself failed — keep the raw Chinese name (or a debug label) so
  // the schedule doesn't silently drop the banner; no featuredId/image
  // until nanoka catches up on a later run.
  return {
    type, version, start: tab.start, end: tab.end,
    name: tab.name || `[unresolved entryId ${tab.entryId}]`, featured: [tab.name].filter(Boolean), featuredId: null,
    unresolved: true,
  };
}

// Kuro's live calendar only ever shows one phase at a time and never labels
// it — so phase numbers are derived after the fact, from chronological order
// of each version's distinct start dates (earliest start = phase 1, next
// distinct start = phase 2, etc). Recomputed on every run so it stays correct
// once a version's second phase actually appears in a later fetch.
function assignPhases(schedule) {
  const startsByVersion = new Map(); // version -> Set<dateOnly>
  for (const e of schedule) {
    if (e.type !== 'character' && e.type !== 'weapon') continue;
    if (!startsByVersion.has(e.version)) startsByVersion.set(e.version, new Set());
    startsByVersion.get(e.version).add(e.start.slice(0, 10));
  }

  const phaseByVersion = new Map(); // version -> Map<dateOnly, phaseNumber>
  for (const [version, dates] of startsByVersion) {
    const sorted = [...dates].sort();
    phaseByVersion.set(version, new Map(sorted.map((d, i) => [d, i + 1])));
  }

  return schedule.map(e => {
    if (e.type !== 'character' && e.type !== 'weapon') return e;
    const phase = phaseByVersion.get(e.version)?.get(e.start.slice(0, 10)) ?? 1;
    return { ...e, phase };
  });
}

function entryKey(entry) {
  // Prefer featuredId when resolved (stable across reruns even if Kuro's
  // banner art/wording shifts); fall back to the raw name for unresolved
  // placeholders so a later run can find and upgrade the same entry once
  // nanoka catches up, instead of creating a duplicate.
  return `${entry.type}|${entry.featuredId ?? entry.name}|${entry.start.slice(0, 10)}`;
}

async function main() {
  console.log('[1/3] Loading nanoka.cc WuWa roster...');
  const { version, charactersByZh, weaponsByZh } = await loadNanokaRoster();
  console.log(`  version=${version} characters=${charactersByZh.size} weapons=${weaponsByZh.size}`);

  console.log('[2/3] Fetching Kuro live gacha calendar...');
  const { characterTabs, weaponTabs } = await fetchLiveBannerTabs();
  console.log(`  character tabs=${characterTabs.length} weapon tabs=${weaponTabs.length}`);

  const fetched = [
    ...characterTabs.map(t => resolveTab(t, 'character', charactersByZh, version)),
    ...weaponTabs.map(t => resolveTab(t, 'weapon', weaponsByZh, version)),
  ];

  for (const e of fetched) {
    if (e.unresolved) console.warn(`  UNRESOLVED: "${e.name}" (${e.type}, ${e.start}) — not found in nanoka's roster yet.`);
  }

  console.log('[3/3] Merging schedule and downloading images...');
  const existing = loadExistingSchedule();
  const merged = new Map(existing.map(e => [entryKey(e), e]));

  let newCount = 0, upgradedCount = 0;
  for (const entry of fetched) {
    const key = entryKey(entry);
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, entry);
      newCount++;
    } else if (prior.unresolved && !entry.unresolved) {
      // A previously-unresolved placeholder just got matched — upgrade it,
      // but don't touch anything the user may have hand-edited otherwise
      // (this only fires when prior.unresolved is still true).
      merged.set(key, entry);
      upgradedCount++;
      console.log(`  Resolved: "${entry.name}" (id ${entry.featuredId})`);
    }
    // Otherwise: keep the existing (already-resolved, or hand-edited) entry
    // as-is — never regress it.
  }

  const finalSchedule = assignPhases([...merged.values()].sort((a, b) =>
    a.start.localeCompare(b.start) || (a.type === b.type ? 0 : a.type === 'character' ? -1 : 1)
  ));
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(finalSchedule, null, 2));
  console.log(`Schedule: ${newCount} new, ${upgradedCount} upgraded (${finalSchedule.length} total).`);

  // Images — nanoka's small character-head/weapon icon (~consistent with
  // NTE's choice: the small avatar art, not a large splash image).
  const allRoster = [...charactersByZh.values(), ...weaponsByZh.values()];
  let downloaded = 0, skipped = 0;
  for (const r of allRoster) {
    const filename = `${r.id}.webp`;
    try {
      const wrote = await downloadImageIfMissing(filename, nanokaImageUrl(r.iconPath));
      if (wrote) downloaded++; else skipped++;
    } catch (e) {
      console.warn(`  image download failed for ${r.id}: ${e.message}`);
    }
  }
  console.log(`Images: ${downloaded} new, ${skipped} already present.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
