/**
 * 인덱스 시트 행 생성과 검색 필터. 순수 함수.
 *
 * bodyPreview(본문 앞부분)는 마지막 열이며, 목록 조회 시에는 읽지 않고
 * 메일을 열 때만 해당 행에서 읽는다 (INDEX_LIST_COLUMNS 참고).
 */
var INDEX_HEADERS = [
  'id', 'threadId', 'date', 'category', 'agenda', 'labels', 'from', 'to', 'cc', 'subject', 'snippet',
  'sizeBytes', 'attachments', 'driveFileId', 'driveUrl', 'backedUpAt', 'bodyPreview',
];
var INDEX_LIST_COLUMNS = INDEX_HEADERS.length - 1; // bodyPreview 제외
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
  return [
    m.id, m.threadId || '', isoOf(m.date), m.category, m.agenda || '', (m.labelNames || []).join(', '),
    h.from || '', h.to || '', h.cc || '', h.subject || '', m.snippet || '',
    Number(m.sizeEstimate || 0), (m.attachmentNames || []).join('; '),
    m.driveFileId || '', m.driveUrl || '', isoOf(m.backedUpAt), body,
  ];
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
 * @param {{q?:string, category?:string, agenda?:string, folder?:string, from?:string,
 *          dateFrom?:string, dateTo?:string, backedUpFrom?:string, backedUpTo?:string}} f
 *   folder: 'inbox' | 'sent' | 'attachments'
 */
function filterRecords(records, f) {
  f = f || {};
  var q = lc(f.q).trim();
  var from = lc(f.from).trim();
  var cat = f.category ? String(f.category) : '';
  var agenda = f.agenda ? String(f.agenda) : '';
  var folder = f.folder ? String(f.folder) : '';
  var dFrom = f.dateFrom ? String(f.dateFrom).slice(0, 10) : '';
  var dTo = f.dateTo ? String(f.dateTo).slice(0, 10) : '';
  var bFrom = f.backedUpFrom ? String(f.backedUpFrom) : '';
  var bTo = f.backedUpTo ? String(f.backedUpTo) : '';
  var out = records.filter(function (r) {
    if (cat && r.category !== cat) return false;
    if (agenda && r.agenda !== agenda) return false;
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
    if (q) {
      var hay = [r.subject, r.from, r.to, r.cc, r.snippet, r.labels, r.attachments, r.agenda].map(lc).join(' | ');
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
  out.sort(function (a, b) { return String(b.date) < String(a.date) ? -1 : String(b.date) > String(a.date) ? 1 : 0; });
  return out;
}

/**
 * 인덱스 전체 요약: 건수, 총 용량, 가장 오래된/최신 메일, 마지막 백업 시각,
 * 수신/발신/첨부 건수, 카테고리별·안건별 건수.
 */
function summarizeRecords(records) {
  var s = { total: 0, totalBytes: 0, oldestDate: null, newestDate: null, lastBackedUpAt: null,
    sentCount: 0, receivedCount: 0, withAttachments: 0, categories: [], agendas: [] };
  var cats = {}, agendas = {};
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
    if (r.agenda) {
      if (!agendas[r.agenda]) agendas[r.agenda] = { name: r.agenda, count: 0 };
      agendas[r.agenda].count += 1;
    }
  }
  s.categories = Object.keys(cats).sort().map(function (k) { return cats[k]; });
  s.agendas = Object.keys(agendas).sort().map(function (k) { return agendas[k]; });
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
    INDEX_HEADERS: INDEX_HEADERS, INDEX_LIST_COLUMNS: INDEX_LIST_COLUMNS, headersFromPayload: headersFromPayload,
    buildIndexRow: buildIndexRow, rowToRecord: rowToRecord, filterRecords: filterRecords,
    summarizeRecords: summarizeRecords, decodeBase64Url: decodeBase64Url,
  };
}
