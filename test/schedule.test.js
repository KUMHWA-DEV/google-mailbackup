import { describe, it, expect } from 'vitest';
import { computeSchedule, nextTriggerEpoch } from '../src/lib/schedule.js';

const DAY = 86400;
const now = 1_760_000_000; // epoch seconds

describe('computeSchedule', () => {
  it('never run: due now, next run is now, progress 100', () => {
    const s = computeSchedule({ lastSyncEpoch: null, intervalDays: 7, now });
    expect(s.isDue).toBe(true);
    expect(s.daysRemaining).toBe(0);
    expect(s.progressPercent).toBe(100);
    expect(s.nextRunEpoch).toBe(now);
  });
  it('mid-cycle: not due, remaining days rounded up', () => {
    const s = computeSchedule({ lastSyncEpoch: now - 2.5 * DAY, intervalDays: 7, now });
    expect(s.isDue).toBe(false);
    expect(s.daysRemaining).toBe(5);
    expect(s.elapsedDays).toBe(2);
    expect(s.progressPercent).toBe(36);
    expect(s.nextRunEpoch).toBe(now - 2.5 * DAY + 7 * DAY);
  });
  it('overdue: due, remaining 0, progress capped at 100', () => {
    const s = computeSchedule({ lastSyncEpoch: now - 10 * DAY, intervalDays: 7, now });
    expect(s.isDue).toBe(true);
    expect(s.daysRemaining).toBe(0);
    expect(s.progressPercent).toBe(100);
  });
  it('next trigger is 03:00 KST: weekly → next Monday, N days → the 03:00 after last+N days, never in the past', () => {
    const kst = (iso) => Math.floor(Date.parse(iso) / 1000); // ISO with +09:00
    const now2 = kst('2026-09-15T09:30:00+09:00'); // 화요일 오전
    expect(nextTriggerEpoch(kst('2026-09-14T18:22:00+09:00'), 7, now2)).toBe(kst('2026-09-21T03:00:00+09:00'));
    expect(nextTriggerEpoch(kst('2026-09-14T18:22:00+09:00'), 1, now2)).toBe(kst('2026-09-16T03:00:00+09:00')); // 15일 03:00은 이미 지남
    expect(nextTriggerEpoch(kst('2026-09-10T02:00:00+09:00'), 3, now2)).toBe(kst('2026-09-16T03:00:00+09:00')); // 13일 03:00 지남 → 다음 03:00
    expect(nextTriggerEpoch(kst('2026-09-14T18:22:00+09:00'), 3, now2)).toBe(kst('2026-09-17T03:00:00+09:00'));
    expect(nextTriggerEpoch(null, 1, now2)).toBe(kst('2026-09-16T03:00:00+09:00'));
    expect(computeSchedule({ lastSyncEpoch: kst('2026-09-14T18:22:00+09:00'), intervalDays: 1, now: now2 }).nextTriggerEpoch).toBe(kst('2026-09-16T03:00:00+09:00'));
  });
  it('interval defaults to 7 when invalid', () => {
    const s = computeSchedule({ lastSyncEpoch: now - DAY, intervalDays: 'x', now });
    expect(s.intervalDays).toBe(7);
  });
});
