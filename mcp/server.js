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

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.file'];
const CONFIG_DIR = process.env.MAIL_BACKUP_MCP_DIR || path.join(os.homedir(), '.config', 'mail-backup-mcp');
const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json');
const CLIENT_PATH = process.env.MAIL_BACKUP_OAUTH_CLIENT || path.join(CONFIG_DIR, 'oauth_client.json');
const INDEX_SHEET_NAME = 'Mail Backup Index';
const CACHE_TTL_MS = 5 * 60 * 1000;
const DOWNLOAD_DIR = process.env.MAIL_BACKUP_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'mail-backup');

const log = (...a) => console.error('[mail-backup-mcp]', ...a);

// ---------- auth ----------
async function getAuth() {
  if (!fs.existsSync(CLIENT_PATH)) {
    throw new Error(`OAuth 클라이언트 파일이 없습니다: ${CLIENT_PATH}\nGCP 콘솔에서 '데스크톱 앱' OAuth 클라이언트를 만들어 JSON을 내려받고 그 경로를 MAIL_BACKUP_OAUTH_CLIENT 로 지정하세요 (README 7).`);
  }
  const raw = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8'));
  const c = raw.installed || raw.web || raw;
  const oauth = new google.auth.OAuth2(c.client_id, c.client_secret, 'http://127.0.0.1');
  if (fs.existsSync(TOKEN_PATH)) {
    oauth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
    oauth.on('tokens', t => saveToken({ ...oauth.credentials, ...t }));
    return oauth;
  }
  return await loginInteractive(oauth);
}
function saveToken(t) { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2), { mode: 0o600 }); }
function loginInteractive(oauth) {
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
    }).listen(0, '127.0.0.1', () => {
      oauth.redirectUri = `http://127.0.0.1:${server.address().port}`;
      const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
      log('브라우저에서 로그인하세요:', url);
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
      require('child_process').exec(`${opener} "${url}"`);
    });
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
    const auth = await getAuth();
    ctx = { drive: google.drive({ version: 'v3', auth }), sheets: google.sheets({ version: 'v4', auth }) };
  }
  const server = new McpServer({ name: 'mail-backup', version: '1.0.0' });

  server.registerTool('search_mail', {
    title: '백업 메일 검색',
    description: `백업된 메일을 검색한다. query는 Gmail식 문법: 자유 단어(AND), "구문", -제외, from: to: cc: subject: label: agenda: filename: has:attachment in:inbox|sent|drafts is:important after:YYYY-MM-DD before:YYYY-MM-DD larger:1M smaller:500K. 예: 'from:partner.co.kr 계약서 has:attachment after:2026-08-01'. 결과는 최신순, 본문은 get_mail로.`,
    inputSchema: { query: z.string().default(''), folder: z.enum(['all', 'inbox', 'sent', 'attachments', 'starred']).default('all'), category: z.string().optional().describe('라벨/Drive 폴더명으로 한정'), agenda: z.string().optional().describe('안건 분류로 한정'), limit: z.number().int().min(1).max(200).default(20), offset: z.number().int().min(0).default(0) },
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
    description: '보관 메일 수, 용량, 기간, 라벨별·안건별 건수.',
    inputSchema: { refresh: z.boolean().default(false) },
  }, async ({ refresh }) => { try { return j(summarizeRecords(await loadRecords(ctx, refresh))); } catch (e) { return err(e.message); } });

  server.registerTool('list_labels', {
    title: '라벨·안건·보낸사람 목록',
    description: '검색에 쓸 수 있는 라벨(Drive 폴더), 안건 분류, 보낸사람 상위 목록.',
    inputSchema: {},
  }, async () => {
    try {
      const recs = await loadRecords(ctx); const s = summarizeRecords(recs); const senders = {};
      recs.forEach(r => { const k = String(r.from || '').replace(/<.*>/, '').trim() || r.from; if (k) senders[k] = (senders[k] || 0) + 1; });
      return j({ labels: s.categories, agendas: s.agendas, senders: Object.entries(senders).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count })) });
    } catch (e) { return err(e.message); }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('ready');
}

main().catch(e => { log(e.message); process.exit(1); });
