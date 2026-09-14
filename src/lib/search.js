/**
 * Gmail식 검색 쿼리 파서와 매처. 순수 함수. 서버(Apps Script)와 클라이언트(웹앱) 양쪽에서 같은 코드를 쓴다.
 * 클라이언트에는 webapp.js의 searchClientLib_()가 아래 함수들의 소스를 그대로 넣어 준다.
 *
 * 지원 연산자: from: to: cc: subject: label: agenda: filename: has:attachment in:(inbox|sent|drafts|anywhere)
 *              is:(starred|important) after: before: newer: older: larger: smaller:   "구문"   -제외
 */
function parseSize(s) {
  var m = String(s == null ? '' : s).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/);
  if (!m) return null;
  var n = parseFloat(m[1]);
  var mult = { '': 1, k: 1024, m: 1048576, g: 1073741824 }[m[2]];
  return Math.round(n * mult);
}

function normDate_(s) {
  var m = String(s || '').match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (!m) return null;
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

function tokenize_(q) {
  var out = [], re = /(-?)(?:([a-zA-Z]+):)?(?:"([^"]*)"|(\S+))/g, m;
  while ((m = re.exec(q)) !== null) {
    var val = m[3] != null ? m[3] : m[4];
    if (m[2] && m[4] && m[4].charAt(0) === '"') val = m[4];
    out.push({ neg: m[1] === '-', key: m[2] ? m[2].toLowerCase() : '', val: val });
  }
  return out;
}

var SEARCH_LIST_KEYS = { from: 1, to: 1, cc: 1, subject: 1, label: 1, agenda: 1, filename: 1 };

function parseSearch(q) {
  var p = { terms: [], not: [], from: [], to: [], cc: [], subject: [], label: [], agenda: [], filename: [],
    notFrom: [], notTo: [], notSubject: [], notLabel: [], hasAttachment: null, in: '', is: '', after: null, before: null, larger: null, smaller: null };
  tokenize_(String(q || '')).forEach(function (t) {
    var k = t.key, v = t.val;
    if (!k) { (t.neg ? p.not : p.terms).push(v); return; }
    if (SEARCH_LIST_KEYS[k]) {
      if (t.neg) { var nk = 'not' + k.charAt(0).toUpperCase() + k.slice(1); if (p[nk]) p[nk].push(v); else p.not.push(v); }
      else p[k].push(v);
      return;
    }
    if (k === 'has' && /^attach/i.test(v)) { p.hasAttachment = !t.neg; return; }
    if (k === 'in') { p.in = v.toLowerCase(); return; }
    if (k === 'is') { p.is = v.toLowerCase(); return; }
    if (k === 'after' || k === 'newer') { p.after = normDate_(v); return; }
    if (k === 'before' || k === 'older') { p.before = normDate_(v); return; }
    if (k === 'larger') { p.larger = parseSize(v); return; }
    if (k === 'smaller') { p.smaller = parseSize(v); return; }
    (t.neg ? p.not : p.terms).push(k + ':' + v);
  });
  return p;
}

function lc_(v) { return String(v == null ? '' : v).toLowerCase(); }
function anyIn_(hay, needles) { hay = lc_(hay); return needles.every(function (n) { return hay.indexOf(lc_(n)) >= 0; }); }
function noneIn_(hay, needles) { hay = lc_(hay); return needles.every(function (n) { return hay.indexOf(lc_(n)) < 0; }); }
function isSentRec_(r) { return r.category === '보낸편지함' || /(^|,\s*)SENT(\s*,|$)/.test(String(r.labels || '')); }

/** @param {Object} r 인덱스 레코드 @param {Object} p parseSearch 결과 */
function matchSearch(r, p) {
  if (!p) return true;
  var labels = String(r.labels || '') + ', ' + String(r.category || '');
  var atts = String(r.attachments || '');
  var hay = [r.subject, r.from, r.to, r.cc, r.snippet, labels, atts, r.agenda].join(' | ');
  if (p.terms.length && !anyIn_(hay, p.terms)) return false;
  if (p.not.length && !noneIn_(hay, p.not)) return false;
  if (p.from.length && !anyIn_(r.from, p.from)) return false;
  if (p.to.length && !anyIn_(r.to, p.to)) return false;
  if (p.cc.length && !anyIn_(r.cc, p.cc)) return false;
  if (p.subject.length && !anyIn_(r.subject, p.subject)) return false;
  if (p.label.length && !anyIn_(labels, p.label)) return false;
  if (p.agenda.length && !anyIn_(r.agenda, p.agenda)) return false;
  if (p.filename.length && !anyIn_(atts, p.filename)) return false;
  if (p.notFrom.length && !noneIn_(r.from, p.notFrom)) return false;
  if (p.notTo.length && !noneIn_(r.to, p.notTo)) return false;
  if (p.notSubject.length && !noneIn_(r.subject, p.notSubject)) return false;
  if (p.notLabel.length && !noneIn_(labels, p.notLabel)) return false;
  if (p.hasAttachment === true && !atts.trim()) return false;
  if (p.hasAttachment === false && atts.trim()) return false;
  if (p.in === 'sent' && !isSentRec_(r)) return false;
  if (p.in === 'inbox' && (isSentRec_(r) || r.category === '임시보관함')) return false;
  if ((p.in === 'drafts' || p.in === 'draft') && r.category !== '임시보관함') return false;
  if ((p.is === 'starred' || p.is === 'important') && !/(^|,\s*)(IMPORTANT|STARRED)(\s*,|$)/.test(String(r.labels || ''))) return false;
  var day = String(r.date || '').slice(0, 10);
  if (p.after && day < p.after) return false;
  if (p.before && day >= p.before) return false;
  var size = Number(r.sizeBytes) || 0;
  if (p.larger != null && size <= p.larger) return false;
  if (p.smaller != null && size >= p.smaller) return false;
  return true;
}

function quoteVal_(v) { v = String(v || '').trim(); return /\s/.test(v) ? '"' + v + '"' : v; }

/** 고급 검색 폼 → 검색 문자열 (Gmail이 검색창에 채우는 방식과 같음). */
function buildSearchQuery(f) {
  f = f || {};
  var parts = [];
  if (f.from) parts.push('from:' + quoteVal_(f.from));
  if (f.to) parts.push('to:' + quoteVal_(f.to));
  if (f.subject) parts.push('subject:' + quoteVal_(f.subject));
  if (f.words) parts.push(String(f.words).trim());
  if (f.not) String(f.not).trim().split(/\s+/).forEach(function (w) { if (w) parts.push('-' + w); });
  if (f.hasAttachment) parts.push('has:attachment');
  if (f.after) parts.push('after:' + f.after);
  if (f.before) parts.push('before:' + f.before);
  if (f.larger) parts.push('larger:' + f.larger);
  if (f.smaller) parts.push('smaller:' + f.smaller);
  if (f.label) parts.push('label:' + quoteVal_(f.label));
  if (f.agenda) parts.push('agenda:' + quoteVal_(f.agenda));
  if (f.in && f.in !== 'anywhere') parts.push('in:' + f.in);
  return parts.join(' ');
}

/** 클라이언트에 그대로 내보낼 함수 목록 (순서 중요: 의존 함수 먼저). */
var SEARCH_CLIENT_FUNCS = [parseSize, normDate_, tokenize_, parseSearch, lc_, anyIn_, noneIn_, isSentRec_, matchSearch, quoteVal_, buildSearchQuery];

if (typeof module !== 'undefined') {
  module.exports = { parseSearch: parseSearch, matchSearch: matchSearch, parseSize: parseSize, buildSearchQuery: buildSearchQuery, SEARCH_CLIENT_FUNCS: SEARCH_CLIENT_FUNCS, SEARCH_LIST_KEYS: SEARCH_LIST_KEYS };
}
