import { describe, it, expect } from 'vitest';
import { sanitizeName, buildFileName, buildFolderPath, formatStamp } from '../src/lib/naming.js';

describe('sanitizeName', () => {
  it('strips filesystem-hostile characters and trims', () => {
    expect(sanitizeName(' Re: 견적/요청 <urgent>? ')).toBe('Re 견적 요청 urgent');
  });
  it('collapses whitespace and caps length', () => {
    expect(sanitizeName('a    b'.repeat(40)).length).toBeLessThanOrEqual(80);
  });
  it('falls back for empty subject', () => {
    expect(sanitizeName('')).toBe('(제목 없음)');
    expect(sanitizeName(undefined)).toBe('(제목 없음)');
  });
});

describe('formatStamp', () => {
  it('formats in the given time zone', () => {
    const d = new Date('2026-09-11T00:05:00Z');
    expect(formatStamp(d, 'Asia/Seoul')).toBe('20260911-0905');
    expect(formatStamp(d, 'UTC')).toBe('20260911-0005');
  });
});

describe('buildFileName', () => {
  it('composes stamp, subject, id', () => {
    const d = new Date('2026-09-11T00:05:00Z');
    expect(buildFileName({ date: d, subject: 'Hello: world', id: 'abc123' }, 'Asia/Seoul'))
      .toBe('20260911-0905_Hello world_abc123.eml');
  });
});

describe('buildFolderPath', () => {
  it('returns category/year/year-month segments', () => {
    const d = new Date('2026-09-11T00:05:00Z');
    expect(buildFolderPath('보낸편지함', d, 'Asia/Seoul', 'monthly')).toEqual(['보낸편지함', '2026', '2026-09']);
  });
  it('year rolls over across the zone boundary', () => {
    const d = new Date('2025-12-31T20:00:00Z');
    expect(buildFolderPath('받은편지함', d, 'Asia/Seoul', 'monthly')).toEqual(['받은편지함', '2026', '2026-01']);
  });
});

describe('buildFolderPath layouts', () => {
  const d = new Date('2026-09-11T00:05:00Z');
  it('flat layout is a single category folder that keeps accumulating', () => {
    expect(buildFolderPath('받은편지함', d, 'Asia/Seoul', 'flat')).toEqual(['받은편지함']);
  });
  it('yearly layout', () => {
    expect(buildFolderPath('받은편지함', d, 'Asia/Seoul', 'yearly')).toEqual(['받은편지함', '2026']);
  });
  it('monthly layout is the explicit form of the default', () => {
    expect(buildFolderPath('받은편지함', d, 'Asia/Seoul', 'monthly')).toEqual(['받은편지함', '2026', '2026-09']);
  });
  it('unknown layout falls back to flat', () => {
    expect(buildFolderPath('받은편지함', d, 'Asia/Seoul', 'weird')).toEqual(['받은편지함']);
  });
});
