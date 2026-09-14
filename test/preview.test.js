import { describe, it, expect } from 'vitest';
import { aggregatePreview, addToBreakdown, breakdownList, runProgress } from '../src/lib/preview.js';

describe('aggregatePreview', () => {
  const metas = [
    { category: '받은편지함', sizeBytes: 1000, date: '2026-09-10T01:00:00.000Z', from: 'a@x.com' },
    { category: '받은편지함', sizeBytes: 3000, date: '2026-09-08T01:00:00.000Z', from: 'b@y.com' },
    { category: '보낸편지함', sizeBytes: 500, date: '2026-09-09T01:00:00.000Z', from: 'me@spris.com' },
  ];
  it('counts, sums, ranges, and breaks down by category and sender', () => {
    const p = aggregatePreview({ found: 5, skipped: 2, newCount: 3, metas, detailed: 3 });
    expect(p.found).toBe(5); expect(p.skipped).toBe(2); expect(p.newCount).toBe(3);
    expect(p.bytes).toBe(4500); expect(p.estimated).toBe(false);
    expect(p.mailFrom).toBe('2026-09-08T01:00:00.000Z'); expect(p.mailTo).toBe('2026-09-10T01:00:00.000Z');
    expect(p.byCategory).toEqual([{ name: '받은편지함', count: 2, bytes: 4000 }, { name: '보낸편지함', count: 1, bytes: 500 }]);
    expect(p.bySender[0]).toEqual({ name: 'b@y.com', count: 1, bytes: 3000 }); // 동률이면 용량 큰 순
    expect(p.withAttachments).toBe(0);
  });
  it('extrapolates when only a sample was detailed', () => {
    const p = aggregatePreview({ found: 100, skipped: 0, newCount: 100, metas, detailed: 3 });
    expect(p.estimated).toBe(true);
    expect(p.bytes).toBe(Math.round(4500 / 3 * 100));
    expect(p.byCategory[0].count).toBe(67); // 2/3 of 100, rounded
  });
  it('handles no new mail', () => {
    const p = aggregatePreview({ found: 4, skipped: 4, newCount: 0, metas: [], detailed: 0 });
    expect(p.bytes).toBe(0); expect(p.byCategory).toEqual([]); expect(p.mailFrom).toBe(null);
  });
});

describe('breakdown helpers', () => {
  it('accumulates and lists sorted by count', () => {
    const b = {};
    addToBreakdown(b, 'a', 10); addToBreakdown(b, 'b', 5); addToBreakdown(b, 'a', 1);
    expect(breakdownList(b)).toEqual([{ name: 'a', count: 2, bytes: 11 }, { name: 'b', count: 1, bytes: 5 }]);
  });
});

describe('runProgress', () => {
  it('percent from expected total, capped at 99 while running', () => {
    expect(runProgress({ processed: 50, expectedTotal: 200 }).percent).toBe(25);
    expect(runProgress({ processed: 250, expectedTotal: 200 }).percent).toBe(99);
    expect(runProgress({ processed: 0, expectedTotal: 0 }).percent).toBe(null);
  });
  it('estimates remaining seconds from throughput', () => {
    const p = runProgress({ processed: 50, expectedTotal: 200, startedAt: '2026-09-14T00:00:00.000Z' }, new Date('2026-09-14T00:01:40.000Z').getTime());
    expect(p.rate).toBeCloseTo(0.5, 2);
    expect(p.etaSeconds).toBe(300);
  });
});
