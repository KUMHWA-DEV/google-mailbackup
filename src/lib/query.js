/**
 * 증분 동기화용 Gmail 검색 쿼리. 순수 함수.
 */
var OVERLAP_SECONDS = 2 * 24 * 60 * 60; // 지난 실행과 2일 겹치게 조회 (중복은 id로 제거)
var BASE_QUERY = '-in:spam -in:trash -in:chats';

/** @param {number|string|null} lastSyncEpoch 초 단위 epoch. 없거나 이상하면 전체 조회. */
function buildQuery(lastSyncEpoch) {
  var n = Number(lastSyncEpoch);
  if (!lastSyncEpoch || !isFinite(n) || n <= 0) return BASE_QUERY;
  return 'after:' + Math.max(0, Math.floor(n) - OVERLAP_SECONDS) + ' ' + BASE_QUERY;
}

if (typeof module !== 'undefined') {
  module.exports = { buildQuery: buildQuery, OVERLAP_SECONDS: OVERLAP_SECONDS, BASE_QUERY: BASE_QUERY };
}
