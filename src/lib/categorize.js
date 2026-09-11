/**
 * 메시지의 labelIds를 하나의 백업 카테고리(폴더명)로 매핑한다.
 * 순수 함수: Apps Script 전역과 Node 양쪽에서 동작.
 *
 * 우선순위: 사용자 라벨 > 보낸편지함 > 임시보관함 > Gmail 카테고리 탭 > 받은편지함 > 보관됨
 */
var CATEGORY_NAMES = {
  INBOX: '받은편지함',
  SENT: '보낸편지함',
  DRAFT: '임시보관함',
  CATEGORY_PROMOTIONS: '프로모션',
  CATEGORY_SOCIAL: '소셜',
  CATEGORY_UPDATES: '업데이트',
  CATEGORY_FORUMS: '포럼',
  ARCHIVED: '보관됨',
};

var SYSTEM_LABEL_IDS = {
  INBOX: 1, SENT: 1, DRAFT: 1, SPAM: 1, TRASH: 1, UNREAD: 1, STARRED: 1, IMPORTANT: 1, CHAT: 1,
  CATEGORY_PERSONAL: 1, CATEGORY_PROMOTIONS: 1, CATEGORY_SOCIAL: 1, CATEGORY_UPDATES: 1, CATEGORY_FORUMS: 1,
};

/**
 * @param {string[]|undefined} labelIds Gmail API labelIds
 * @param {Object<string,string>} labelMap labelId -> 사용자 라벨 이름
 * @returns {string} 카테고리 폴더명
 */
function categorize(labelIds, labelMap) {
  var ids = labelIds || [];
  var map = labelMap || {};
  var has = {};
  for (var i = 0; i < ids.length; i++) has[ids[i]] = true;

  // 1. 사용자 라벨 (labelMap에 이름이 있는 것만)
  for (var j = 0; j < ids.length; j++) {
    var id = ids[j];
    if (!SYSTEM_LABEL_IDS[id] && map[id]) {
      return String(map[id]).replace(/\//g, '-');
    }
  }
  if (has.SENT) return CATEGORY_NAMES.SENT;
  if (has.DRAFT) return CATEGORY_NAMES.DRAFT;
  if (has.CATEGORY_PROMOTIONS) return CATEGORY_NAMES.CATEGORY_PROMOTIONS;
  if (has.CATEGORY_SOCIAL) return CATEGORY_NAMES.CATEGORY_SOCIAL;
  if (has.CATEGORY_UPDATES) return CATEGORY_NAMES.CATEGORY_UPDATES;
  if (has.CATEGORY_FORUMS) return CATEGORY_NAMES.CATEGORY_FORUMS;
  if (has.INBOX) return CATEGORY_NAMES.INBOX;
  return CATEGORY_NAMES.ARCHIVED;
}

/** labelIds를 사람이 읽을 이름 배열로 바꾼다 (사용자 라벨은 이름, 시스템 라벨은 그대로). */
function labelNamesOf(labelIds, labelMap) {
  var ids = labelIds || [];
  var map = labelMap || {};
  var out = [];
  for (var i = 0; i < ids.length; i++) out.push(map[ids[i]] || ids[i]);
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { categorize: categorize, labelNamesOf: labelNamesOf, CATEGORY_NAMES: CATEGORY_NAMES };
}
