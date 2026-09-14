import { describe, it, expect } from 'vitest';
import { computeSchedule } from '../src/lib/schedule.js';

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
  it('interval defaults to 7 when invalid', () => {
    const s = computeSchedule({ lastSyncEpoch: now - DAY, intervalDays: 'x', now });
    expect(s.intervalDays).toBe(7);
  });
});
