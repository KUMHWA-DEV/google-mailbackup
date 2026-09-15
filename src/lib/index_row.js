/**
 * 인덱스 시트 행 생성과 검색 필터. 순수 함수.
 *
 * bodyPreview(본문 앞부분)는 마지막 열이며, 목록 조회 시에는 읽지 않고
 * 메일을 열 때만 해당 행에서 읽는다 (INDEX_LIST_COLUMNS 참고).
 */
var INDEX_HEADERS = [
  'id', 'threadId', 'date', 'category', 'agenda' /* 예전 안건 열, 항상 빈 값 (기존 시트 호환) */, 'labels', 'from', 'to', 'cc', 'subject', 'snippet',
  'sizeBytes', 'attachments', 'attachmentFiles', 'driveFileId', 'driveUrl', 'backedUpAt', 'bodyPreview',
];
var INDEX_LIST_COLUMNS = INDEX_HEADERS.length - 1; // bodyPreview 제외

// Node에서는 search.js를 명시적으로 불러온다 (Apps Script에서는 전역으로 이미 존재).
if (typeof module !== 'undefined' && typeof parseSearch === 'undefined') {
  var searchLib_ = require('./search.js');
  var parseSearch = searchLib_.parseSearch, matchSearch = searchLib_.matchSearch, setSearchAliases = searchLib_.setSearchAliases;
}
var BODY_PREVIEW_MAX = 20000;

function headersFromPayload(payload) {
  var out = {};
  if (!payload || !payload.headers) return out;
  for (var i = 0; i < payload.headers.length; i++) {
    var h = payload.headers[i];
    out[String(h.name).toLowerCase()] = h.value == null ? '' : String(h.value);
  }
  return out;
}

function isoOf(d) {
  if (d instanceof Date) return d.toISOString();
  return d == null ? '' : String(d);
}

function buildIndexRow(m) {
  var h = m.headers || {};
  var body = String(m.bodyPreview || '');
  if (body.length > BODY_PREVIEW_MAX) body = body.slice(0, BODY_PREVIEW_MAX) + '\n…(생략)';
  return sheetSafeRow([
    m.id, m.threadId || '', isoOf(m.date), m.category, '', (m.labelNames || []).join(', '),
    h.from || '', h.to || '', h.cc || '', h.subject || '', m.snippet || '',
    Number(m.sizeEstimate || 0), (m.attachmentNames || []).join('; '),
    (m.attachmentFiles && m.attachmentFiles.length) ? JSON.stringify(m.attachmentFiles) : '',
    m.driveFileId || '', m.driveUrl || '', isoOf(m.backedUpAt), body,
  ]);
}
/** '=' 로 시작하는 문자열 셀은 시트가 수식으로 해석해 #ERROR! 가 되므로 앞에 작은따옴표를 붙여 텍스트로 고정한다 (읽을 때는 따옴표 없이 돌아옴) */
function sheetSafeCell(v) { return typeof v === 'string' && v.charAt(0) === '=' ? "'" + v : v; }
function sheetSafeRow(row) { return row.map(sheetSafeCell); }

/** 인덱스 레코드의 첨부 목록 [{name, fileId?, size?, mime?}]. JSON이 없으면 이름 목록으로 대체. */
function parseAttachmentFiles(rec) {
  var raw = rec && rec.attachmentFiles ? String(rec.attachmentFiles) : '';
  if (raw) {
    try { var arr = JSON.parse(raw); if (Array.isArray(arr)) return arr; } catch (e) { /* fall through */ }
  }
  var names = rec && rec.attachments ? String(rec.attachments).split(';') : [];
  return names.map(function (n) { return n.trim(); }).filter(Boolean).map(function (n) { return { name: n }; });
}

/** Drive 파일 직접 다운로드 URL (해당 파일에 접근 권한이 있는 계정으로 로그인된 상태에서 동작). */
function driveDownloadUrl(fileId) {
  return fileId ? 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(String(fileId)) : '';
}

function rowToRecord(row) {
  var rec = {};
  for (var i = 0; i < INDEX_HEADERS.length; i++) if (i < row.length) rec[INDEX_HEADERS[i]] = row[i];
  return rec;
}

function lc(v) { return String(v == null ? '' : v).toLowerCase(); }
function isSent(r) { return r.category === '보낸편지함' || /(^|,\s*)SENT(\s*,|$)/.test(String(r.labels || '')); }

/**
 * @param {Object[]} records rowToRecord 결과 배열
 * @param {{q?:string, category?:string, folder?:string, from?:string,
 *          dateFrom?:string, dateTo?:string, backedUpFrom?:string, backedUpTo?:string}} f
 *   folder: 'inbox' | 'sent' | 'attachments'
 */
function filterRecords(records, f) {
  f = f || {};
  var q = lc(f.q).trim();
  var from = lc(f.from).trim();
  var cat = f.category ? String(f.category) : '';
  var folder = f.folder ? String(f.folder) : '';
  var dFrom = f.dateFrom ? String(f.dateFrom).slice(0, 10) : '';
  var dTo = f.dateTo ? String(f.dateTo).slice(0, 10) : '';
  var bFrom = f.backedUpFrom ? String(f.backedUpFrom) : '';
  var bTo = f.backedUpTo ? String(f.backedUpTo) : '';
  // q는 Gmail식 연산자(from: subject: has:attachment after: …)를 지원하는 search.js 파서로 처리한다.
  var parsed = (q && typeof parseSearch === 'function') ? parseSearch(f.q) : null;
  if (parsed && typeof setSearchAliases === 'function') setSearchAliases(records); // 같은 사람(이름/주소 변형) 묶음
  var out = records.filter(function (r) {
    if (cat && r.category !== cat) return false;
    if (folder === 'sent' && !isSent(r)) return false;
    if (folder === 'inbox' && isSent(r)) return false;
    if (folder === 'attachments' && !String(r.attachments || '').trim()) return false;
    if (from && lc(r.from).indexOf(from) < 0) return false;
    var day = String(r.date || '').slice(0, 10);
    if (dFrom && day < dFrom) return false;
    if (dTo && day > dTo) return false;
    var backed = String(r.backedUpAt || '');
    if (bFrom && backed < bFrom) return false;
    if (bTo && backed > bTo) return false;
    if (parsed) { if (!matchSearch(r, parsed)) return false; }
    else if (q) {
      var hay = [r.subject, r.from, r.to, r.cc, r.snippet, r.labels, r.attachments].map(lc).join(' | ');
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
  out.sort(function (a, b) { return String(b.date) < String(a.date) ? -1 : String(b.date) > String(a.date) ? 1 : 0; });
  return out;
}

/**
 * 인덱스 전체 요약: 건수, 총 용량, 가장 오래된/최신 메일, 마지막 백업 시각,
 * 수신/발신/첨부 건수, 카테고리별 건수.
 */
function summarizeRecords(records) {
  var s = { total: 0, totalBytes: 0, oldestDate: null, newestDate: null, lastBackedUpAt: null,
    sentCount: 0, receivedCount: 0, withAttachments: 0, categories: [] };
  var cats = {};
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var bytes = Number(r.sizeBytes) || 0;
    var date = r.date ? String(r.date) : '';
    var backed = r.backedUpAt ? String(r.backedUpAt) : '';
    s.total += 1;
    s.totalBytes += bytes;
    if (date && (!s.oldestDate || date < s.oldestDate)) s.oldestDate = date;
    if (date && (!s.newestDate || date > s.newestDate)) s.newestDate = date;
    if (backed && (!s.lastBackedUpAt || backed > s.lastBackedUpAt)) s.lastBackedUpAt = backed;
    if (isSent(r)) s.sentCount += 1; else s.receivedCount += 1;
    if (String(r.attachments || '').trim()) s.withAttachments += 1;
    var c = r.category || '(없음)';
    if (!cats[c]) cats[c] = { name: c, count: 0, bytes: 0 };
    cats[c].count += 1;
    cats[c].bytes += bytes;
  }
  s.categories = Object.keys(cats).sort().map(function (k) { return cats[k]; });
  return s;
}

/** URL-safe base64 -> UTF-8 문자열. Apps Script에서는 Utilities로, Node에서는 Buffer로. */
function decodeBase64Url(s) {
  var b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  if (typeof Utilities !== 'undefined' && Utilities.base64Decode) {
    return Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString('UTF-8');
  }
  return Buffer.from(b64, 'base64').toString('utf8');
}

if (typeof module !== 'undefined') {
  module.exports = {
    INDEX_HEADERS: INDEX_HEADERS, INDEX_LIST_COLUMNS: INDEX_LIST_COLUMNS, headersFromPayload: headersFromPayload, sheetSafeCell: sheetSafeCell,
    buildIndexRow: buildIndexRow, rowToRecord: rowToRecord, filterRecords: filterRecords,
    summarizeRecords: summarizeRecords, decodeBase64Url: decodeBase64Url,
    parseAttachmentFiles: parseAttachmentFiles, driveDownloadUrl: driveDownloadUrl,
  };
}
