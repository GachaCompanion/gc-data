// Confirmed historical NTE phases that predate the clean 21-day cadence
// (see schedule.js) — versions 1.0 and 1.1 both had one irregular 14-day
// phase mixed in with 21-day ones, so these can't be derived from the
// formula and must be hardcoded from a verified source (the user's own
// records — gamewith.net has no historical banner archive, only current +
// upcoming).
//
// The regular 21-day cadence only starts being trustworthy at the 1.2 P1
// anchor (2026-07-08, "Before the Dawn"/Shinku) — schedule.js computes
// everything from that point forward. Everything here is strictly earlier
// than that anchor and is never recomputed, only ever appended to over time
// as new confirmed history comes in.
//
// Character/arc names and fork keys cross-checked against nanoka.cc and the
// main app's rewardMappings.js (both confirmed matching, see project notes).

const KNOWN_HISTORY = [
  {
    version: '1.0', phase: 1,
    start: '2026-04-29 06:00:00', end: '2026-05-13 05:59:00',
    character: { name: 'Nanally', id: 1010 },
    arc: { name: 'Ready-Ready', key: 'fork_TigerTally' },
  },
  {
    version: '1.0', phase: 2,
    start: '2026-05-13 06:00:00', end: '2026-06-03 05:59:00',
    character: { name: 'Hotori', id: 1052 },
    arc: { name: 'Marching Beyond Time', key: 'fork_Time' },
  },
  {
    version: '1.1', phase: 1,
    start: '2026-06-03 06:00:00', end: '2026-06-24 05:59:00',
    character: { name: 'Lacrimosa', id: 1004 },
    arc: { name: 'The Last Rose', key: 'fork_Rose' },
  },
  {
    version: '1.1', phase: 2,
    start: '2026-06-24 06:00:00', end: '2026-07-08 05:59:00',
    character: { name: 'Chaos', id: 1071 },
    arc: { name: "What's Desired", key: 'fork_GoldWool' },
  },
];

// Flattens KNOWN_HISTORY into the same {type,start,end,name,featured,featuredId,phase}
// shape the rest of the pipeline (build.js/scheduleToAppFormat-equivalent) uses.
function knownHistoryEntries() {
  const out = [];
  for (const p of KNOWN_HISTORY) {
    out.push({
      type: 'character', version: p.version, start: p.start, end: p.end,
      name: p.character.name, featured: [p.character.name], featuredId: p.character.id, phase: p.phase,
    });
    out.push({
      type: 'arc', version: p.version, start: p.start, end: p.end,
      name: p.arc.name, featured: [p.arc.name], featuredId: p.arc.key, phase: p.phase,
    });
  }
  return out;
}

module.exports = { KNOWN_HISTORY, knownHistoryEntries };
