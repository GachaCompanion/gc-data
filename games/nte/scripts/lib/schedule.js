// Deterministic NTE phase-boundary computation. NTE has no official API to
// pull banner timing from (unlike GI/HSR/ZZZ, which use the Hoyoverse API) —
// but the timing itself is regular enough to compute directly:
//
//   - Every phase is exactly 21 days long.
//   - Every phase starts 06:00 UTC+8 and ends 05:59 UTC+8 (the next phase's
//     start, minus one minute).
//   - Confirmed anchor: "Before the Dawn" (Shinku) phase started
//     2026-07-08 06:00 UTC+8 — verified against gamewith.net's own printed
//     end times for two consecutive real phases (see project notes).
//
// This is date math only — it does NOT know which character/arc is featured
// in any given phase. That comes from gamewith.net (gamewith.js) for the
// phases it has announced; phases beyond that stay as placeholders with
// name: null until a later run picks up the announcement.

const PHASE_DAYS = 21;
const ANCHOR_UTC_MS = Date.UTC(2026, 6, 7, 22, 0, 0); // 2026-07-08 06:00 UTC+8 == 2026-07-07 22:00 UTC
const PHASE_MS = PHASE_DAYS * 24 * 60 * 60 * 1000;

function pad2(n) { return String(n).padStart(2, '0'); }

// Renders a UTC instant as the equivalent naive "YYYY-MM-DD HH:MM:SS" UTC+8
// wall-clock string, matching gamewith.js's output format.
function utcMsToWallClockString(utcMs) {
  const d = new Date(utcMs + 8 * 60 * 60 * 1000); // shift to UTC+8, then read UTC getters as if local
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:00`;
}

// Index of the phase that contains `atUtcMs` (0-based, can be negative for
// dates before the anchor).
function phaseIndexAt(atUtcMs) {
  return Math.floor((atUtcMs - ANCHOR_UTC_MS) / PHASE_MS);
}

// Returns { start, end } (naive UTC+8 wall-clock strings) for phase `index`.
function phaseBoundsForIndex(index) {
  const startMs = ANCHOR_UTC_MS + index * PHASE_MS;
  const endMs = startMs + PHASE_MS - 60 * 1000; // one minute before the next phase's start
  return { start: utcMsToWallClockString(startMs), end: utcMsToWallClockString(endMs) };
}

// Anchor (index 0) is 1.2 Phase 1, and each version is exactly 2 phases —
// confirmed against knownHistory.js's own real data (1.0/1.1 both had
// exactly 2 phases each before 1.2), not assumed. Works for negative
// indices too: e.g. index -4/-3 (1.0 P1/P2) both resolve to "1.0",
// index -2/-1 (1.1 P1/P2) both resolve to "1.1", matching knownHistory.js
// exactly — verified with a script before relying on it here.
function versionForIndex(index) {
  const minor = 2 + Math.floor(index / 2);
  return `1.${minor}`;
}

/**
 * Computes phase placeholder windows covering [now - phasesBack, now + phasesForward].
 * `phase` alternates 1/2 from the anchor — confirmed matching knownHistory.js's
 * real phase numbering (see versionForIndex above), not just informational.
 */
function computePhaseWindows({ now = new Date(), phasesBack = 2, phasesForward = 12 } = {}) {
  const centerIndex = phaseIndexAt(now.getTime());
  const windows = [];
  for (let i = centerIndex - phasesBack; i <= centerIndex + phasesForward; i++) {
    const { start, end } = phaseBoundsForIndex(i);
    windows.push({ index: i, start, end, phase: (((i % 2) + 2) % 2) + 1, version: versionForIndex(i) });
  }
  return windows;
}

module.exports = { computePhaseWindows, phaseBoundsForIndex, phaseIndexAt, versionForIndex, PHASE_DAYS };
