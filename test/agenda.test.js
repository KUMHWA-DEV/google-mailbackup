import { describe, it, expect } from 'vitest';
import { classifyAgenda, AGENDA_NAMES } from '../src/lib/agenda.js';

describe('classifyAgenda', () => {
  it('meeting / schedule keywords', () => {
    expect(classifyAgenda('주간 회의 안내', '', [])).toBe('회의/일정');
    expect(classifyAgenda('Meeting agenda for Monday', '', [])).toBe('회의/일정');
  });
  it('report / notice keywords', () => {
    expect(classifyAgenda('[공지] 사내 보안 교육', '', [])).toBe('업무보고/공지');
    expect(classifyAgenda('Monthly report', '', [])).toBe('업무보고/공지');
  });
  it('contract / finance keywords', () => {
    expect(classifyAgenda('계약서 초안 송부', '', [])).toBe('계약/재무/발주');
    expect(classifyAgenda('Invoice for August', '', [])).toBe('계약/재무/발주');
  });
  it('request / cooperation keywords', () => {
    expect(classifyAgenda('[요청] 자료 확인 부탁드립니다', '', [])).toBe('업무요청/협조');
    expect(classifyAgenda('Inquiry about API', '', [])).toBe('업무요청/협조');
  });
  it('meeting wins over request when both appear (priority order)', () => {
    expect(classifyAgenda('회의 자료 요청', '', [])).toBe('회의/일정');
  });
  it('IMPORTANT label without keywords is 중요업무', () => {
    expect(classifyAgenda('hello', 'world', ['IMPORTANT'])).toBe('중요업무');
  });
  it('falls back to 일반업무/기타', () => {
    expect(classifyAgenda('hello', 'world', [])).toBe('일반업무/기타');
    expect(classifyAgenda(undefined, undefined, undefined)).toBe('일반업무/기타');
  });
  it('searches the snippet too', () => {
    expect(classifyAgenda('제목', '견적서 첨부드립니다', [])).toBe('계약/재무/발주');
  });
  it('exposes the ordered list of names', () => {
    expect(AGENDA_NAMES).toEqual(['회의/일정', '업무보고/공지', '계약/재무/발주', '업무요청/협조', '중요업무', '일반업무/기타']);
  });
});
