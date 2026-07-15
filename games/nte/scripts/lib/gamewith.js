// Scrapes gamewith.net's NTE banner schedule page for the CURRENT banner
// ONLY (deliberately excludes "Upcoming Gacha Banners" — the user wants a
// phase's character/arc to appear in the schedule only once it's actually
// live, not as soon as it's announced/upcoming, even though gamewith prints
// upcoming names too). This is a confirmation/enrichment source, not the
// source of truth for timing (see schedule.js for the computed 21-day
// cadence) — gamewith only ever tells us the one thing the cadence math
// can't: which character and which arc are actually featured in the phase
// that's live right now.
//
// The page (https://gamewith.net/nte/74204) renders its whole article body
// from a single flat string embedded in a <script type="application/ld+json">
// tag's "articleBody" field — no per-banner DOM elements to select. The text
// has a stable repeating shape per banner:
//   "<BannerFlavorName>[Recommendation]<stars>[Duration]<dateRange>[Pickup Target]<pickupText>"
// with NO delimiter between one banner's pickupText and the next banner's
// flavor name — they're directly concatenated. We don't need the flavor name
// (the app's schema stores the character/arc's own real name, not the
// marketing name like "Before the Dawn"), so this is handled by matching the
// START of each tail against a known roster (character/arc names from
// nanoka) rather than trying to find where one field ends and the next
// begins in general.

const https = require('https');

const PAGE_URL = 'https://gamewith.net/nte/74204';

// Bounds to ONLY the "Current Gacha Schedule" block — stops at "Upcoming
// Gacha Banners" (that heading is the actual boundary the page itself draws
// between live and announced-but-not-live banners) rather than reading all
// the way to "Which Gacha Should You Pull?", which would also pull in
// Upcoming's entries.
const SECTION_START_MARKER = 'Current Gacha Schedule';
const SECTION_END_MARKER = 'Upcoming Gacha Banners';

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (nte-banner-schedule-bot)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timed out: ${url}`)); });
  });
}

function extractArticleBody(html) {
  const scripts = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  for (const m of scripts) {
    try {
      const json = JSON.parse(m[1]);
      if (json && typeof json.articleBody === 'string' && json.articleBody.includes('[Pickup Target]')) {
        return json.articleBody;
      }
    } catch (_) { /* not the right script block, keep looking */ }
  }
  throw new Error('Could not find articleBody with banner data in gamewith.net page.');
}

// "Jul 8, 2026" / "July 29" (no year) / "August 19, 2026" -> { y, m, d } (y may be null)
function parseDatePart(text) {
  const m = text.trim().match(/^([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  return { y: m[3] ? Number(m[3]) : null, m: month, d: Number(m[2]) };
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Renders a UTC+8 wall-clock instant as a naive "YYYY-MM-DD HH:MM:SS" string
// (no timezone suffix), matching the other 3 games' stored schedule format.
function wallClockString(y, m, d, hh, mm) {
  return `${y}-${pad2(m + 1)}-${pad2(d)} ${pad2(hh)}:${pad2(mm)}:00`;
}

// Confirmed rule (see project notes): every phase boundary is 06:00 UTC+8
// start, 05:59 UTC+8 end, regardless of whether gamewith prints a time.
function parseDurationText(durationText) {
  const cleaned = durationText.replace(/\s*\(UTC\+8\)\s*$/i, '').trim();
  if (/always available/i.test(cleaned)) return { start: null, end: null, standard: true };

  const dashSplit = cleaned.split(/\s*-\s*/);
  if (dashSplit.length === 1) {
    // Single date, no range yet announced (e.g. "August 19, 2026") — open start, no end.
    const only = parseDatePart(cleaned);
    if (!only || only.y == null) return null;
    return { start: wallClockString(only.y, only.m, only.d, 6, 0), end: null };
  }

  const [leftRaw, rightRaw] = dashSplit;
  // Right side carries the explicit time (if any) and always carries the year.
  const timeMatch = rightRaw.match(/(\d{1,2}):(\d{2})\s*$/);
  const rightDateText = timeMatch ? rightRaw.slice(0, timeMatch.index).trim() : rightRaw.trim();
  const right = parseDatePart(rightDateText);
  if (!right || right.y == null) return null;

  let left = parseDatePart(leftRaw);
  if (!left) return null;
  if (left.y == null) left.y = right.y; // "July 29 - August 19, 2026" — left inherits right's year

  const endHH = timeMatch ? Number(timeMatch[1]) : 5;
  const endMM = timeMatch ? Number(timeMatch[2]) : 59;

  return {
    start: wallClockString(left.y, left.m, left.d, 6, 0),
    end: wallClockString(right.y, right.m, right.d, endHH, endMM),
  };
}

// Matches the start of `tail` against a known-name roster (longest match
// wins), optionally preceded by an "S-Rank Character "/"A-Rank Character "
// prefix. Returns { name, rest } or null if nothing in the roster matches —
// callers use `rest` only for debugging/logging, never to guess a name.
function matchKnownName(tail, knownNames) {
  const prefixMatch = tail.match(/^(?:S-Rank|A-Rank)\s+Character\s+/);
  const searchFrom = prefixMatch ? tail.slice(prefixMatch[0].length) : tail;

  let best = null;
  for (const name of knownNames) {
    if (searchFrom.startsWith(name) && (!best || name.length > best.length)) best = name;
  }
  if (!best) return null;
  return { name: best, rest: searchFrom.slice(best.length) };
}

/**
 * Scrapes gamewith.net's NTE banner page.
 * @param {Iterable<string>} knownCharacterNames
 * @param {Iterable<string>} knownArcNames
 * @returns {Promise<Array<{ kind: 'character'|'arc', name: string, start: string, end: string|null }>>}
 */
async function scrapeGamewithBanners(knownCharacterNames, knownArcNames) {
  // Materialize to arrays — matchKnownName is called once per banner block,
  // and a single-use iterator (e.g. Map.keys()) would be exhausted after the
  // first call, silently breaking every subsequent lookup.
  knownCharacterNames = Array.from(knownCharacterNames);
  knownArcNames = Array.from(knownArcNames);

  const html = await fetchHtml(PAGE_URL);
  const articleBody = extractArticleBody(html);

  const startIdx = articleBody.indexOf(SECTION_START_MARKER);
  const endIdx = articleBody.indexOf(SECTION_END_MARKER, startIdx + 1);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('gamewith.net page structure changed — banner-list section markers not found.');
  }
  const section = articleBody.slice(startIdx, endIdx);

  const blocks = section.split(/(?=\[Recommendation)/).slice(1);
  const results = [];

  for (const block of blocks) {
    const m = block.match(/^\[Recommendation(?: Level)?\][★☆]+\[Duration\]([^[]+)\[Pickup Target\]([\s\S]*)$/);
    if (!m) continue;
    const [, durationText, tail] = m;

    if (/^\s*None\b/.test(tail)) continue; // standard/evergreen banner, not phase-specific

    const range = parseDurationText(durationText);
    if (!range || range.standard) continue;

    const charMatch = matchKnownName(tail.trim(), knownCharacterNames);
    if (charMatch) {
      results.push({ kind: 'character', name: charMatch.name, start: range.start, end: range.end });
      continue;
    }
    const arcMatch = matchKnownName(tail.trim(), knownArcNames);
    if (arcMatch) {
      results.push({ kind: 'arc', name: arcMatch.name, start: range.start, end: range.end });
      continue;
    }

    // Not in nanoka's roster yet (brand-new/unreleased) — best-effort name so
    // the schedule isn't silently missing an entry; no featuredId/image until
    // nanoka catches up on a later run. Strip the same "S-Rank Character "
    // prefix matchKnownName would have, so the guess doesn't swallow it.
    //
    // Only the FIRST capitalized token is taken, and internal letters are
    // restricted to lowercase ([a-z], not [a-zA-Z]) — there's no delimiter
    // between this tail's real content and the next banner's bled-in flavor
    // name (e.g. "ZankouWill You Pull..."), so a capital letter is the only
    // signal available for a word boundary. This means unresolved guesses
    // are single-word and low-confidence by design; they exist so the
    // schedule doesn't silently drop the phase, not as a final name.
    const trimmedTail = tail.trim();
    const prefixMatch = trimmedTail.match(/^(?:S-Rank|A-Rank)\s+Character\s+/);
    const guessFrom = prefixMatch ? trimmedTail.slice(prefixMatch[0].length) : trimmedTail;
    const guess = guessFrom.match(/^([A-Z][a-z'-]+)/);
    if (guess) {
      results.push({ kind: 'character', name: guess[1].trim(), start: range.start, end: range.end, unresolved: true });
    }
  }

  return results;
}

module.exports = { scrapeGamewithBanners, parseDurationText, extractArticleBody, matchKnownName };
