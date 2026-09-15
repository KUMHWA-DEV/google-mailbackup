/**
 * 백업 주기 현황 계산. 순수 함수. 시각은 epoch 초.
 */
var DAY_SECONDS = 86400;

/**
 * 실제 트리거가 도는 시각: 새벽 03:00 KST. 주기 7일이면 매주 월요일, 그 외 N일마다.
 * 대시보드 "다음 백업"은 (마지막 실행 + N일)이 아니라 이 값을 쓴다.
 */
var KST_OFFSET = 9 * 3600, TRIGGER_HOUR_SECONDS = 3 * 3600;
function nextTriggerEpoch(lastSyncEpoch, intervalDays, now) {
  var dayStartKst = function (e) { return Math.floor((e + KST_OFFSET) / DAY_SECONDS) * DAY_SECONDS - KST_OFFSET; };
  var weekdayKst = function (e) { return (Math.floor((e + KST_OFFSET) / DAY_SECONDS) + 4) % 7; }; // 0=일 … 1=월
  var t;
  if (intervalDays === 7) {
    t = dayStartKst(now) + TRIGGER_HOUR_SECONDS;
    while (t <= now || weekdayKst(t) !== 1) t += DAY_SECONDS;
  } else {
    var base = lastSyncEpoch ? lastSyncEpoch + intervalDays * DAY_SECONDS : now;
    t = dayStartKst(base) + TRIGGER_HOUR_SECONDS;
    while (t <= now) t += DAY_SECONDS;
  }
  return t;
}

function computeSchedule(o) {
  var now = Number(o.now) || Math.floor(Date.now() / 1000);
  var interval = Number(o.intervalDays);
  if (!isFinite(interval) || interval < 1) interval = 7;
  var last = Number(o.lastSyncEpoch);
  if (!o.lastSyncEpoch || !isFinite(last) || last <= 0) {
    return { intervalDays: interval, lastSyncEpoch: null, nextRunEpoch: now, nextTriggerEpoch: nextTriggerEpoch(null, interval, now), isDue: true, daysRemaining: 0, elapsedDays: interval, progressPercent: 100 };
  }
  var next = last + interval * DAY_SECONDS;
  var remaining = next - now;
  var isDue = remaining <= 0;
  var daysRemaining = isDue ? 0 : Math.ceil(remaining / DAY_SECONDS);
  var elapsedDays = Math.min(interval, Math.max(0, Math.floor((now - last) / DAY_SECONDS)));
  var progress = Math.min(100, Math.max(0, Math.round(((now - last) / (interval * DAY_SECONDS)) * 100)));
  return { intervalDays: interval, lastSyncEpoch: last, nextRunEpoch: next, nextTriggerEpoch: nextTriggerEpoch(last, interval, now), isDue: isDue, daysRemaining: daysRemaining, elapsedDays: elapsedDays, progressPercent: progress };
}

if (typeof module !== 'undefined') {
  module.exports = { computeSchedule: computeSchedule, nextTriggerEpoch: nextTriggerEpoch };
}
