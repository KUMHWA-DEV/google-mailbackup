/**
 * 사용자 설정 스키마. 스크립트 속성 <-> 설정 객체 변환과 검증. 순수 함수.
 */
var SETTINGS_DEFAULTS = {
  intervalDays: 7,          // 백업 주기(일) 1 이상 (상한 없음)
  initialStartDate: '',     // 첫 실행 시 이 날짜 이후만 (YYYY-MM-DD). 비우면 전체
  includeSent: true,        // 보낸편지함 포함
  saveAttachments: true,    // 첨부 별도 저장
  maxPerRun: 0,             // 회당 최대 저장 건수 (0 = 무제한)
  filterQuery: '',          // 추가 Gmail 검색 조건
  folderId: '',             // 백업 루트 폴더 ID (비우면 자동 생성)
  folderLayout: 'flat',     // flat | yearly | monthly
  folderBy: 'label',        // label(Gmail 라벨/카테고리) | agenda(안건 분류)
  notifyEmail: '',          // 완료 알림 수신처 (비우면 실행 계정)
  notifyOnComplete: true,   // 완료 시 알림 메일 발송
};

var SETTINGS_PROP_KEYS = {
  intervalDays: 'BACKUP_INTERVAL_DAYS',
  initialStartDate: 'INITIAL_START_DATE',
  includeSent: 'INCLUDE_SENT',
  saveAttachments: 'SAVE_ATTACHMENTS',
  maxPerRun: 'MAX_PER_RUN',
  filterQuery: 'FILTER_QUERY',
  folderId: 'BACKUP_FOLDER_ID',
  folderLayout: 'FOLDER_LAYOUT',
  folderBy: 'FOLDER_BY',
  notifyEmail: 'NOTIFY_EMAIL',
  notifyOnComplete: 'NOTIFY_ON_COMPLETE',
};

function toBool_(v, d) {
  if (v === undefined || v === null || v === '') return d;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() !== 'false' && String(v) !== '0';
}
function toInt_(v, d, min, max) {
  var n = parseInt(v, 10);
  if (!isFinite(n)) n = d;
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}
function oneOf_(v, list, d) { return list.indexOf(v) >= 0 ? v : d; }
function str_(v) { return v == null ? '' : String(v).trim(); }

function normalizeSettings(input) {
  var i = input || {};
  var date = str_(i.initialStartDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T00:00:00Z').getTime())) date = '';
  return {
    intervalDays: toInt_(i.intervalDays, SETTINGS_DEFAULTS.intervalDays, 1, 100000),
    initialStartDate: date,
    includeSent: toBool_(i.includeSent, SETTINGS_DEFAULTS.includeSent),
    saveAttachments: toBool_(i.saveAttachments, SETTINGS_DEFAULTS.saveAttachments),
    maxPerRun: toInt_(i.maxPerRun, SETTINGS_DEFAULTS.maxPerRun, 0, 100000),
    filterQuery: str_(i.filterQuery),
    folderId: str_(i.folderId),
    folderLayout: oneOf_(i.folderLayout, ['flat', 'yearly', 'monthly'], SETTINGS_DEFAULTS.folderLayout),
    folderBy: oneOf_(i.folderBy, ['label', 'agenda'], SETTINGS_DEFAULTS.folderBy),
    notifyEmail: str_(i.notifyEmail),
    notifyOnComplete: toBool_(i.notifyOnComplete, SETTINGS_DEFAULTS.notifyOnComplete),
  };
}

/** 스크립트 속성(문자열 맵) -> 설정 객체 */
function settingsFromProps(props) {
  var raw = {};
  Object.keys(SETTINGS_PROP_KEYS).forEach(function (k) {
    var v = (props || {})[SETTINGS_PROP_KEYS[k]];
    if (v !== undefined && v !== null && v !== '') raw[k] = v;
  });
  return normalizeSettings(raw);
}

/** 설정 객체 -> 스크립트 속성(문자열 맵) */
function settingsToProps(settings) {
  var s = normalizeSettings(settings);
  var out = {};
  Object.keys(SETTINGS_PROP_KEYS).forEach(function (k) { out[SETTINGS_PROP_KEYS[k]] = String(s[k]); });
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { SETTINGS_DEFAULTS: SETTINGS_DEFAULTS, SETTINGS_PROP_KEYS: SETTINGS_PROP_KEYS, normalizeSettings: normalizeSettings, settingsFromProps: settingsFromProps, settingsToProps: settingsToProps };
}
