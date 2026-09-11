/**
 * 인덱스 시트 행 생성과 검색 필터. 순수 함수.
 */
var INDEX_HEADERS = [
  'id', 'threadId', 'date', 'category', 'labels', 'from', 'to', 'cc', 'subject', 'snippet',
  'sizeBytes', 'attachments', 'driveFileId', 'driveUrl', 'backedUpAt',
];

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
  return [
    m.id, m.threadId || '', isoOf(m.date), m.category, (m.labelNames || []).join(', '),
    h.from || '', h.to || '', h.cc || '', h.subject || '', m.snippet || '',
    Number(m.sizeEstimate || 0), (m.attachmentNames || []).join('; '),
    m.driveFileId || '', m.driveUrl || '', isoOf(m.backedUpAt),
  ];
}

function rowToRecord(row) {
  var rec = {};
  for (var i = 0; i < INDEX_HEADERS.length; i++) rec[INDEX_HEADERS[i]] = row[i];
  return rec;
}

function lc(v) { return String(v == null ? '' : v).toLowerCase(); }

/**
 * @param {Object[]} records rowToRecord 결과 배열
 * @param {{q?:string, category?:string, from?:string, dateFrom?:string, dateTo?:string}} f
 */
function filterRecords(records, f) {
  f = f || {};
  var q = lc(f.q).trim();
  var from = lc(f.from).trim();
  var cat = f.category ? String(f.category) : '';
  var dFrom = f.dateFrom ? String(f.dateFrom).slice(0, 10) : '';
  var dTo = f.dateTo ? String(f.dateTo).slice(0, 10) : '';
  var out = records.filter(function (r) {
    if (cat && r.category !== cat) return false;
    if (from && lc(r.from).indexOf(from) < 0) return false;
    var day = String(r.date || '').slice(0, 10);
    if (dFrom && day < dFrom) return false;
    if (dTo && day > dTo) return false;
    if (q) {
      var hay = [r.subject, r.from, r.to, r.cc, r.snippet, r.labels, r.attachments].map(lc).join(' | ');
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
  out.sort(function (a, b) { return String(b.date) < String(a.date) ? -1 : String(b.date) > String(a.date) ? 1 : 0; });
  return out;
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
    INDEX_HEADERS: INDEX_HEADERS, headersFromPayload: headersFromPayload, buildIndexRow: buildIndexRow,
    rowToRecord: rowToRecord, filterRecords: filterRecords, decodeBase64Url: decodeBase64Url,
  };
}
