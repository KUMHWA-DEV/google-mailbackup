#!/usr/bin/env node
/**
 * Mail Backup MCP 서버 (stdio).
 * 본인 Google 계정(읽기 전용)으로 Drive의 인덱스 시트와 백업 파일을 읽어 AI가 메일·첨부를 검색하게 한다.
 *
 *  준비: GCP OAuth 클라이언트(데스크톱 앱) JSON 을 MAIL_BACKUP_OAUTH_CLIENT 로 지정 (README 7 참고)
 *  첫 실행 시 브라우저 로그인 → 토큰은 ~/.config/mail-backup-mcp/token.json 에 저장
 *
 *  도구: search_mail, get_mail, get_mail_raw, get_attachment_text, download_attachment, backup_stats, list_labels
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { google } = require('googleapis');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { rowsToRecords, searchRecords, compactRecord, textKind, truncateText, summarizeRecords } = require('./lib.js');
const { parseAttachmentFiles } = require('../src/lib/index_row.js');

const SCRIPT_ID = process.env.MAIL_BACKUP_SCRIPT_ID || ''; // 설정되면 Apps Script API 실행 도구(백업 실행·설정)도 켠다
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.file'];
// Apps Script API로 스크립트 함수를 실행하려면 스크립트가 요구하는 스코프를 토큰이 모두 가져야 한다 (appsscript.json과 동일)
const SCRIPT_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.addons.execute', 'https://www.googleapis.com/auth/gmail.addons.current.message.metadata', 'https://www.googleapis.com/auth/script.locale',
  'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/script.scriptapp', 'https://www.googleapis.com/auth/script.send_mail', 'https://www.googleapis.com/auth/userinfo.email'];
const ALL_SCOPES = SCRIPT_ID ? SCOPES.concat(SCRIPT_SCOPES) : SCOPES;
const CONFIG_DIR = process.env.MAIL_BACKUP_MCP_DIR || path.join(os.homedir(), '.config', 'mail-backup-mcp');
const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json');
// OAuth 클라이언트(데스크톱 앱) 찾는 순서: 환경변수 JSON 본문 → 환경변수 경로 → ~/.config → 패키지에 동봉된 mcp/oauth_client.json
const BUNDLED_CLIENT = path.join(__dirname, 'oauth_client.json');
const CLIENT_PATH = process.env.MAIL_BACKUP_OAUTH_CLIENT || [path.join(CONFIG_DIR, 'oauth_client.json'), BUNDLED_CLIENT].find(p => fs.existsSync(p)) || path.join(CONFIG_DIR, 'oauth_client.json');
const INDEX_SHEET_NAME = 'Mail Backup Index';
const CACHE_TTL_MS = 5 * 60 * 1000;
const DOWNLOAD_DIR = process.env.MAIL_BACKUP_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'mail-backup');

const log = (...a) => console.error('[mail-backup-mcp]', ...a);

// ---------- auth ----------
async function getAuth(onUrl) {
  let raw;
  if (process.env.MAIL_BACKUP_OAUTH_JSON) {
    const v = process.env.MAIL_BACKUP_OAUTH_JSON.trim();
    raw = JSON.parse(v.startsWith('{') ? v : Buffer.from(v, 'base64').toString('utf8'));
    try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(path.join(CONFIG_DIR, 'oauth_client.json'), JSON.stringify(raw, null, 2), { mode: 0o600 }); } catch (e) { /* 저장 실패는 무시 */ }
  } else {
    if (!fs.existsSync(CLIENT_PATH)) {
      throw new Error(`OAuth 클라이언트 파일이 없습니다: ${CLIENT_PATH}\n웹앱 'AI 연결' 탭에서 OAuth 파일을 내려받아 ${path.join(CONFIG_DIR, 'oauth_client.json')} 에 두거나, 환경변수 MAIL_BACKUP_OAUTH_JSON 에 내용을 넣으세요.`);
    }
    raw = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8'));
  }
  const c = raw.installed || raw.web || raw;
  const oauth = new google.auth.OAuth2(c.client_id, c.client_secret, 'http://127.0.0.1');
  if (fs.existsSync(TOKEN_PATH)) {
    oauth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
    oauth.on('tokens', t => saveToken({ ...oauth.credentials, ...t }));
    return oauth;
  }
  return await loginInteractive(oauth, onUrl);
}
function saveToken(t) { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2), { mode: 0o600 }); }
function loginInteractive(oauth, onUrl) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }
        const code = u.searchParams.get('code');
        if (!code) { res.writeHead(400); res.end('no code'); return; }
        const { tokens } = await oauth.getToken(code);
        oauth.setCredentials(tokens); saveToken(tokens);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<h2>Mail Backup MCP 로그인 완료. 이 창을 닫으세요.</h2>');
        server.close(); resolve(oauth);
      } catch (e) { res.writeHead(500); res.end(String(e.message)); server.close(); reject(e); }
    });
    // 고정 포트(기본 51234)를 먼저 시도한다. "데스크톱 앱" 클라이언트는 127.0.0.1의 어떤 포트든 허용되지만,
    // 관리자가 실수로 "웹 애플리케이션" 유형으로 만들었으면 콘솔에 http://127.0.0.1:51234 를 리디렉션 URI로 등록해 두면 동작한다.
    const FIXED_PORT = Number(process.env.MAIL_BACKUP_OAUTH_PORT) || 51234;
    server.on('error', (e) => { if (e.code === 'EADDRINUSE' && !server.listening) { log(`포트 ${FIXED_PORT} 사용 중 → 임의 포트로 대체`); server.listen(0, '127.0.0.1'); } else reject(e); });
    server.on('listening', () => {
      oauth.redirectUri = `http://127.0.0.1:${server.address().port}`;
      const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ALL_SCOPES });
      log('브라우저에서 로그인하세요:', url);
      if (onUrl) onUrl(url);
      log(`redirect_uri_mismatch(400)가 뜨면: GCP 콘솔의 OAuth 클라이언트가 "데스크톱 앱" 유형인지 확인하세요. "웹 애플리케이션" 유형이면 승인된 리디렉션 URI에 ${oauth.redirectUri} 를 추가하거나 데스크톱 앱으로 새로 만드세요.`);
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
      if (!process.env.MAIL_BACKUP_NO_BROWSER) require('child_process').exec(`${opener} "${url}"`);
    });
    server.listen(FIXED_PORT, '127.0.0.1');
  });
}

// ---------- data ----------
let cache = { at: 0, records: null, sheetId: null };
async function findIndexSheetId(drive) {
  if (process.env.MAIL_BACKUP_SHEET_ID) return process.env.MAIL_BACKUP_SHEET_ID;
  const res = await drive.files.list({ q: `name = '${INDEX_SHEET_NAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`, fields: 'files(id,name,modifiedTime)', orderBy: 'modifiedTime desc', pageSize: 5 });
  const f = (res.data.files || [])[0];
  if (!f) throw new Error(`Drive에서 '${INDEX_SHEET_NAME}' 시트를 찾지 못했습니다. 웹앱에서 백업을 한 번 실행했는지 확인하세요. (MAIL_BACKUP_SHEET_ID 로 직접 지정 가능)`);
  return f.id;
}
async function loadRecords(ctx, force) {
  if (cache.at === Infinity) return cache.records;
  if (!force && cache.records && Date.now() - cache.at < CACHE_TTL_MS) return cache.records;
  const sheetId = cache.sheetId || await findIndexSheetId(ctx.drive);
  const res = await ctx.sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'A:Z', valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' });
  const records = rowsToRecords(res.data.values || []);
  cache = { at: Date.now(), records, sheetId };
  return records;
}
async function findRecord(ctx, id) {
  const recs = await loadRecords(ctx);
  return recs.find(r => String(r.id) === String(id)) || (await loadRecords(ctx, true)).find(r => String(r.id) === String(id)) || null;
}
async function driveMeta(ctx, fileId) {
  const r = await ctx.drive.files.get({ fileId, fields: 'id,name,mimeType,size,webViewLink' });
  return r.data;
}
async function downloadBuffer(ctx, fileId) {
  const r = await ctx.drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(r.data);
}
/** PDF/DOCX/XLSX 등을 Google 문서로 임시 변환해 텍스트를 뽑고, 사본은 삭제한다. */
async function convertToText(ctx, fileId, kind) {
  const targetMime = kind === 'convert-sheet' ? 'application/vnd.google-apps.spreadsheet' : 'application/vnd.google-apps.document';
  const exportMime = kind === 'convert-sheet' ? 'text/csv' : 'text/plain';
  const copy = await ctx.drive.files.copy({ fileId, requestBody: { mimeType: targetMime, name: `_mcp_tmp_${Date.now()}` }, fields: 'id' });
  try {
    const out = await ctx.drive.files.export({ fileId: copy.data.id, mimeType: exportMime }, { responseType: 'arraybuffer' });
    return Buffer.from(out.data).toString('utf8');
  } finally {
    try { await ctx.drive.files.delete({ fileId: copy.data.id }); } catch (e) { log('임시 사본 삭제 실패', e.message); }
  }
}
const j = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

/** Apps Script API로 웹앱과 같은 서버 함수를 실행한다 (호출자 계정 = 웹앱 사용자와 동일한 사용자별 상태). */
async function runScript(ctx, fn, args) {
  if (!ctx.script) throw new Error('MAIL_BACKUP_SCRIPT_ID 가 설정되지 않아 백업 실행/설정 도구를 쓸 수 없습니다 (README 7-2)');
  const res = await ctx.script.scripts.run({ scriptId: SCRIPT_ID, requestBody: { function: fn, parameters: args || [], devMode: false } });
  if (res.data.error) { const d = res.data.error.details && res.data.error.details[0]; throw new Error((d && d.errorMessage) || JSON.stringify(res.data.error)); }
  return res.data.response ? res.data.response.result : null;
}
const slimDashboard = (d) => d && ({ state: d.state, message: d.message, user: d.user, lastSyncAt: d.lastSyncAt, schedule: d.schedule, currentRun: d.currentRun, triggerInstalled: d.triggerInstalled, settings: d.settings, summary: d.summary, folderUrl: d.folderUrl, indexSheetUrl: d.indexSheetUrl, webAppUrl: d.webAppUrl, lastError: d.lastError });
const err = (msg) => ({ content: [{ type: 'text', text: `오류: ${msg}` }], isError: true });

// ---------- server ----------
async function main() {
  let ctx;
  if (process.env.MAIL_BACKUP_FIXTURE) {
    // 로컬 테스트/데모: Google 없이 JSON 레코드로 동작 (첨부·원문 도구는 사용 불가)
    const recs = JSON.parse(fs.readFileSync(process.env.MAIL_BACKUP_FIXTURE, 'utf8'));
    cache = { at: Infinity, records: recs, sheetId: 'fixture' };
    const off = async () => { throw new Error('fixture 모드에서는 Drive 파일을 읽을 수 없습니다'); };
    ctx = { drive: { files: { get: off, copy: off, export: off, delete: off, list: off } }, sheets: { spreadsheets: { values: { get: off } } } };
  } else {
    // 토큰이 이미 있으면 바로 연결. 없으면 서버는 즉시 뜨고(앱이 타임아웃되지 않게), 첫 도구 호출 때 브라우저 로그인을 시작한다.
    const build = (auth) => ({ drive: google.drive({ version: 'v3', auth }), sheets: google.sheets({ version: 'v4', auth }), script: SCRIPT_ID ? google.script({ version: 'v1', auth }) : null });
    if (fs.existsSync(TOKEN_PATH)) {
      ctx = build(await getAuth());
    } else {
      const st = { real: null, pending: null, url: null };
      const need = () => {
        if (st.real) return st.real;
        if (!st.pending) st.pending = getAuth(u => { st.url = u; }).then(a => { st.real = build(a); log('로그인 완료'); return st.real; }).catch(e => { st.pending = null; log('로그인 실패:', e.message); throw e; });
        throw new Error('로그인이 필요합니다. 브라우저에 열린 Google 로그인 창에서 회사 계정으로 로그인한 뒤 다시 질문하세요.' + (st.url ? ' 창이 안 열렸으면 이 주소를 여세요: ' + st.url : ' (로그인 창을 여는 중입니다. 잠시 후 다시 시도하세요)'));
      };
      ctx = { get drive() { return need().drive; }, get sheets() { return need().sheets; }, get script() { return need().script; } };
    }
  }
  const server = new McpServer({ name: 'mail-backup', version: '1.0.0' });

  server.registerTool('search_mail', {
    title: '백업 메일 검색',
    description: `백업된 메일을 검색한다. query는 Gmail식 문법: 자유 단어(AND), "구문", -제외, from: to: cc: subject: label: filename: has:attachment in:inbox|sent|drafts is:starred after:YYYY-MM-DD before:YYYY-MM-DD larger:1M smaller:500K. 예: 'from:partner.co.kr 계약서 has:attachment after:2026-08-01'. 결과는 최신순, 본문은 get_mail로.`,
    inputSchema: { query: z.string().default(''), folder: z.enum(['all', 'inbox', 'sent', 'attachments', 'starred']).default('all'), category: z.string().optional().describe('라벨/Drive 폴더명으로 한정'), limit: z.number().int().min(1).max(200).default(20), offset: z.number().int().min(0).default(0) },
  }, async (a) => { try { return j(searchRecords(await loadRecords(ctx), a)); } catch (e) { return err(e.message); } });

  server.registerTool('get_mail', {
    title: '메일 상세',
    description: '메일 1건의 메타데이터, 본문 미리보기(저장 시 최대 20,000자), 첨부 목록(fileId 포함)을 돌려준다. 전체 원문은 get_mail_raw.',
    inputSchema: { id: z.string().describe('search_mail 결과의 id'), maxBodyChars: z.number().int().min(100).max(20000).default(8000) },
  }, async ({ id, maxBodyChars }) => {
    try { const r = await findRecord(ctx, id); if (!r) return err('해당 id의 메일이 인덱스에 없습니다: ' + id); const body = truncateText(r.bodyPreview, maxBodyChars); return j({ ...compactRecord(r), body: body.text, bodyTruncated: body.truncated }); } catch (e) { return err(e.message); }
  });

  server.registerTool('get_mail_raw', {
    title: '메일 원문(.eml)',
    description: 'Drive에 저장된 .eml 원문(헤더+본문+HTML+첨부 인코딩 포함)을 텍스트로 돌려준다. 크면 잘린다.',
    inputSchema: { id: z.string(), maxChars: z.number().int().min(1000).max(200000).default(60000) },
  }, async ({ id, maxChars }) => {
    try { const r = await findRecord(ctx, id); if (!r || !r.driveFileId) return err('원문 파일 ID가 없습니다'); const buf = await downloadBuffer(ctx, r.driveFileId); const t = truncateText(buf.toString('utf8'), maxChars); return j({ id, driveUrl: r.driveUrl, ...t }); } catch (e) { return err(e.message); }
  });

  server.registerTool('get_attachment_text', {
    title: '첨부 텍스트 추출',
    description: '첨부파일의 텍스트를 돌려준다. txt/csv/json은 그대로, PDF/DOCX/PPTX는 Google 문서로 임시 변환(OCR 포함), XLSX는 CSV로. 이미지·압축 등은 download_attachment 사용.',
    inputSchema: { fileId: z.string().describe('get_mail 첨부 목록의 fileId'), maxChars: z.number().int().min(1000).max(200000).default(40000) },
  }, async ({ fileId, maxChars }) => {
    try {
      const meta = await driveMeta(ctx, fileId);
      const kind = textKind(meta.mimeType, meta.name);
      if (kind === 'binary') return j({ fileId, name: meta.name, mimeType: meta.mimeType, size: Number(meta.size) || 0, text: null, note: '텍스트로 변환할 수 없는 형식입니다. download_attachment로 받으세요.', driveUrl: meta.webViewLink });
      const text = kind === 'text' ? (await downloadBuffer(ctx, fileId)).toString('utf8') : await convertToText(ctx, fileId, kind);
      return j({ fileId, name: meta.name, mimeType: meta.mimeType, size: Number(meta.size) || 0, method: kind, ...truncateText(text, maxChars) });
    } catch (e) { return err(e.message); }
  });

  server.registerTool('download_attachment', {
    title: '첨부 다운로드',
    description: `첨부파일(또는 .eml)을 로컬에 저장하고 경로를 돌려준다. 기본 폴더: ${DOWNLOAD_DIR}`,
    inputSchema: { fileId: z.string(), dir: z.string().optional() },
  }, async ({ fileId, dir }) => {
    try { const meta = await driveMeta(ctx, fileId); const buf = await downloadBuffer(ctx, fileId); const d = dir || DOWNLOAD_DIR; fs.mkdirSync(d, { recursive: true }); const p = path.join(d, meta.name.replace(/[\\/:*?"<>|]/g, '_')); fs.writeFileSync(p, buf); return j({ path: p, name: meta.name, mimeType: meta.mimeType, size: buf.length }); } catch (e) { return err(e.message); }
  });

  server.registerTool('backup_stats', {
    title: '백업 현황',
    description: '보관 메일 수, 용량, 기간, 라벨별 건수.',
    inputSchema: { refresh: z.boolean().default(false) },
  }, async ({ refresh }) => { try { return j(summarizeRecords(await loadRecords(ctx, refresh))); } catch (e) { return err(e.message); } });

  server.registerTool('list_labels', {
    title: '라벨·보낸사람 목록',
    description: '검색에 쓸 수 있는 라벨(Drive 폴더)과 보낸사람 상위 목록.',
    inputSchema: {},
  }, async () => {
    try {
      const recs = await loadRecords(ctx); const s = summarizeRecords(recs); const senders = {};
      recs.forEach(r => { const k = String(r.from || '').replace(/<.*>/, '').trim() || r.from; if (k) senders[k] = (senders[k] || 0) + 1; });
      return j({ labels: s.categories, senders: Object.entries(senders).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count })) });
    } catch (e) { return err(e.message); }
  });

  // ---- 백업 실행·설정 (Apps Script API, MAIL_BACKUP_SCRIPT_ID 필요) ----
  server.registerTool('backup_status', {
    title: '백업 상태', description: '상태(최신/백업 필요/진행 중 n/m), 마지막·다음 백업, 자동 백업 여부, 설정, 보관 현황. 진행 중이면 processed/expectedTotal/progress.',
    inputSchema: {},
  }, async () => { try { return j(slimDashboard(await runScript(ctx, 'getDashboard'))); } catch (e) { return err(e.message); } });
  server.registerTool('backup_history', {
    title: '백업 실행 이력', description: '최근 12회 실행: 시작/종료, 감지/신규/중복/오류, 용량, 메일 기간, 라벨별 분포, 수동/자동, 알림.',
    inputSchema: {},
  }, async () => { try { const d = await runScript(ctx, 'getDashboard'); return j({ running: d.state === 'running' || d.state === 'queued' ? d.currentRun : null, history: d.history || [] }); } catch (e) { return err(e.message); } });
  server.registerTool('backup_preview', {
    title: '백업 감지', description: '저장 전에 대상 메일을 감지한다: 새 메일 수, 용량, 기간, 라벨별·보낸사람별. scope: incremental(마지막 이후) | all(전체) | since(sinceDate부터).',
    inputSchema: { scope: z.enum(['incremental', 'all', 'since']).optional(), sinceDate: z.string().optional().describe('YYYY-MM-DD') },
  }, async (a) => { try { return j(await runScript(ctx, 'previewBackup', [{ scope: a.scope, sinceDate: a.sinceDate }])); } catch (e) { return err(e.message); } });
  server.registerTool('backup_run', {
    title: '백업 실행', description: '감지 후 백그라운드 백업을 시작한다(5초 뒤 트리거, 창 없이 진행). 진행 상황은 backup_status로. scope 생략 시 마지막 백업 이후(첫 백업이면 전체).',
    inputSchema: { scope: z.enum(['incremental', 'all', 'since']).optional(), sinceDate: z.string().optional() },
  }, async (a) => { try { const p = await runScript(ctx, 'previewBackup', [{ scope: a.scope, sinceDate: a.sinceDate }]); const d = await runScript(ctx, 'runBackupNow'); cache.at = 0; return j({ queued: true, expected: p.newCount, bytes: p.bytes, estimatedSeconds: p.estimatedSeconds, state: d.state, message: d.message }); } catch (e) { return err(e.message); } });
  server.registerTool('backup_settings_get', { title: '설정 조회', description: '주기, 시작일, 보낸편지함 포함, 첨부 저장, 회당 최대, 추가 검색 조건, 폴더, 폴더 기준, 하위 폴더, 알림.', inputSchema: {} },
    async () => { try { return j(await runScript(ctx, 'getSettings')); } catch (e) { return err(e.message); } });
  server.registerTool('backup_settings_set', {
    title: '설정 변경', description: '지정한 항목만 바꾼다. 주기를 바꾸면 자동 백업이 켜져 있을 때 일정이 갱신된다.',
    inputSchema: { intervalDays: z.number().int().min(1).optional(), initialStartDate: z.string().optional().describe('YYYY-MM-DD 또는 빈 문자열'), includeSent: z.boolean().optional(), saveAttachments: z.boolean().optional(), maxPerRun: z.number().int().min(0).optional(), filterQuery: z.string().optional(), folderId: z.string().optional(), folderLayout: z.enum(['flat', 'yearly', 'monthly']).optional(), splitGmailTabs: z.boolean().optional().describe('Gmail 탭(프로모션·소셜 등)을 별도 폴더로'), notifyEmail: z.string().optional(), notifyOnComplete: z.boolean().optional() },
  }, async (a) => { try { const cur = await runScript(ctx, 'getSettings'); const d = await runScript(ctx, 'saveSettings', [Object.assign({}, cur, a)]); return j(d.settings); } catch (e) { return err(e.message); } });
  server.registerTool('backup_auto', { title: '자동 백업 켜기/끄기', description: '설정한 주기마다 새벽 3시 자동 실행 트리거를 설치하거나 제거한다.', inputSchema: { enabled: z.boolean() } },
    async ({ enabled }) => { try { const d = await runScript(ctx, enabled ? 'installScheduledTrigger' : 'uninstallScheduledTrigger'); return j({ triggerInstalled: d.triggerInstalled, schedule: d.schedule }); } catch (e) { return err(e.message); } });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('ready');
}

main().catch(e => { log(e.message); process.exit(1); });
