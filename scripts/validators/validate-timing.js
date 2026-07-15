const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const logsDir = path.join(root, 'logs');
const rulesPath = path.join(__dirname, 'banner-timing-rules.json');

const scheduleFiles = {
  genshin: path.join(root, 'genshin', 'banner-schedule-genshin.json'),
  hsr:     path.join(root, 'hsr',     'banner-schedule-hsr.json'),
  zzz:     path.join(root, 'zzz',     'banner-schedule-zzz.json'),
  wuwa:    path.join(root, 'wuwa',    'banner-schedule-wuwa.json'),
};

const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const now = new Date();
const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);
const logFilename = now.toISOString().substring(0, 10) + '_timing-fix.log';
const logPath = path.join(logsDir, logFilename);

const logLines = [];
const summary = { genshin: 0, hsr: 0, zzz: 0, wuwa: 0 };

function log(line) {
  const entry = `[${timestamp}] ${line}`;
  logLines.push(entry);
  console.log(entry);
}

for (const [game, filePath] of Object.entries(scheduleFiles)) {
  const schedule = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let fileModified = false;

  schedule.forEach((entry, idx) => {
    if (entry.type !== 'character' && entry.type !== 'weapon') return;

    const phaseKey = 'phase' + entry.phase;
    const phaseRules = rules[game][phaseKey];

    if (!phaseRules) return; // phase not defined in rules (e.g. Genshin phase3)

    const entryStartTime = entry.start ? entry.start.substring(11) : null;
    const entryEndTime = entry.end ? entry.end.substring(11) : null;

    // Check start time
    if (phaseRules.start !== null && entryStartTime !== phaseRules.start) {
      const corrected = entry.start.substring(0, 11) + phaseRules.start;
      log(`FIXED [${game}] v${entry.version} ${phaseKey} "${entry.name}" - start was ${entryStartTime}, corrected to ${phaseRules.start}`);
      schedule[idx] = { ...entry, start: corrected };
      entry = schedule[idx];
      summary[game]++;
      fileModified = true;
    }

    // Check end time
    if (phaseRules.end !== null && entryEndTime !== phaseRules.end) {
      const corrected = entry.end.substring(0, 11) + phaseRules.end;
      log(`FIXED [${game}] v${entry.version} ${phaseKey} "${entry.name}" - end was ${entryEndTime}, corrected to ${phaseRules.end}`);
      schedule[idx] = { ...entry, end: corrected };
      summary[game]++;
      fileModified = true;
    }
  });

  if (fileModified) {
    fs.writeFileSync(filePath, JSON.stringify(schedule, null, 2));
  }
}

const totalFixes = summary.genshin + summary.hsr + summary.zzz + summary.wuwa;
log(`Run complete: ${totalFixes} fix(es) applied (Genshin: ${summary.genshin}, HSR: ${summary.hsr}, ZZZ: ${summary.zzz}, WuWa: ${summary.wuwa})`);

fs.appendFileSync(logPath, logLines.join('\n') + '\n');
