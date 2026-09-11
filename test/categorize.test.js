import { describe, it, expect } from 'vitest';
import { categorize, CATEGORY_NAMES } from '../src/lib/categorize.js';

const labelMap = { Label_1: '프로젝트A', Label_2: '거래처/BBB' };

describe('categorize', () => {
  it('user label wins over everything', () => {
    expect(categorize(['INBOX', 'SENT', 'Label_1'], labelMap)).toBe('프로젝트A');
  });
  it('nested user label slashes become dashes', () => {
    expect(categorize(['Label_2'], labelMap)).toBe('거래처-BBB');
  });
  it('SENT beats INBOX and categories', () => {
    expect(categorize(['SENT', 'INBOX', 'CATEGORY_UPDATES'], labelMap)).toBe(CATEGORY_NAMES.SENT);
  });
  it('DRAFT', () => {
    expect(categorize(['DRAFT'], labelMap)).toBe(CATEGORY_NAMES.DRAFT);
  });
  it('gmail category tabs map to Korean names', () => {
    expect(categorize(['INBOX', 'CATEGORY_PROMOTIONS'], labelMap)).toBe('프로모션');
    expect(categorize(['INBOX', 'CATEGORY_SOCIAL'], labelMap)).toBe('소셜');
    expect(categorize(['INBOX', 'CATEGORY_UPDATES'], labelMap)).toBe('업데이트');
    expect(categorize(['INBOX', 'CATEGORY_FORUMS'], labelMap)).toBe('포럼');
  });
  it('plain inbox (primary tab)', () => {
    expect(categorize(['INBOX', 'CATEGORY_PERSONAL', 'UNREAD'], labelMap)).toBe('받은편지함');
  });
  it('no inbox and no labels means archived', () => {
    expect(categorize(['IMPORTANT'], labelMap)).toBe('보관됨');
    expect(categorize([], labelMap)).toBe('보관됨');
    expect(categorize(undefined, labelMap)).toBe('보관됨');
  });
  it('unknown label id without a name is ignored', () => {
    expect(categorize(['Label_999', 'INBOX'], labelMap)).toBe('받은편지함');
  });
});
