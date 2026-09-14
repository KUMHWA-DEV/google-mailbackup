/**
 * MCP 서버용 순수 로직 (Node). 인덱스 시트 행 → 레코드, 검색, 첨부 종류 판별.
 * 검색 문법은 웹앱과 같은 src/lib/search.js 를 그대로 쓴다.
 */
const { INDEX_HEADERS, rowToRecord, filterRecords, summarizeRecords, parseAttachmentFiles } = require('../src/lib/index_row.js');
const { parseSearch, matchSearch } = require('../src/lib/search.js');

/** 시트 값(첫 행 = 헤더)을 레코드 배열로. 헤더 이름 기준으로 매핑해 열 순서가 달라도 견딘다. */
function rowsToRecords(rows) {
  if (!rows || rows.length < 2) return [];
  const header = rows[0].map(h => String(h || '').trim());
  const idx = {};
  header.forEach((h, i) => { if (h) idx[h] = i; });
  const useHeader = INDEX_HEADERS.every(h => idx[h] != null);
  return rows.slice(1).filter(r => r && r.length && String(r[0] || '').trim()).map(r => {
    const rec = useHeader ? Object.fromEntries(INDEX_HEADERS.map(h => [h, r[idx[h]] == null ? '' : r[idx[h]]])) : rowToRecord(r);
    if (rec.sizeBytes !== '' && rec.sizeBytes != null) rec.sizeBytes = Number(rec.sizeBytes) || 0;
    ['date', 'backedUpAt'].forEach(k => { if (rec[k] instanceof Date) rec[k] = rec[k].toISOString(); else rec[k] = rec[k] == null ? '' : String(rec[k]); });
    return rec;
  });
}

function isSent(r) { return r.category === '보낸편지함' || /(^|,\s*)SENT(\s*,|$)/.test(String(r.labels || '')); }
function folderMatch(r, key) {
  if (!key || key === 'all') return true;
  if (key === 'sent') return isSent(r);
  if (key === 'inbox') return !isSent(r) && r.category !== '임시보관함';
  if (key === 'attachments') return !!String(r.attachments || '').trim();
  if (key === 'starred') return /(^|,\s*)STARRED(\s*,|$)/.test(String(r.labels || ''));
  return true;
}

/** @returns {{total:number, items:Object[], offset:number, limit:number}} */
function searchRecords(records, o) {
  o = o || {};
  const parsed = o.query ? parseSearch(o.query) : null;
  let hits = records.filter(r => folderMatch(r, o.folder) && (!parsed || matchSearch(r, parsed)));
  if (o.category) hits = hits.filter(r => r.category === o.category);
  hits.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const limit = Math.max(1, Math.min(200, Number(o.limit) || 20));
  const offset = Math.max(0, Number(o.offset) || 0);
  return { total: hits.length, offset, limit, items: hits.slice(offset, offset + limit).map(compactRecord) };
}

/** AI에 돌려줄 요약 레코드 (본문 제외, 첨부는 구조화). */
function compactRecord(r) {
  return {
    id: r.id, date: r.date, category: r.category, labels: r.labels,
    from: r.from, to: r.to, cc: r.cc || undefined, subject: r.subject, snippet: r.snippet,
    sizeBytes: Number(r.sizeBytes) || 0,
    attachments: parseAttachmentFiles(r),
    driveFileId: r.driveFileId || undefined, driveUrl: r.driveUrl || undefined, backedUpAt: r.backedUpAt,
  };
}

const TEXT_EXT = /\.(txt|csv|tsv|md|json|xml|html?|log|ics|eml|yaml|yml)$/i;
const CONVERT_EXT = /\.(pdf|docx?|rtf|odt|pptx?|hwpx?)$/i;
const SHEET_EXT = /\.(xlsx?|ods)$/i;
/** 'text' 그대로 읽기 | 'convert' Google Docs 변환 후 텍스트 | 'convert-sheet' Google Sheets 변환 후 CSV | 'binary' */
function textKind(mime, name) {
  mime = String(mime || ''); name = String(name || '');
  if (/^text\//.test(mime) || /^application\/(json|xml|csv)$/.test(mime) || TEXT_EXT.test(name)) return 'text';
  if (/spreadsheet|excel/.test(mime) || SHEET_EXT.test(name)) return 'convert-sheet';
  if (/pdf|word|rtf|presentation|powerpoint|opendocument/.test(mime) || CONVERT_EXT.test(name)) return 'convert';
  return 'binary';
}

function truncateText(s, max) {
  s = String(s == null ? '' : s);
  max = max || 60000;
  return { text: s.length > max ? s.slice(0, max) : s, truncated: s.length > max, total: s.length };
}

module.exports = { rowsToRecords, searchRecords, compactRecord, textKind, truncateText, summarizeRecords, filterRecords, isSent };
