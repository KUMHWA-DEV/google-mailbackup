/**
 * 백업 주기 현황 계산. 순수 함수. 시각은 epoch 초.
 */
var DAY_SECONDS = 86400;

function computeSchedule(o) {
  var now = Number(o.now) || Math.floor(Date.now() / 1000);
  var interval = Number(o.intervalDays);
  if (!isFinite(interval) || interval < 1) interval = 7;
  var last = Number(o.lastSyncEpoch);
  if (!o.lastSyncEpoch || !isFinite(last) || last <= 0) {
    return { intervalDays: interval, lastSyncEpoch: null, nextRunEpoch: now, isDue: true, daysRemaining: 0, elapsedDays: interval, progressPercent: 100 };
  }
  var next = last + interval * DAY_SECONDS;
  var remaining = next - now;
  var isDue = remaining <= 0;
  var daysRemaining = isDue ? 0 : Math.ceil(remaining / DAY_SECONDS);
  var elapsedDays = Math.min(interval, Math.max(0, Math.floor((now - last) / DAY_SECONDS)));
  var progress = Math.min(100, Math.max(0, Math.round(((now - last) / (interval * DAY_SECONDS)) * 100)));
  return { intervalDays: interval, lastSyncEpoch: last, nextRunEpoch: next, isDue: isDue, daysRemaining: daysRemaining, elapsedDays: elapsedDays, progressPercent: progress };
}

if (typeof module !== 'undefined') {
  module.exports = { computeSchedule: computeSchedule };
}
