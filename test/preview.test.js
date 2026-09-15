import { describe, it, expect } from 'vitest';
import { aggregatePreview, addToBreakdown, breakdownList, runProgress, updateRate } from '../src/lib/preview.js';

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
    expect(p.etaSeconds).toBe(345); // 남은 150건 / 0.5 × 1.15 (구간 사이 대기 여유)
  });
  it('uses the current chunk rate and active seconds, not wall-clock since start', () => {
    const now = new Date('2026-09-14T10:00:00.000Z').getTime();
    const p = runProgress({ processed: 500, expectedTotal: 700, startedAt: '2026-09-13T18:00:00.000Z', activeSeconds: 2000,
      chunkStartedAt: new Date(now - 100 * 1000).toISOString(), chunkStartProcessed: 450, lastRate: 0.2 }, now);
    expect(p.elapsedSeconds).toBe(2100);   // 밤새 멈춘 16시간은 소요에 포함되지 않는다
    expect(p.rate).toBeCloseTo(0.5, 2);    // 이번 구간 50건/100초
    expect(p.etaSeconds).toBe(460);        // 200 / 0.5 × 1.15
    const waiting = runProgress({ processed: 500, expectedTotal: 700, activeSeconds: 2000, chunkStartedAt: null, lastRate: 0.25 }, now);
    expect(waiting.rate).toBe(0.25);       // 구간 사이에는 직전 구간 속도
  });
});

describe('updateRate (EWMA throughput)', () => {
  it('samples only on progress and smooths', () => {
    const t0 = Date.parse('2026-09-15T00:00:00Z');
    const run = { processed: 0 };
    updateRate(run, t0);                       // 기준점만 잡음
    run.processed = 10; updateRate(run, t0 + 10000); // 1.0 건/초
    expect(run.rateEwma).toBeCloseTo(1.0, 3);
    updateRate(run, t0 + 12000);               // 진척 없음 → 표본 없음, 속도 유지
    expect(run.rateEwma).toBeCloseTo(1.0, 3);
    run.processed = 12; updateRate(run, t0 + 30000); // 직전 표본(t0+10s) 이후 2건/20초 = 0.1 → 0.3*0.1 + 0.7*1.0
    expect(run.rateEwma).toBeCloseTo(0.73, 3);
    expect(runProgress({ processed: 12, expectedTotal: 112, rateEwma: run.rateEwma, activeSeconds: 30 }, t0 + 30000).etaSeconds).toBe(Math.round(100 / run.rateEwma * 1.15));
  });
});

describe('estimateRunSeconds', () => {
  const { estimateRunSeconds } = require('../src/lib/preview.js');
  it('scales with count and adds the 1-minute gap between chunks', () => {
    expect(estimateRunSeconds(0)).toBe(0);
    expect(estimateRunSeconds(100)).toBe(120);           // 100 × 1.2s, single chunk
    expect(estimateRunSeconds(1000)).toBe(1200 + 4 * 60); // 5 chunks of 270s → 4 gaps
  });
});
