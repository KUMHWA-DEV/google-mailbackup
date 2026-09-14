import { describe, it, expect } from 'vitest';
import { buildQuery, OVERLAP_SECONDS } from '../src/lib/query.js';

describe('buildQuery', () => {
  it('first run: everything except spam and trash', () => {
    expect(buildQuery(null)).toBe('-in:spam -in:trash -in:chats');
  });
  it('incremental run: after epoch minus overlap', () => {
    const last = 1_757_000_000;
    expect(buildQuery(last)).toBe(`after:${last - OVERLAP_SECONDS} -in:spam -in:trash -in:chats`);
  });
  it('accepts numeric strings from PropertiesService', () => {
    expect(buildQuery('1757000000')).toContain(`after:${1757000000 - OVERLAP_SECONDS}`);
  });
  it('treats garbage as first run', () => {
    expect(buildQuery('abc')).toBe('-in:spam -in:trash -in:chats');
  });
  it('first run with initial start date uses after:YYYY/MM/DD', () => {
    expect(buildQuery(null, { initialStartDate: '2026-08-01' })).toBe('after:2026/08/01 -in:spam -in:trash -in:chats');
  });
  it('incremental run ignores initial start date', () => {
    expect(buildQuery(1_757_000_000, { initialStartDate: '2026-08-01' })).not.toContain('2026/08/01');
  });
  it('excludes sent mail when includeSent is false', () => {
    expect(buildQuery(null, { includeSent: false })).toBe('-in:spam -in:trash -in:chats -in:sent');
  });
  it('appends an extra filter query', () => {
    expect(buildQuery(null, { filterQuery: 'from:partner.co.kr' })).toBe('-in:spam -in:trash -in:chats from:partner.co.kr');
  });
});
