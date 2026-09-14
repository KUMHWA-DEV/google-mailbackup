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
const { aggregatePreview, runProgress, addToBreakdown, breakdownList, estimateRunSeconds } = require('../src/lib/preview.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = Number(process.env.PORT) || 8787;
const ROOT = path.join(__dirname, '..');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'index.json'), 'utf8'))
  .map(r => ({ ...r, agenda: r.agenda || classifyAgenda(r.subject, r.snippet, r.labels.split(', ')) }));
const listRecords = () => fixtures.map(({ bodyPreview, ...rest }) => rest);

let settings = normalizeSettings({ notifyEmail: 'kumhwa_dev@spris.com' });
let triggerInstalled = false;
let lastSyncEpoch = process.env.FIRST ? null : Math.floor(new Date('2026-09-08T03:04:00.000Z').getTime() / 1000); // FIRST=1 npm run dev → 첫 백업 화면
let status = { state: 'idle', message: '로컬 미리보기 (샘플 데이터)', updatedAt: new Date().toISOString() };
let currentRun = { startedAt: '2026-09-08T03:04:00.000Z', finishedAt: '2026-09-08T03:06:41.000Z', chunks: 1, found: 9, processed: 4, skipped: 5, errors: 0, bytes: 1616000, mailFrom: '2026-09-03T07:15:00.000Z', mailTo: '2026-09-10T01:12:00.000Z', limitHit: false, expectedTotal: 4, manual: false,
  byCategory: [{ name: '받은편지함', count: 2, bytes: 590000 }, { name: '보낸편지함', count: 1, bytes: 20480 }, { name: '거래처-BBB', count: 1, bytes: 950000 }] };
const history = [
  { ...currentRun, notifiedTo: 'kumhwa_dev@spris.com' },
  { startedAt: '2026-09-01T03:04:00.000Z', finishedAt: '2026-09-01T03:05:12.000Z', chunks: 1, found: 7, processed: 3, skipped: 4, errors: 0, bytes: 122000, mailFrom: '2026-08-25T09:20:00.000Z', mailTo: '2026-08-30T12:00:00.000Z', notifiedTo: 'kumhwa_dev@spris.com', manual: true, expectedTotal: 3, byCategory: [{ name: '소셜', count: 1, bytes: 65000 }, { name: '보낸편지함', count: 1, bytes: 12000 }, { name: '보관됨', count: 1, bytes: 45000 }] },
  { startedAt: '2026-08-25T03:04:00.000Z', finishedAt: '2026-08-25T03:15:30.000Z', chunks: 3, found: 5, processed: 5, skipped: 0, errors: 1, bytes: 230000, mailFrom: '2026-08-01T06:00:00.000Z', mailTo: '2026-08-20T00:00:00.000Z', notifiedTo: null, manual: false, expectedTotal: 0, byCategory: [{ name: '받은편지함', count: 2, bytes: 150000 }, { name: '포럼', count: 1, bytes: 22000 }, { name: '임시보관함', count: 1, bytes: 8000 }, { name: '프로모션', count: 1, bytes: 50000 }] },
];
let preview = null;

function dashboard() {
  return {
    state: status.state, message: status.message, updatedAt: status.updatedAt,
    lastSyncAt: lastSyncEpoch ? new Date(lastSyncEpoch * 1000).toISOString() : null,
    schedule: computeSchedule({ lastSyncEpoch, intervalDays: settings.intervalDays }),
    currentRun: { ...currentRun, progress: runProgress(currentRun) }, lastError: null, history,
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
  // 감지(미리보기): 실제 서버는 Gmail을 조회한다. 로컬은 샘플 7건을 "새 메일"로 가정하고 1.2초 지연.
  previewBackup: async (opt) => {
    opt = opt || {};
    await sleep(1200);
    const scope = opt.scope || (!lastSyncEpoch ? 'all' : 'incremental');
    const metas = fixtures.slice(0, 7).map(r => ({ category: r.category, sizeBytes: r.sizeBytes, date: r.date, from: r.from.replace(/<.*>/, '').trim() || r.from }));
    preview = aggregatePreview({ found: 12, skipped: 5, newCount: 7, metas, detailed: 7 });
    const isFirst = !lastSyncEpoch;
    if (scope === 'all') { preview = aggregatePreview({ found: 300, skipped: isFirst ? 0 : 12, newCount: isFirst ? 4180 : 4168, metas, detailed: 7 }); preview.mailboxTotal = 4180; preview.mailFrom = '2026-07-30T02:11:00.000Z'; preview.mailFromExact = true; }
    if (scope === 'since') { preview = aggregatePreview({ found: 430, skipped: isFirst ? 0 : 10, newCount: 420, metas, detailed: 7 }); }
    preview.scope = scope; preview.sinceDate = scope === 'since' ? (opt.sinceDate || '') : '';
    preview.isFirst = isFirst; preview.initialStartDate = settings.initialStartDate || ''; preview.estimatedSeconds = estimateRunSeconds(preview.newCount);
    preview.query = '-in:spam -in:trash -in:chats'; preview.truncated = isFirst; preview.lastSyncAt = lastSyncEpoch ? new Date(lastSyncEpoch * 1000).toISOString() : null; preview.previewedAt = new Date().toISOString(); preview.elapsedMs = 1200;
    return preview;
  },
  // 백그라운드 큐 모의: 3초 대기 → 1.5초마다 1건 저장 → 완료 후 이력 추가
  runBackupNow: () => {
    const expected = preview ? preview.newCount : 7;
    status = { state: 'queued', message: '대기열 등록 · 곧 시작 (예상 ' + expected + '건)', updatedAt: new Date().toISOString() };
    currentRun = { startedAt: null, expectedTotal: expected, manual: true, processed: 0, found: 0, skipped: 0, errors: 0, bytes: 0, chunks: 0, byCategory: [] };
    setTimeout(() => {
      const cats = {};
      currentRun = { startedAt: new Date().toISOString(), chunkStartedAt: new Date().toISOString(), chunks: 1, found: 12, processed: 0, skipped: 5, errors: 0, bytes: 0, mailFrom: null, mailTo: null, limitHit: false, expectedTotal: expected, manual: true, byCategory: [] };
      status = { state: 'running', message: '새 백업 시작 (1번째 구간)', updatedAt: new Date().toISOString() };
      let i = 0;
      const tick = setInterval(() => {
        const r = fixtures[i % fixtures.length], step = expected > 50 ? Math.ceil(expected / 40) : 1;
        currentRun.processed = Math.min(expected, currentRun.processed + step); currentRun.bytes += r.sizeBytes * step; addToBreakdown(cats, r.category, r.sizeBytes); currentRun.byCategory = breakdownList(cats);
        if (!currentRun.mailFrom || r.date < currentRun.mailFrom) currentRun.mailFrom = r.date; if (!currentRun.mailTo || r.date > currentRun.mailTo) currentRun.mailTo = r.date;
        status = { state: 'running', message: '저장 중 ' + currentRun.processed + '건 / ' + expected, updatedAt: new Date().toISOString() };
        i += 1;
        if (currentRun.processed >= expected) {
          clearInterval(tick);
          lastSyncEpoch = Math.floor(Date.now() / 1000);
          currentRun.finishedAt = new Date().toISOString();
          history.unshift({ ...currentRun, notifiedTo: settings.notifyOnComplete ? (settings.notifyEmail || 'kumhwa_dev@spris.com') : null });
          status = { state: 'idle', message: '완료: 감지 12건, 새로 ' + expected + '건 저장, 5건 이미 있음, 오류 0건 (로컬 모의)', updatedAt: new Date().toISOString() };
        }
      }, 1500);
    }, 3000);
    return dashboard();
  },
  installScheduledTrigger: () => { triggerInstalled = true; return dashboard(); },
  disconnectApp: () => ({ ok: true }),
  runBackupInline: () => dashboard(),
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
    req.on('end', async () => {
      try {
        if (!api[fn]) throw new Error('unknown function ' + fn);
        const arg = body ? JSON.parse(body) : undefined;
        const out = await api[fn](arg);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out === undefined ? null : out));
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
