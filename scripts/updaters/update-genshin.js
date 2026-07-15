#!/usr/bin/env node
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const COOKIE = process.env.HOYOLAB_COOKIE;
const UID    = process.env.GENSHIN_UID;
const SERVER = process.env.GENSHIN_SERVER;

const SALT          = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs';
const SCHEDULE_PATH = path.join(__dirname, '..', '..', 'genshin', 'banner-schedule-genshin.json');
const IMAGES_DIR    = path.join(__dirname, '..', '..', 'genshin', 'images');

// Phase start times (UTC+8) — used to backfill missing phase fields on existing entries.
// Chronicled banners have irregular timing and are skipped (handled manually).
const PHASE_BY_START = { '07:00:00': 1, '01:00:00': 2 };

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

function httpsPost(body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: 'sg-public-api.hoyolab.com',
      path: '/event/game_record/genshin/api/act_calendar',
      method: 'POST', timeout: 20000,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr),
        Cookie: COOKIE, DS: generateDS(),
        'x-rpc-app_version': '1.5.0', 'x-rpc-client_type': '5',
        'x-rpc-language': 'en-us', Referer: 'https://act.hoyolab.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(bodyStr);
    req.end();
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
  if (!COOKIE || !UID || !SERVER) throw new Error('Missing HOYOLAB_COOKIE, GENSHIN_UID, or GENSHIN_SERVER');

  console.log('Fetching Genshin act_calendar...');
  const json = await httpsPost({ server: SERVER, role_id: UID });
  if (json.retcode !== 0) throw new Error(`API error ${json.retcode}: ${json.message}`);

  console.log('API pools:');
  for (const pool of [...(json.data.avatar_card_pool_list || []), ...(json.data.weapon_card_pool_list || [])]) {
    console.log(`  v${pool.version_name} pool_id=${pool.pool_id} start_timestamp=${pool.start_timestamp} => ${unixToUtc8(pool.start_timestamp)}  end_timestamp=${pool.end_timestamp} => ${unixToUtc8(pool.end_timestamp)}`);
  }

  const existing = fs.existsSync(SCHEDULE_PATH) ? JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8')) : [];
  const existingMap = new Map(existing.map(e => [`${e.featuredId}|${(e.start || '').slice(0, 10)}`, e]));

  // Backfill phase on any existing non-chronicled entry that is missing it, using start time.
  let phasedCount = 0;
  for (const e of existing) {
    if (e.phase != null || e.type === 'chronicled') continue;
    const phase = PHASE_BY_START[(e.start || '').slice(11)];
    if (phase != null) { e.phase = phase; phasedCount++; }
  }
  if (phasedCount > 0) console.log(`Phase backfilled on ${phasedCount} existing entries.`);

  const fetched = [];
  const iconMap = {};

  for (const pool of (json.data.avatar_card_pool_list || [])) {
    const start   = unixToUtc8(pool.start_timestamp);
    const end     = unixToUtc8(pool.end_timestamp);
    const version = pool.version_name || '';
    for (const a of (pool.avatars || []).filter(a => a.rarity === 5)) {
      iconMap[a.id] = a.icon;
      fetched.push({ type: 'character', version, start, end, name: a.name, featured: [a.name], featuredId: a.id });
    }
  }
  for (const pool of (json.data.weapon_card_pool_list || [])) {
    const start   = unixToUtc8(pool.start_timestamp);
    const end     = unixToUtc8(pool.end_timestamp);
    const version = pool.version_name || '';
    for (const w of (pool.weapon || []).filter(w => w.rarity === 5)) {
      iconMap[w.id] = w.icon;
      fetched.push({ type: 'weapon', version, start, end, name: w.name, featured: [w.name], featuredId: w.id });
    }
  }
  // Chronicled banners: skipped until we have a live example to base the schema on

  // Assign phases to newly fetched entries using full context (existing + fetched).
  for (const entry of fetched) {
    const sameGroup = [...existing, ...fetched].filter(
      e => e.version === entry.version && e.type === entry.type
    );
    const sortedStarts = [...new Set(sameGroup.map(e => e.start.slice(0, 10)))].sort();
    entry.phase = sortedStarts.indexOf(entry.start.slice(0, 10)) + 1;
  }

  let newCount = 0, updatedCount = 0;
  for (const entry of fetched) {
    const key = `${entry.featuredId}|${entry.start.slice(0, 10)}`;
    const existing_entry = existingMap.get(key);
    if (!existing_entry) {
      existing.push(entry);
      existingMap.set(key, entry);
      newCount++;
    } else if (!existing_entry.name && entry.name) {
      existing_entry.name = entry.name;
      existing_entry.featured = entry.featured;
      updatedCount++;
      console.log(`  Updated name: ${entry.featuredId} => "${entry.name}"`);
    }
  }

  const merged = existing.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

  fs.mkdirSync(path.dirname(SCHEDULE_PATH), { recursive: true });
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(merged, null, 2));
  console.log(`Schedule: ${newCount} new entries added, ${updatedCount} names updated (${merged.length} total).`);

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