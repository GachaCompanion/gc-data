#!/usr/bin/env node
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const COOKIE = process.env.HOYOLAB_COOKIE;
const UID    = process.env.HSR_UID;
const SERVER = process.env.HSR_SERVER;

const SALT          = '6s25p5ox5y14umn1p61aqyyvbvvl3lrt';
const API_URL       = 'https://sg-public-api.hoyolab.com/event/game_record/hkrpg/api/get_act_calender';
const SCHEDULE_PATH = path.join(__dirname, '..', '..', 'hsr', 'banner-schedule-hsr.json');
const IMAGES_DIR    = path.join(__dirname, '..', '..', 'hsr', 'images');

// Phase start times (UTC+8) — used to backfill missing phase fields on existing entries.
const PHASE_BY_START = { '10:00:00': 1, '19:00:00': 2 };

function generateDS() {
  const t = Math.floor(Date.now() / 1000);
  const r = Math.floor(Math.random() * 900000) + 100000;
  return t + ',' + r + ',' + crypto.createHash('md5').update('salt=' + SALT + '&t=' + t + '&r=' + r).digest('hex');
}

function unixToUtc8(unix) {
  const d = new Date((parseInt(unix) + 8 * 3600) * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://act.hoyolab.com/' } }, res => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!COOKIE || !UID || !SERVER) throw new Error('Missing HOYOLAB_COOKIE, HSR_UID, or HSR_SERVER');

  console.log('Fetching HSR calendar...');
  const json = await httpsGet(`${API_URL}?server=${SERVER}&role_id=${UID}`, {
    Cookie: COOKIE, DS: generateDS(),
    'x-rpc-app_version': '1.5.0', 'x-rpc-client_type': '5',
    'x-rpc-language': 'en-us', Referer: 'https://act.hoyolab.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  if (json.retcode !== 0) throw new Error(`API error ${json.retcode}: ${json.message}`);

  const fetched = [];
  const iconMap = {};

  for (const pool of (json.data.avatar_card_pool_list || [])) {
    const start = unixToUtc8(pool.time_info.start_ts);
    const end   = unixToUtc8(pool.time_info.end_ts);
    for (const c of (pool.avatar_list || []).filter(c => c.rarity === '5')) {
      iconMap[parseInt(c.item_id)] = c.icon_url;
      fetched.push({ type: 'character', version: pool.version, start, end, name: c.item_name, featured: [c.item_name], featuredId: parseInt(c.item_id) });
    }
  }
  for (const pool of (json.data.equip_card_pool_list || [])) {
    const start = unixToUtc8(pool.time_info.start_ts);
    const end   = unixToUtc8(pool.time_info.end_ts);
    for (const lc of (pool.equip_list || []).filter(lc => lc.rarity === '5')) {
      iconMap[parseInt(lc.item_id)] = lc.item_url;
      fetched.push({ type: 'weapon', version: pool.version, start, end, name: lc.item_name, featured: [lc.item_name], featuredId: parseInt(lc.item_id) });
    }
  }

  const existing = fs.existsSync(SCHEDULE_PATH) ? JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8')) : [];

  // Backfill phase on any existing entry that is missing it, using start time as the key.
  let phasedCount = 0;
  for (const e of existing) {
    if (e.phase != null) continue;
    const phase = PHASE_BY_START[(e.start || '').slice(11)];
    if (phase != null) { e.phase = phase; phasedCount++; }
  }
  if (phasedCount > 0) console.log(`Phase backfilled on ${phasedCount} existing entries.`);

  // Assign phases to newly fetched entries using full context (existing + fetched).
  for (const entry of fetched) {
    const sameGroup = [...existing, ...fetched].filter(
      e => e.version === entry.version && e.type === entry.type
    );
    const sortedStarts = [...new Set(sameGroup.map(e => e.start.slice(0, 10)))].sort();
    entry.phase = sortedStarts.indexOf(entry.start.slice(0, 10)) + 1;
  }

  const seen       = new Set(existing.map(e => `${e.featuredId}|${(e.start || '').slice(0, 10)}`));
  const newEntries = fetched.filter(e => !seen.has(`${e.featuredId}|${(e.start || '').slice(0, 10)}`));
  const merged     = [...existing, ...newEntries].sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

  fs.mkdirSync(path.dirname(SCHEDULE_PATH), { recursive: true });
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(merged, null, 2));
  console.log(`Schedule: ${newEntries.length} new entries added (${merged.length} total).`);
  if (newEntries.length) console.log('New:', newEntries.map(e => `${e.name} v${e.version}`).join(', '));

  // Images
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  let saved = 0, skipped = 0;
  for (const { featuredId } of fetched) {
    const dest = path.join(IMAGES_DIR, featuredId + '.png');
    if (fs.existsSync(dest)) { skipped++; continue; }
    const url = iconMap[featuredId];
    if (!url) { console.warn(`  No icon URL for ID ${featuredId}`); continue; }
    try {
      const buf = await downloadImage(url);
      if (buf) { fs.writeFileSync(dest, buf); saved++; console.log(`  Image saved: ${featuredId}.png`); }
    } catch(e) { console.warn(`  Image failed: ${featuredId} — ${e.message}`); }
    await sleep(300);
  }
  console.log(`Images: ${saved} new, ${skipped} already present.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });