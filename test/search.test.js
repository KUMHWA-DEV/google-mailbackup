import { describe, it, expect } from 'vitest';
import { parseSearch, matchSearch, parseSize, buildSearchQuery } from '../src/lib/search.js';

const recs = [
  { id: '1', category: '받은편지함', agenda: '업무요청/협조', labels: 'INBOX, IMPORTANT', from: '박민수 <minsu.park@partner.co.kr>', to: 'kumhwa_dev@spris.com', cc: '', subject: '[요청] 9월 정산 자료 확인', snippet: '정산 자료 첨부', attachments: '정산자료_2026-09.xlsx', sizeBytes: 184320, date: '2026-09-10T01:12:00.000Z' },
  { id: '2', category: '보낸편지함', agenda: '계약/재무/발주', labels: 'SENT', from: 'kumhwa_dev@spris.com', to: 'minsu.park@partner.co.kr', cc: 'team@spris.com', subject: 'Re: 정산 자료 확인', snippet: '확인했습니다', attachments: '', sizeBytes: 20480, date: '2026-09-09T08:40:00.000Z' },
  { id: '3', category: '거래처-BBB', agenda: '계약/재무/발주', labels: 'INBOX, 거래처/BBB', from: '이지은 <jieun@bbb.co.kr>', to: 'kumhwa_dev@spris.com', cc: '', subject: '계약서 초안 송부', snippet: '계약서 초안', attachments: '계약서_초안_v1.docx; 별첨1.pdf', sizeBytes: 950000, date: '2026-09-03T07:15:00.000Z' },
];
const ids = (q, opts) => recs.filter(r => matchSearch(r, parseSearch(q), opts)).map(r => r.id);

describe('parseSearch', () => {
  it('splits free terms, quoted phrases, and negations', () => {
    const p = parseSearch('정산 "자료 확인" -계약');
    expect(p.terms).toEqual(['정산', '자료 확인']);
    expect(p.not).toEqual(['계약']);
  });
  it('reads operators case-insensitively', () => {
    const p = parseSearch('FROM:partner To:me subject:정산 has:attachment label:거래처 after:2026-09-01 before:2026/09/10 larger:100K smaller:2M in:sent filename:pdf agenda:계약');
    expect(p.from).toEqual(['partner']);
    expect(p.to).toEqual(['me']);
    expect(p.subject).toEqual(['정산']);
    expect(p.hasAttachment).toBe(true);
    expect(p.label).toEqual(['거래처']);
    expect(p.after).toBe('2026-09-01');
    expect(p.before).toBe('2026-09-10');
    expect(p.larger).toBe(100 * 1024);
    expect(p.smaller).toBe(2 * 1024 * 1024);
    expect(p.in).toBe('sent');
    expect(p.filename).toEqual(['pdf']);
    expect(p.agenda).toEqual(['계약']);
  });
  it('keeps unknown key:value as a free term', () => {
    expect(parseSearch('foo:bar').terms).toEqual(['foo:bar']);
  });
  it('quoted operator values keep spaces', () => {
    expect(parseSearch('from:"박 민수"').from).toEqual(['박 민수']);
  });
});

describe('parseSize', () => {
  it('parses K/M/G suffixes and plain bytes', () => {
    expect(parseSize('500')).toBe(500);
    expect(parseSize('10k')).toBe(10240);
    expect(parseSize('1.5MB')).toBe(Math.round(1.5 * 1048576));
    expect(parseSize('1g')).toBe(1073741824);
    expect(parseSize('abc')).toBe(null);
  });
});

describe('matchSearch', () => {
  it('free terms are ANDed across subject/from/to/snippet/labels/attachments', () => {
    expect(ids('정산')).toEqual(['1', '2']);
    expect(ids('정산 xlsx')).toEqual(['1']);
    expect(ids('정산 -Re:')).toEqual(['1']);
  });
  it('from/to match name or address substring', () => {
    expect(ids('from:박민수')).toEqual(['1']);
    expect(ids('from:partner.co.kr')).toEqual(['1']);
    expect(ids('to:partner')).toEqual(['2']);
    expect(ids('cc:team')).toEqual(['2']);
  });
  it('subject only searches the subject', () => {
    expect(ids('subject:계약')).toEqual(['3']);
    expect(ids('subject:첨부')).toEqual([]);
  });
  it('has:attachment and filename', () => {
    expect(ids('has:attachment')).toEqual(['1', '3']);
    expect(ids('filename:pdf')).toEqual(['3']);
    expect(ids('-has:attachment')).toEqual(['2']);
  });
  it('label matches category or gmail labels, agenda matches agenda', () => {
    expect(ids('label:거래처')).toEqual(['3']);
    expect(ids('label:important')).toEqual(['1']);
    expect(ids('agenda:계약')).toEqual(['2', '3']);
  });
  it('date and size ranges', () => {
    expect(ids('after:2026-09-05')).toEqual(['1', '2']);
    expect(ids('before:2026-09-05')).toEqual(['3']);
    expect(ids('larger:100K')).toEqual(['1', '3']);
    expect(ids('smaller:100K')).toEqual(['2']);
  });
  it('in: folders', () => {
    expect(ids('in:sent')).toEqual(['2']);
    expect(ids('in:inbox')).toEqual(['1', '3']);
    expect(ids('is:important')).toEqual(['1']);
  });
  it('empty query matches everything', () => {
    expect(ids('')).toEqual(['1', '2', '3']);
    expect(ids('   ')).toEqual(['1', '2', '3']);
  });
});

describe('buildSearchQuery', () => {
  it('composes a query string from advanced-search fields', () => {
    expect(buildSearchQuery({ from: '박 민수', to: '', subject: '정산', words: '자료 확인', not: '계약', hasAttachment: true, after: '2026-09-01', before: '', larger: '1M', in: 'sent' }))
      .toBe('from:"박 민수" subject:정산 자료 확인 -계약 has:attachment after:2026-09-01 larger:1M in:sent');
    expect(buildSearchQuery({})).toBe('');
  });
});
