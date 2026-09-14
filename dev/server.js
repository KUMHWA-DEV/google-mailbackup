/**
 * 로컬 미리보기 서버.
 *  - src/index.html 을 그대로 서빙하되 google.script.run 을 흉내내는 shim을 주입한다.
 *  - 데이터는 dev/fixtures/index.json (샘플 인덱스), 로직은 실제 순수 모듈(src/lib)을 쓴다.
 *  - 설정/트리거/실행 상태는 메모리에만 있으며 서버를 재시작하면 초기화된다.
 *  실행: npm run dev  →  http://localhost:8787
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { filterRecords, summarizeRecords } = require('../src/lib/index_row.js');
const { computeSchedule } = require('../src/lib/schedule.js');
const { normalizeSettings } = require('../src/lib/settings.js');
const { classifyAgenda } = require('../src/lib/agenda.js');

const PORT = Number(process.env.PORT) || 8787;
const ROOT = path.join(__dirname, '..');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'index.json'), 'utf8'))
  .map(r => ({ ...r, agenda: r.agenda || classifyAgenda(r.subject, r.snippet, r.labels.split(', ')) }));
const listRecords = () => fixtures.map(({ bodyPreview, ...rest }) => rest);

let settings = normalizeSettings({ notifyEmail: 'kumhwa_dev@spris.com' });
let triggerInstalled = false;
let lastSyncEpoch = Math.floor(new Date('2026-09-08T03:04:00.000Z').getTime() / 1000);
let status = { state: 'idle', message: '로컬 미리보기 (샘플 데이터)', updatedAt: new Date().toISOString() };
let currentRun = { startedAt: '2026-09-08T03:04:00.000Z', finishedAt: '2026-09-08T03:06:41.000Z', chunks: 1, found: 9, processed: 4, skipped: 5, errors: 0, bytes: 1616000, mailFrom: '2026-09-03T07:15:00.000Z', mailTo: '2026-09-10T01:12:00.000Z', limitHit: false };
const history = [
  { ...currentRun, notifiedTo: 'kumhwa_dev@spris.com' },
  { startedAt: '2026-09-01T03:04:00.000Z', finishedAt: '2026-09-01T03:05:12.000Z', chunks: 1, found: 7, processed: 3, skipped: 4, errors: 0, bytes: 122000, mailFrom: '2026-08-25T09:20:00.000Z', mailTo: '2026-08-30T12:00:00.000Z', notifiedTo: 'kumhwa_dev@spris.com' },
  { startedAt: '2026-08-25T03:04:00.000Z', finishedAt: '2026-08-25T03:15:30.000Z', chunks: 3, found: 5, processed: 5, skipped: 0, errors: 1, bytes: 230000, mailFrom: '2026-08-01T06:00:00.000Z', mailTo: '2026-08-20T00:00:00.000Z', notifiedTo: null },
];

function dashboard() {
  return {
    state: status.state, message: status.message, updatedAt: status.updatedAt,
    lastSyncAt: lastSyncEpoch ? new Date(lastSyncEpoch * 1000).toISOString() : null,
    schedule: computeSchedule({ lastSyncEpoch, intervalDays: settings.intervalDays }),
    currentRun, lastError: null, history,
    summary: summarizeRecords(listRecords()),
    settings, triggerInstalled,
    folderUrl: 'https://drive.google.com/drive/folders/LOCAL', indexSheetUrl: 'https://docs.google.com/spreadsheets/d/LOCAL',
    webAppUrl: `http://localhost:${PORT}/`, user: 'kumhwa_dev@spris.com (local)',
  };
}

const api = {
  getDashboard: dashboard,
  getStatus: dashboard,
  getExplorerData: () => ({ records: filterRecords(listRecords(), {}), summary: summarizeRecords(listRecords()), history }),
  getMessageBody: (id) => ({ id, body: (fixtures.find(r => r.id === id) || {}).bodyPreview || '' }),
  getCategories: () => summarizeRecords(listRecords()).categories,
  getSettings: () => settings,
  saveSettings: (input) => { settings = normalizeSettings(input); return dashboard(); },
  searchMessages: (f = {}) => {
    const hits = filterRecords(listRecords(), f);
    const pageSize = Math.max(1, Math.min(200, Number(f.pageSize) || 50));
    const page = Math.max(1, Number(f.page) || 1);
    return { total: hits.length, page, pageSize, items: hits.slice((page - 1) * pageSize, page * pageSize) };
  },
  runBackupNow: () => {
    status = { state: 'queued', message: '수동 실행 요청됨, 잠시 후 시작', updatedAt: new Date().toISOString() };
    setTimeout(() => { status = { state: 'running', message: '새 백업 시작 (1번째 구간)', updatedAt: new Date().toISOString() }; }, 3000);
    setTimeout(() => {
      lastSyncEpoch = Math.floor(Date.now() / 1000);
      currentRun = { startedAt: new Date(Date.now() - 12000).toISOString(), finishedAt: new Date().toISOString(), chunks: 1, found: 3, processed: 0, skipped: 3, errors: 0, bytes: 0, mailFrom: null, mailTo: null, limitHit: false };
      history.unshift({ ...currentRun, notifiedTo: settings.notifyOnComplete ? (settings.notifyEmail || 'kumhwa_dev@spris.com') : null });
      status = { state: 'idle', message: '완료: 감지 3건, 새로 0건 저장, 3건 이미 있음, 오류 0건 (로컬 모의)', updatedAt: new Date().toISOString() };
    }, 12000);
    return dashboard();
  },
  installScheduledTrigger: () => { triggerInstalled = true; return dashboard(); },
  installWeeklyTrigger: () => api.installScheduledTrigger(),
  uninstallScheduledTrigger: () => { triggerInstalled = false; return dashboard(); },
};

const SHIM = `<script>
window.google = { script: { run: (function () {
  function runner(ok, fail) {
    var r = { withSuccessHandler: function (f) { return runner(f, fail); }, withFailureHandler: function (f) { return runner(ok, f); } };
    ${Object.keys(api).map(fn => `r.${fn} = function (arg) { rpc('${fn}', arg, ok, fail); };`).join('\n    ')}
    return r;
  }
  function rpc(fn, arg, ok, fail) {
    fetch('/api/' + fn, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(arg === undefined ? null : arg) })
      .then(function (res) { return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || res.statusText); return j; }); })
      .then(ok || function () {}, fail || function (e) { console.error(e); });
  }
  return runner();
})() } };
</script>`;

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/')) {
    const fn = req.url.slice(5);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        if (!api[fn]) throw new Error('unknown function ' + fn);
        const arg = body ? JSON.parse(body) : undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(api[fn](arg)));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.url === '/' || req.url.startsWith('/index')) {
    const searchLib = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'search.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8')
      .replace('<!-- DEV_SHIM -->', SHIM)
      .replace('<?!= searchLib ?>', searchLib); // Apps Script 템플릿 스크립틀릿을 로컬에서 대체
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => {
  console.log(`Mail Backup 로컬 미리보기: http://localhost:${PORT}`);
});
