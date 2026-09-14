/**
 * 증분 동기화용 Gmail 검색 쿼리. 순수 함수.
 */
var OVERLAP_SECONDS = 2 * 24 * 60 * 60; // 지난 실행과 2일 겹치게 조회 (중복은 id로 제거)
var BASE_QUERY = '-in:spam -in:trash -in:chats';

/**
 * @param {number|string|null} lastSyncEpoch 초 단위 epoch. 없거나 이상하면 첫 실행.
 * @param {{initialStartDate?:string, includeSent?:boolean, filterQuery?:string}} [opts]
 *   initialStartDate: 첫 실행에서만 적용되는 시작 기준일(YYYY-MM-DD)
 *   includeSent: false면 보낸편지함 제외
 *   filterQuery: 사용자가 추가한 Gmail 검색 조건
 */
function buildQuery(lastSyncEpoch, opts) {
  opts = opts || {};
  var parts = [];
  var n = Number(lastSyncEpoch);
  if (lastSyncEpoch && isFinite(n) && n > 0) {
    parts.push('after:' + Math.max(0, Math.floor(n) - OVERLAP_SECONDS));
  } else if (opts.initialStartDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.initialStartDate)) {
    parts.push('after:' + opts.initialStartDate.replace(/-/g, '/'));
  }
  parts.push(BASE_QUERY);
  if (opts.includeSent === false) parts.push('-in:sent');
  if (opts.filterQuery && String(opts.filterQuery).trim()) parts.push(String(opts.filterQuery).trim());
  return parts.join(' ');
}

if (typeof module !== 'undefined') {
  module.exports = { buildQuery: buildQuery, OVERLAP_SECONDS: OVERLAP_SECONDS, BASE_QUERY: BASE_QUERY };
}
