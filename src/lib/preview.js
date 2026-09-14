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
/**
 * 진행률·소요·남은 시간. 소요는 실제 작업 시간(구간 합, 대기·지연 제외), 속도는 현재 구간(30초 이상 진행 시) 또는
 * 직전 구간의 속도를 쓴다. 시작 이후 전체 시간으로 나누면 중단·대기가 섞여 남은 시간이 엉뚱해진다.
 */
function runProgress(run, nowMs) {
  run = run || {};
  var now = nowMs || Date.now();
  var processed = Number(run.processed) || 0, expected = Number(run.expectedTotal) || 0;
  var percent = expected > 0 ? Math.min(99, Math.floor(processed / expected * 100)) : null;
  var chunkSecs = run.chunkStartedAt ? Math.max(0, (now - new Date(run.chunkStartedAt).getTime()) / 1000) : 0;
  if (chunkSecs > 400) chunkSecs = 0; // 구간이 끝났는데 기록이 안 된 경우(끊김)
  var active = (Number(run.activeSeconds) || 0) + chunkSecs;
  var elapsed = active > 0 ? active : (run.startedAt ? Math.max(1, (now - new Date(run.startedAt).getTime()) / 1000) : 0);
  var chunkDone = processed - (Number(run.chunkStartProcessed) || 0);
  var rate = (chunkSecs >= 30 && chunkDone > 0) ? chunkDone / chunkSecs
    : (Number(run.lastRate) > 0 ? Number(run.lastRate) : (elapsed > 0 ? processed / elapsed : 0));
  var eta = (expected > processed && rate > 0) ? Math.round((expected - processed) / rate * 1.15) : null; // 구간 사이 대기 여유 15%
  return { percent: percent, elapsedSeconds: Math.round(elapsed), rate: rate, etaSeconds: eta, remaining: expected > processed ? expected - processed : 0 };
}

/**
 * 예상 소요 시간(초). 메일당 약 1.2초, 4분 30초 구간마다 1분 대기.
 * 경험값이며 첨부가 많으면 더 걸린다.
 */
var EST_SECONDS_PER_MAIL = 1.2;
var EST_CHUNK_SECONDS = 270;
var EST_GAP_SECONDS = 60;
function estimateRunSeconds(count) {
  count = Number(count) || 0;
  if (count <= 0) return 0;
  var work = count * EST_SECONDS_PER_MAIL;
  var chunks = Math.ceil(work / EST_CHUNK_SECONDS);
  return Math.round(work + Math.max(0, chunks - 1) * EST_GAP_SECONDS);
}

if (typeof module !== 'undefined') {
  module.exports = { aggregatePreview: aggregatePreview, addToBreakdown: addToBreakdown, breakdownList: breakdownList, runProgress: runProgress, estimateRunSeconds: estimateRunSeconds };
}
