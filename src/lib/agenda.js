/**
 * 제목/요약/라벨을 보고 업무 안건(agenda) 분류를 정한다. 순수 함수.
 * 폴더 분류(Gmail 라벨 기반)와 별개의 두 번째 축이며, 인덱스와 탐색기 필터에 쓰인다.
 * 우선순위는 AGENDA_RULES 순서.
 */
var AGENDA_RULES = [
  { name: '회의/일정', words: ['회의', '미팅', 'meeting', '일정', 'schedule', 'agenda', '안건', '초대', 'invite'] },
  { name: '업무보고/공지', words: ['보고', '공지', 'notice', 'report', '주간', '월간', '결재', '승인', 'announcement'] },
  { name: '계약/재무/발주', words: ['계약', '견적', '발주', '송장', '정산', '청구', 'invoice', 'proposal', '제안', 'quotation', 'payment', '결제'] },
  { name: '업무요청/협조', words: ['요청', '문의', '협조', '부탁', 'request', 'inquiry', 'question'] },
];
var AGENDA_IMPORTANT = '중요업무';
var AGENDA_DEFAULT = '일반업무/기타';
var AGENDA_NAMES = AGENDA_RULES.map(function (r) { return r.name; }).concat([AGENDA_IMPORTANT, AGENDA_DEFAULT]);

function classifyAgenda(subject, snippet, labelIds) {
  var text = (String(subject || '') + ' ' + String(snippet || '')).toLowerCase();
  for (var i = 0; i < AGENDA_RULES.length; i++) {
    var words = AGENDA_RULES[i].words;
    for (var j = 0; j < words.length; j++) {
      if (text.indexOf(words[j]) >= 0) return AGENDA_RULES[i].name;
    }
  }
  if ((labelIds || []).indexOf('IMPORTANT') >= 0) return AGENDA_IMPORTANT;
  return AGENDA_DEFAULT;
}

if (typeof module !== 'undefined') {
  module.exports = { classifyAgenda: classifyAgenda, AGENDA_NAMES: AGENDA_NAMES, AGENDA_RULES: AGENDA_RULES };
}
