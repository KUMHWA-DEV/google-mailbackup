import { describe, it, expect } from 'vitest';
import { parseEml, mimeDecodeWords_, mboxScan, mboxUnwrap, gmailLabelsToIds, decToHex, mimeCleanB64_ } from '../src/lib/mime.js';

// Node용 문자셋 디코더: 바이너리 문자열 → Buffer(latin1) → TextDecoder
const decode = (bin, cs) => {
  const buf = Buffer.from(bin, 'latin1');
  const c = String(cs || 'utf-8').toLowerCase();
  if (c === 'ks_c_5601-1987' || c === 'euc-kr' || c === 'cp949') return new TextDecoder('euc-kr').decode(buf);
  try { return new TextDecoder(c).decode(buf); } catch (e) { return buf.toString('utf8'); }
};
const b64 = (s, cs) => Buffer.from(cs === 'euc-kr' ? require('iconv-lite') : s, 'utf8').toString('base64');
const utf8b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

describe('parseEml', () => {
  it('parses a plain UTF-8 mail with encoded-word subject and Message-ID', () => {
    const eml = [
      'From: =?UTF-8?B?7ZmN6ri464+Z?= <hong@example.com>',
      'To: me@example.com',
      'Subject: =?UTF-8?B?7KCV7IKwIOyekOujjA==?=',
      'Date: Tue, 10 Sep 2024 15:12:00 +0900',
      'Message-ID: <abc123@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      utf8b64('안녕하세요.\n자료 보냅니다.'),
    ].join('\r\n');
    const m = parseEml(Buffer.from(eml, 'utf8').toString('latin1'), decode);
    expect(m.messageId).toBe('abc123@example.com');
    expect(m.headers.from).toBe('홍길동 <hong@example.com>');
    expect(m.headers.subject).toBe('정산 자료');
    expect(m.date.toISOString()).toBe('2024-09-10T06:12:00.000Z');
    expect(m.bodyText).toBe('안녕하세요.\n자료 보냅니다.');
    expect(m.attachments).toEqual([]);
  });

  it('handles multipart/mixed with alternative text+html and a base64 attachment', () => {
    const pdf = Buffer.from('%PDF-1.4 fake');
    const eml = [
      'From: a@example.com', 'To: b@example.com', 'Subject: report', 'Date: Mon, 1 Jul 2024 09:00:00 +0000',
      'Content-Type: multipart/mixed; boundary="OUTER"', '',
      '--OUTER', 'Content-Type: multipart/alternative; boundary="INNER"', '',
      '--INNER', 'Content-Type: text/plain; charset=us-ascii', '', 'plain body', '--INNER',
      'Content-Type: text/html; charset=us-ascii', '', '<p>html <b>body</b></p>', '--INNER--',
      '--OUTER', 'Content-Type: application/pdf; name="report.pdf"', 'Content-Disposition: attachment; filename="report.pdf"', 'Content-Transfer-Encoding: base64', '',
      pdf.toString('base64'), '--OUTER--', '',
    ].join('\r\n');
    const m = parseEml(eml, decode);
    expect(m.bodyText).toBe('plain body');
    expect(m.attachments.length).toBe(1);
    expect(m.attachments[0].name).toBe('report.pdf');
    expect(m.attachments[0].mime).toBe('application/pdf');
    expect(Buffer.from(m.attachments[0].dataB64, 'base64').equals(pdf)).toBe(true);
  });

  it('falls back to stripped HTML when there is no text part, decodes quoted-printable EUC-KR', () => {
    // "한글" in EUC-KR = C7 D1 B1 DB
    const eml = [
      'From: a@example.com', 'Subject: =?ks_c_5601-1987?Q?=C7=D1=B1=DB?=', 'Date: Mon, 1 Jul 2024 09:00:00 +0900',
      'Content-Type: text/html; charset=ks_c_5601-1987', 'Content-Transfer-Encoding: quoted-printable', '',
      '<html><body><div>=C7=D1=B1=DB</div><div>line2</div></body></html>',
    ].join('\r\n');
    const m = parseEml(eml, decode);
    expect(m.headers.subject).toBe('한글');
    expect(m.bodyText).toBe('한글\nline2');
  });

  it('decodes RFC 2231 filenames and treats inline images without filename as non-attachments', () => {
    const eml = [
      'From: a@example.com', 'Subject: s', 'Content-Type: multipart/mixed; boundary=B', '',
      '--B', 'Content-Type: text/plain', '', 'hi', '--B',
      "Content-Type: application/octet-stream", "Content-Disposition: attachment; filename*=UTF-8''%EA%B3%84%EC%95%BD%EC%84%9C.docx", 'Content-Transfer-Encoding: base64', '', utf8b64('x'), '--B',
      'Content-Type: image/png', 'Content-ID: <img1>', 'Content-Disposition: inline', 'Content-Transfer-Encoding: base64', '', utf8b64('png'), '--B--',
    ].join('\r\n');
    const m = parseEml(eml, decode);
    expect(m.attachments.map(a => a.name)).toEqual(['계약서.docx']);
  });

  it('decodes encoded-word label names in X-Gmail-Labels (Takeout)', () => {
    const eml = ['From: a@example.com', 'Subject: s', 'X-Gmail-Labels: Inbox,=?UTF-8?B?7KCE65617Iuk?=,Important', '', 'hi'].join('\r\n');
    expect(parseEml(eml, decode).gmailLabels).toBe('Inbox,전략실,Important');
    expect(gmailLabelsToIds(parseEml(eml, decode).gmailLabels).labelMap).toEqual({ 'user:전략실': '전략실' });
  });
  it('handles a whole label list wrapped in one encoded word (Takeout) — split after decoding', () => {
    const eml = ['From: a@example.com', 'Subject: s', 'X-Gmail-Labels: =?UTF-8?B?67Cb7J2A7Y647KeA7ZWoLOykkeyalO2OuOyngO2VqCzsoITrnrXsi6Q=?=', '', 'hi'].join('\r\n');
    const g = gmailLabelsToIds(parseEml(eml, decode).gmailLabels);
    expect(g.labelIds).toEqual(['INBOX', 'IMPORTANT', 'user:전략실']);
    expect(gmailLabelsToIds('INBOX, IMPORTANT, CATEGORY_UPDATES, 전략실').labelIds).toEqual(['INBOX', 'IMPORTANT', 'CATEGORY_UPDATES', 'user:전략실']);
  });
  it('repairs base64 padding and strips junk so a truncated attachment does not fail the whole mail', () => {
    expect(mimeCleanB64_('YWJj')).toBe('YWJj'); expect(mimeCleanB64_('YWI')).toBe('YWI='); expect(mimeCleanB64_('YQ')).toBe('YQ=='); expect(mimeCleanB64_('YQ==\r\n')).toBe('YQ=='); expect(mimeCleanB64_('YWJjZ')).toBe('YWJj');
  });
  it('maps Korean Takeout system names and free-form "… 카테고리" labels instead of making user labels', () => {
    expect(gmailLabelsToIds('받은편지함,중요편지함,열림,개인정보 카테고리,구매 카테고리,보관됨,스팸').labelIds).toEqual(['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL', 'CATEGORY_PURCHASES', 'SPAM']);
    expect(gmailLabelsToIds('보관됨').labelIds).toEqual([]);
    expect(gmailLabelsToIds('받은편지함,마지막으로 연 시간,카테고리 청구서,개인정보 카테고리').labelIds).toEqual(['INBOX', 'CATEGORY_PERSONAL']);
    expect(gmailLabelsToIds('받은편지함,마지막으로 연 시간,카테고리 청구서').labelMap).toEqual({});
    expect(gmailLabelsToIds('거래처/BBB').labelMap).toEqual({ 'user:거래처/BBB': '거래처/BBB' });
  });
  it('derives a thread hint: X-GM-THRID as Gmail hex thread id, else the References root, else own Message-ID', () => {
    const base = ['From: a@example.com', 'Subject: s', 'Message-ID: <own@x>'];
    expect(parseEml([...base, 'X-GM-THRID: 1811234567890123456', '', 'hi'].join('\r\n'), decode).threadHint).toBe('gm:' + (1811234567890123456n).toString(16));
    expect(parseEml([...base, 'References: <root@x> <mid@x>', 'In-Reply-To: <mid@x>', '', 'hi'].join('\r\n'), decode).threadHint).toBe('ref:root@x');
    expect(parseEml([...base, 'In-Reply-To: <mid@x>', '', 'hi'].join('\r\n'), decode).threadHint).toBe('ref:mid@x');
    expect(parseEml([...base, '', 'hi'].join('\r\n'), decode).threadHint).toBe('ref:own@x');
    expect(decToHex('255')).toBe('ff'); expect(decToHex('0')).toBe('0');
  });
  it('decodes adjacent encoded words without inserting spaces', () => {
    expect(mimeDecodeWords_('=?UTF-8?B?7ZWc6riA?= =?UTF-8?B?IOygnOuqqQ==?=', decode)).toBe('한글 제목');
  });
});

describe('mbox', () => {
  const msg = (n) => 'From sender@example.com Mon Jul  1 09:00:00 2024\nFrom: a@example.com\nSubject: m' + n + '\n\nbody ' + n + '\n>From quoted line\n';
  it('scans complete messages and leaves the trailing partial one for the next window', () => {
    const bin = msg(1) + msg(2) + 'From x@example.com Mon Jul  1 09:00:00 2024\nSubject: partial';
    const r = mboxScan(bin, false);
    expect(r.messages.length).toBe(2);
    expect(bin.slice(r.messages[1].start, r.messages[1].end)).toBe(msg(2));
    expect(r.nextOffset).toBe(msg(1).length + msg(2).length);
    const end = mboxScan(bin, true);
    expect(end.messages.length).toBe(3);
    expect(end.nextOffset).toBe(bin.length);
  });
  it('unwraps the From line and >From escapes', () => {
    expect(mboxUnwrap(msg(7))).toBe('From: a@example.com\nSubject: m7\n\nbody 7\nFrom quoted line\n');
  });
  it('maps X-Gmail-Labels to label ids and user labels', () => {
    const r = gmailLabelsToIds('Inbox,Important,Category Promotions,거래처/BBB,Opened');
    expect(r.labelIds).toEqual(['INBOX', 'IMPORTANT', 'CATEGORY_PROMOTIONS', 'user:거래처/BBB']);
    expect(r.labelMap).toEqual({ 'user:거래처/BBB': '거래처/BBB' });
    expect(gmailLabelsToIds('보낸편지함').labelIds).toEqual(['SENT']);
  });
});
