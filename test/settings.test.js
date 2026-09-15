import { describe, it, expect } from 'vitest';
import { SETTINGS_DEFAULTS, normalizeSettings, settingsFromProps, settingsToProps } from '../src/lib/settings.js';

describe('normalizeSettings', () => {
  it('fills defaults for missing values', () => {
    const s = normalizeSettings({});
    expect(s).toEqual(SETTINGS_DEFAULTS);
  });
  it('coerces numbers and clamps ranges', () => {
    const s = normalizeSettings({ intervalDays: '30', maxPerRun: '-5' });
    expect(s.intervalDays).toBe(30);
    expect(s.maxPerRun).toBe(0);
    expect(normalizeSettings({ intervalDays: 400 }).intervalDays).toBe(400); // 상한 없음
    expect(normalizeSettings({ intervalDays: 0 }).intervalDays).toBe(1);
  });
  it('coerces booleans from strings', () => {
    const s = normalizeSettings({ includeSent: 'false', notifyOnComplete: 'true', saveAttachments: false });
    expect(s.includeSent).toBe(false);
    expect(s.notifyOnComplete).toBe(true);
    expect(s.syncLabels).toBe(true); // 기본 켜짐
    expect(normalizeSettings({ ignoreLabels: ' 수신확인 보냄 ,, Notes ' }).ignoreLabels).toBe('수신확인 보냄, Notes');
    expect(s.saveAttachments).toBe(false);
  });
  it('validates date and enums, trims strings', () => {
    const s = normalizeSettings({ initialStartDate: '2026-08-01', folderLayout: 'weird', splitGmailTabs: 'true', filterQuery: '  from:a.com ', notifyEmail: ' me@x.com ' });
    expect(s.initialStartDate).toBe('2026-08-01');
    expect(s.folderLayout).toBe('flat');
    expect(s.splitGmailTabs).toBe(true);
    expect(s.filterQuery).toBe('from:a.com');
    expect(s.notifyEmail).toBe('me@x.com');
    expect(normalizeSettings({ initialStartDate: 'not a date' }).initialStartDate).toBe('');
  });
});

describe('props round trip', () => {
  it('serializes to string props and back', () => {
    const s = normalizeSettings({ intervalDays: 14, includeSent: false, notifyEmail: 'a@b.c' });
    const props = settingsToProps(s);
    Object.values(props).forEach(v => expect(typeof v).toBe('string'));
    expect(settingsFromProps(props)).toEqual(s);
  });
});
