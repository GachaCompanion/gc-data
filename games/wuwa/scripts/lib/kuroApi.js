// Fetches Wuthering Waves' live gacha calendar directly from Kuro Games'
// own public wiki/community-hub API — no auth, no cookie, unlike the
// Hoyolab act_calendar approach genshin/hsr/zzz use (Kuro's API has no
// equivalent authenticated per-account endpoint, and this one needs no
// account at all).
//
// Endpoint: POST https://api.kurobbs.com/wiki/core/homepage/getPage
// Confirmed (2026-07-12) via direct testing:
//   - No auth required, just the two headers below.
//   - Returns data.contentJson.sideModules, which includes (among other
//     unrelated modules) two "events-side" modules:
//       title '角色活动唤取' (Featured Resonator/character convene)
//       title '武器活动唤取' (Featured Weapon convene)
//     each with content.tabs — one tab per currently-live/recently-ended
//     banner, shape:
//       { name: '<Chinese banner/character name>',
//         countDown: { dateRange: ['2026-07-10 11:00', '2026-07-30 09:59'] },
//         imgs: [ { img: '<official banner art URL>', linkConfig: {...} }, ... ] }
//   - This endpoint only ever returns CURRENT (and sometimes just-ended)
//     banners — there is no historical/past-banner query parameter. Older
//     banners must be entered by hand (see README in this folder).
//   - IMPORTANT: tab.name is the banner's marketing/flavor title (e.g.
//     "牵翎祈万声"), NOT the featured character/weapon's name — confirmed by
//     a live run where every tab.name failed to match anything in nanoka's
//     roster. The actual item name has to be resolved separately, from the
//     entryId on the tab's first image via Kuro's own entry-detail endpoint
//     (POST /wiki/core/catalogue/item/getEntryDetail, body { id: entryId })
//     which returns { data: { name: '<Chinese item name>', ... } } — THAT
//     name matches nanoka's `zh` field exactly (confirmed: entryId
//     1519669180526559232 -> "秧秧·玄翎" === nanoka ww character 1610's zh
//     field, both meaning "Yangyang: Xuanling"). This is the join key used
//     by build.js, NOT Kuro's own wiki entryId itself (a completely
//     separate, much larger numbering scheme unrelated to nanoka's ids).

const https = require('https');

function fetchWikiHome() {
  return new Promise((resolve, reject) => {
    const body = '';
    const req = https.request({
      hostname: 'api.kurobbs.com',
      path: '/wiki/core/homepage/getPage',
      method: 'POST',
      timeout: 20000,
      headers: {
        source: 'h5',
        wiki_type: '9',
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (wuwa-banner-schedule-bot)',
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out fetching Kuro wiki homepage')); });
    req.write(body);
    req.end();
  });
}

function fetchEntryDetail(entryId) {
  return new Promise((resolve, reject) => {
    const body = `id=${encodeURIComponent(entryId)}`;
    const req = https.request({
      hostname: 'api.kurobbs.com',
      path: '/wiki/core/catalogue/item/getEntryDetail',
      method: 'POST',
      timeout: 20000,
      headers: {
        source: 'h5',
        wiki_type: '9',
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (wuwa-banner-schedule-bot)',
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timed out fetching entry detail ${entryId}`)); });
    req.write(body);
    req.end();
  });
}

// "2026-07-10 11:00" -> "2026-07-10 11:00:00" (matches the other 3 games'
// stored schedule format, which always carries seconds).
function withSeconds(dateStr) {
  if (!dateStr) return null;
  return /:\d{2}:\d{2}$/.test(dateStr) ? dateStr : `${dateStr}:00`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Returns { characterTabs, weaponTabs }, each an array of
// { name (Chinese item name, resolved via getEntryDetail), start, end, image }.
async function fetchLiveBannerTabs() {
  const json = await fetchWikiHome();
  if (json.code !== 200) throw new Error(`Kuro API error ${json.code}: ${json.msg}`);

  const sideModules = json.data?.contentJson?.sideModules || [];
  const charModule = sideModules.find(m => m.title === '角色活动唤取');
  const weaponModule = sideModules.find(m => m.title === '武器活动唤取');

  async function extractTabs(module) {
    const tabs = module?.content?.tabs || [];
    const out = [];
    for (const tab of tabs) {
      const range = tab.countDown?.dateRange;
      const entryId = tab.imgs?.[0]?.linkConfig?.entryId;
      if (!entryId || !range || range.length < 2) continue;

      const detail = await fetchEntryDetail(entryId);
      if (detail.code !== 200 || !detail.data?.name) {
        out.push({ name: null, start: withSeconds(range[0]), end: withSeconds(range[1]), image: tab.imgs?.[0]?.img || null, entryId, unresolvedReason: 'entry-detail-lookup-failed' });
        continue;
      }
      await sleep(300); // small courtesy delay between Kuro API calls

      const image = tab.imgs?.[0]?.img || null;
      out.push({ name: detail.data.name, start: withSeconds(range[0]), end: withSeconds(range[1]), image, entryId });
    }
    return out;
  }

  return {
    characterTabs: await extractTabs(charModule),
    weaponTabs: await extractTabs(weaponModule),
  };
}

module.exports = { fetchLiveBannerTabs };
