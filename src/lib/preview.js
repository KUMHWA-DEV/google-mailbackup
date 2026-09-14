/**
 * 백업 미리보기(감지) 집계와 실행 진행률 계산. 순수 함수.
 */
function addToBreakdown(map, name, bytes) {
  if (!name) return;
  if (!map[name]) map[name] = { name: name, count: 0, bytes: 0 };
  map[name].count += 1;
  map[name].bytes += Number(bytes) || 0;
}
function breakdownList(map) {
  return Object.keys(map || {}).map(function (k) { return map[k]; }).sort(function (a, b) { return b.count - a.count || b.bytes - a.bytes || String(a.name).localeCompare(String(b.name)); });
}

/**
 * @param {{found:number, skipped:number, newCount:number, detailed:number,
 *          metas:{category:string, sizeBytes:number, date:string, from?:string, hasAttachment?:boolean}[]}} o
 *   metas는 새 메일 중 상세를 읽은 표본(최대 detailed건). newCount > detailed면 비율로 추정한다.
 */
function aggregatePreview(o) {
  var metas = o.metas || [];
  var detailed = Number(o.detailed) || metas.length;
  var newCount = Number(o.newCount) || 0;
  var scale = (detailed > 0 && newCount > detailed) ? newCount / detailed : 1;
  var cats = {}, senders = {}, bytes = 0, from = null, to = null, att = 0;
  metas.forEach(function (m) {
    var b = Number(m.sizeBytes) || 0;
    bytes += b;
    addToBreakdown(cats, m.category, b);
    addToBreakdown(senders, m.from, b);
    if (m.hasAttachment) att += 1;
    var d = m.date ? String(m.date) : '';
    if (d && (!from || d < from)) from = d;
    if (d && (!to || d > to)) to = d;
  });
  var scaleList = function (list) { return list.map(function (c) { return { name: c.name, count: Math.round(c.count * scale), bytes: Math.round(c.bytes * scale) }; }); };
  return {
    found: Number(o.found) || 0, skipped: Number(o.skipped) || 0, newCount: newCount, detailed: detailed,
    estimated: scale !== 1, bytes: Math.round(bytes * scale), withAttachments: Math.round(att * scale),
    mailFrom: from, mailTo: to,
    byCategory: scaleList(breakdownList(cats)),
    bySender: scaleList(breakdownList(senders)).slice(0, 8),
  };
}

/** 실행 중 진행률. expectedTotal이 없으면 percent는 null. */
function runProgress(run, nowMs) {
  run = run || {};
  var processed = Number(run.processed) || 0, expected = Number(run.expectedTotal) || 0;
  var percent = expected > 0 ? Math.min(99, Math.floor(processed / expected * 100)) : null;
  var elapsed = run.startedAt ? Math.max(1, ((nowMs || Date.now()) - new Date(run.startedAt).getTime()) / 1000) : 0;
  var rate = elapsed > 0 ? processed / elapsed : 0;
  var eta = (expected > processed && rate > 0) ? Math.round((expected - processed) / rate) : null;
  return { percent: percent, elapsedSeconds: Math.round(elapsed), rate: rate, etaSeconds: eta, remaining: expected > processed ? expected - processed : 0 };
}

if (typeof module !== 'undefined') {
  module.exports = { aggregatePreview: aggregatePreview, addToBreakdown: addToBreakdown, breakdownList: breakdownList, runProgress: runProgress };
}
