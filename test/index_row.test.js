import { describe, it, expect } from 'vitest';
import { INDEX_HEADERS, headersFromPayload, buildIndexRow, rowToRecord, filterRecords, decodeBase64Url } from '../src/lib/index_row.js';

const payload = {
  headers: [
    { name: 'From', value: 'Kim <kim@example.com>' },
    { name: 'To', value: 'me@spris.com' },
    { name: 'Cc', value: '' },
    { name: 'Subject', value: 'Test subject' },
    { name: 'Date', value: 'Fri, 11 Sep 2026 09:05:00 +0900' },
  ],
};

describe('headersFromPayload', () => {
  it('maps header names case-insensitively', () => {
    const h = headersFromPayload(payload);
    expect(h.from).toBe('Kim <kim@example.com>');
    expect(h.subject).toBe('Test subject');
    expect(h.cc).toBe('');
  });
  it('handles missing payload', () => {
    expect(headersFromPayload(undefined)).toEqual({});
  });
});

describe('buildIndexRow', () => {
  it('produces a row aligned with INDEX_HEADERS', () => {
    const row = buildIndexRow({
      id: 'm1', threadId: 't1', date: new Date('2026-09-11T00:05:00Z'),
      category: '받은편지함', labelNames: ['INBOX', '프로젝트A'],
      headers: headersFromPayload(payload), snippet: 'hi', sizeEstimate: 1234,
      attachmentNames: ['a.pdf', 'b.png'], driveFileId: 'f1', driveUrl: 'https://drive/f1',
      backedUpAt: new Date('2026-09-12T00:00:00Z'),
    });
    expect(row.length).toBe(INDEX_HEADERS.length);
    const rec = rowToRecord(row);
    expect(rec.id).toBe('m1');
    expect(rec.labels).toBe('INBOX, 프로젝트A');
    expect(rec.attachments).toBe('a.pdf; b.png');
    expect(rec.date).toBe('2026-09-11T00:05:00.000Z');
    expect(rec.sizeBytes).toBe(1234);
  });
});

describe('filterRecords', () => {
  const recs = [
    { id: '1', category: '받은편지함', from: 'a@x.com', to: 'me', subject: 'Invoice July', snippet: 'pay', date: '2026-07-01T00:00:00.000Z', labels: 'INBOX' },
    { id: '2', category: '보낸편지함', from: 'me', to: 'b@y.com', subject: 'Re: hello', snippet: 'thanks', date: '2026-08-15T00:00:00.000Z', labels: 'SENT' },
    { id: '3', category: '프로젝트A', from: 'c@z.com', to: 'me', subject: 'spec', snippet: 'invoice attached', date: '2026-09-01T00:00:00.000Z', labels: 'INBOX, 프로젝트A' },
  ];
  it('filters by category', () => {
    expect(filterRecords(recs, { category: '보낸편지함' }).map(r => r.id)).toEqual(['2']);
  });
  it('keyword searches subject, from, to, snippet, labels case-insensitively', () => {
    expect(filterRecords(recs, { q: 'INVOICE' }).map(r => r.id)).toEqual(['3', '1']);
    expect(filterRecords(recs, { q: '프로젝트' }).map(r => r.id)).toEqual(['3']);
  });
  it('filters by date range inclusive', () => {
    expect(filterRecords(recs, { dateFrom: '2026-08-01', dateTo: '2026-09-01' }).map(r => r.id)).toEqual(['3', '2']);
  });
  it('filters by sender substring', () => {
    expect(filterRecords(recs, { from: 'z.com' }).map(r => r.id)).toEqual(['3']);
  });
  it('returns newest first', () => {
    expect(filterRecords(recs, {}).map(r => r.id)).toEqual(['3', '2', '1']);
  });
});

describe('decodeBase64Url', () => {
  it('decodes url-safe base64 to utf8', () => {
    expect(decodeBase64Url('SGVsbG8_LQ')).toBe('Hello?-');
  });
});

describe('summarizeRecords', () => {
  const { summarizeRecords } = require('../src/lib/index_row.js');
  it('counts, sums bytes, finds oldest/newest and per-category counts', () => {
    const s = summarizeRecords([
      { id: '1', category: '받은편지함', date: '2026-07-01T00:00:00.000Z', sizeBytes: 100, backedUpAt: '2026-08-06T18:00:00.000Z' },
      { id: '2', category: '보낸편지함', date: '2026-08-15T00:00:00.000Z', sizeBytes: '250', backedUpAt: '2026-09-10T18:00:00.000Z' },
      { id: '3', category: '받은편지함', date: '2026-09-01T00:00:00.000Z', sizeBytes: 50, backedUpAt: '2026-09-10T18:00:00.000Z' },
    ]);
    expect(s.total).toBe(3);
    expect(s.totalBytes).toBe(400);
    expect(s.oldestDate).toBe('2026-07-01T00:00:00.000Z');
    expect(s.newestDate).toBe('2026-09-01T00:00:00.000Z');
    expect(s.lastBackedUpAt).toBe('2026-09-10T18:00:00.000Z');
    expect(s.categories).toEqual([{ name: '받은편지함', count: 2, bytes: 150 }, { name: '보낸편지함', count: 1, bytes: 250 }]);
  });
  it('handles empty index', () => {
    expect(summarizeRecords([])).toEqual({ total: 0, totalBytes: 0, oldestDate: null, newestDate: null, lastBackedUpAt: null, categories: [] });
  });
});
