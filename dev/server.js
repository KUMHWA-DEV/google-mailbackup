/**
 * 로컬 미리보기 서버.
 *  - src/index.html 을 그대로 서빙하되 google.script.run 을 흉내내는 shim을 주입한다.
 *  - 데이터는 dev/fixtures/index.json (샘플 인덱스) 을 사용하고, 검색 로직은 실제 순수 모듈을 쓴다.
 *  실행: npm run dev  →  http://localhost:8787
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { filterRecords } = require('../src/lib/index_row.js');

const PORT = Number(process.env.PORT) || 8787;
const ROOT = path.join(__dirname, '..');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'index.json'), 'utf8'));
let status = {
  state: 'idle', message: '로컬 미리보기 (샘플 데이터)', updatedAt: new Date().toISOString(),
  lastSyncAt: '2026-09-08T03:04:00.000Z', processed: 12, errors: 0, lastError: null,
  weeklyTriggerInstalled: false,
  folderUrl: 'https://drive.google.com/drive/folders/LOCAL', indexSheetUrl: 'https://docs.google.com/spreadsheets/d/LOCAL',
  user: 'kumhwa_dev@spris.com (local)',
};

const api = {
  getStatus: () => status,
  getCategories: () => {
    const seen = {};
    fixtures.forEach(r => { seen[r.category] = (seen[r.category] || 0) + 1; });
    return Object.keys(seen).sort().map(name => ({ name, count: seen[name] }));
  },
  searchMessages: (f = {}) => {
    const hits = filterRecords(fixtures, f);
    const pageSize = Math.max(1, Math.min(200, Number(f.pageSize) || 50));
    const page = Math.max(1, Number(f.page) || 1);
    return { total: hits.length, page, pageSize, items: hits.slice((page - 1) * pageSize, page * pageSize) };
  },
  runBackupNow: () => {
    status = { ...status, state: 'queued', message: '수동 실행 요청됨 (로컬에서는 실제 실행 없음)', updatedAt: new Date().toISOString() };
    setTimeout(() => { status = { ...status, state: 'idle', message: '완료: 새로 0건 저장 (로컬 모의)', updatedAt: new Date().toISOString() }; }, 5000);
    return status;
  },
  installWeeklyTrigger: () => { status = { ...status, weeklyTriggerInstalled: true }; return status; },
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
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8').replace('<!-- DEV_SHIM -->', SHIM);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => {
  console.log(`Mail Backup 로컬 미리보기: http://localhost:${PORT}`);
});
