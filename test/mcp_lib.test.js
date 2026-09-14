import { describe, it, expect } from 'vitest';
import { rowsToRecords, compactRecord, textKind, truncateText, searchRecords } from '../mcp/lib.js';
import { INDEX_HEADERS } from '../src/lib/index_row.js';

const header = INDEX_HEADERS.slice();
const row = (o) => header.map(h => o[h] == null ? '' : o[h]);

describe('rowsToRecords', () => {
  it('maps a sheet (header + rows) to records, tolerating a stale header order', () => {
    const rows = [header, row({ id: '1', subject: 'a', sizeBytes: 10, date: '2026-09-01T00:00:00.000Z', bodyPreview: 'hello' })];
    const recs = rowsToRecords(rows);
    expect(recs.length).toBe(1);
    expect(recs[0].id).toBe('1'); expect(recs[0].sizeBytes).toBe(10); expect(recs[0].bodyPreview).toBe('hello');
  });
  it('returns [] for empty or header-only sheets', () => {
    expect(rowsToRecords([])).toEqual([]);
    expect(rowsToRecords([header])).toEqual([]);
  });
});

describe('compactRecord', () => {
  it('drops the body and expands attachment files', () => {
    const c = compactRecord({ id: '1', subject: 's', bodyPreview: 'x'.repeat(100), attachments: 'a.pdf', attachmentFiles: '[{"name":"a.pdf","fileId":"F","size":5,"mime":"application/pdf"}]', sizeBytes: 3 });
    expect(c.bodyPreview).toBeUndefined();
    expect(c.attachments).toEqual([{ name: 'a.pdf', fileId: 'F', size: 5, mime: 'application/pdf' }]);
  });
});

describe('textKind', () => {
  it('classifies by mime and extension', () => {
    expect(textKind('text/plain', 'a.txt')).toBe('text');
    expect(textKind('application/pdf', 'a.pdf')).toBe('convert');
    expect(textKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx')).toBe('convert');
    expect(textKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a.xlsx')).toBe('convert-sheet');
    expect(textKind('image/png', 'a.png')).toBe('binary');
    expect(textKind('', 'a.csv')).toBe('text');
  });
});

describe('truncateText', () => {
  it('caps length and marks truncation', () => {
    const t = truncateText('abcdef', 4);
    expect(t.text).toBe('abcd'); expect(t.truncated).toBe(true); expect(t.total).toBe(6);
    expect(truncateText('ab', 4).truncated).toBe(false);
  });
});

describe('searchRecords', () => {
  const recs = [
    { id: '1', category: '받은편지함', labels: 'INBOX', from: 'a@x.com', to: 'me', subject: '계약서 초안', snippet: '', attachments: 'c.pdf', date: '2026-09-03T00:00:00.000Z', sizeBytes: 1 },
    { id: '2', category: '보낸편지함', labels: 'SENT', from: 'me', to: 'b@y.com', subject: 'Re: 계약서', snippet: '', attachments: '', date: '2026-09-04T00:00:00.000Z', sizeBytes: 1 },
  ];
  it('uses the shared query syntax and folder scope, newest first, with paging', () => {
    expect(searchRecords(recs, { query: '계약서' }).items.map(r => r.id)).toEqual(['2', '1']);
    expect(searchRecords(recs, { query: '계약서 has:attachment' }).items.map(r => r.id)).toEqual(['1']);
    expect(searchRecords(recs, { query: '', folder: 'sent' }).items.map(r => r.id)).toEqual(['2']);
    const p = searchRecords(recs, { query: '', limit: 1, offset: 1 });
    expect(p.total).toBe(2); expect(p.items.map(r => r.id)).toEqual(['1']);
  });
});
