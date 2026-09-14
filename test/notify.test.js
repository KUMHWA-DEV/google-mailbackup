import { describe, it, expect } from 'vitest';
import { buildCompletionEmail } from '../src/lib/notify.js';

describe('buildCompletionEmail', () => {
  const run = { startedAt: '2026-09-14T03:00:00.000Z', finishedAt: '2026-09-14T03:04:00.000Z', found: 40, processed: 12, skipped: 28, errors: 1, bytes: 2_500_000, mailFrom: '2026-09-07T00:00:00.000Z', mailTo: '2026-09-13T23:00:00.000Z' };
  const summary = { total: 500, totalBytes: 100_000_000, oldestDate: '2026-07-01T00:00:00.000Z', newestDate: '2026-09-13T23:00:00.000Z' };
  const links = { folderUrl: 'https://drive/f', indexSheetUrl: 'https://sheets/s', webAppUrl: 'https://app' };

  it('subject carries the new-message count', () => {
    const m = buildCompletionEmail(run, summary, links, 'me@spris.com');
    expect(m.subject).toContain('12건');
    expect(m.subject).toContain('[메일 백업 완료]');
  });
  it('html body includes counts, range, size and links, and escapes html', () => {
    const m = buildCompletionEmail(run, summary, { ...links, folderUrl: 'https://drive/f?a=1&b=<x>' }, 'me@spris.com');
    expect(m.htmlBody).toContain('12');
    expect(m.htmlBody).toContain('500');
    expect(m.htmlBody).toContain('2.4 MB');
    expect(m.htmlBody).toContain('https://app');
    expect(m.htmlBody).toContain('&lt;x&gt;');
    expect(m.htmlBody).not.toContain('<x>');
  });
  it('plain text body exists', () => {
    const m = buildCompletionEmail(run, summary, links, 'me@spris.com');
    expect(m.textBody).toContain('신규 저장: 12건');
  });
});
