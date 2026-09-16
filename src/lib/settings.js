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
  splitGmailTabs: false,    // Gmail 탭(프로모션·소셜·업데이트·포럼)을 별도 폴더로 분리
  notifyEmail: '',          // 완료 알림 수신처 (비우면 실행 계정)
  notifyOnComplete: true,   // 완료 시 알림 메일 발송
  syncLabels: true,         // 이미 백업된 메일의 라벨 변경을 Gmail 변경 이력으로 따라감 (폴더 이동 포함)
  ignoreLabels: '',         // 폴더로 만들지 않을 라벨 이름 (쉼표 구분) — 메일 클라이언트가 만든 숨은 라벨 등
  importKeepDays: 30,       // 가져오기가 끝난 원본 파일을 _import/처리됨 으로 옮겨 보관하는 일수 (0 = 옮기지 않음, 지나면 휴지통)
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
  splitGmailTabs: 'SPLIT_GMAIL_TABS',
  notifyEmail: 'NOTIFY_EMAIL',
  notifyOnComplete: 'NOTIFY_ON_COMPLETE',
  syncLabels: 'SYNC_LABELS',
  ignoreLabels: 'IGNORE_LABELS',
  importKeepDays: 'IMPORT_KEEP_DAYS',
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
    splitGmailTabs: toBool_(i.splitGmailTabs, SETTINGS_DEFAULTS.splitGmailTabs),
    notifyEmail: str_(i.notifyEmail),
    notifyOnComplete: toBool_(i.notifyOnComplete, SETTINGS_DEFAULTS.notifyOnComplete),
    syncLabels: toBool_(i.syncLabels, SETTINGS_DEFAULTS.syncLabels),
    ignoreLabels: str_(i.ignoreLabels).split(',').map(function (x) { return x.trim(); }).filter(Boolean).join(', '),
    importKeepDays: toInt_(i.importKeepDays, SETTINGS_DEFAULTS.importKeepDays, 0, 3650),
  };
}
/** 설정의 무시 라벨 목록 → 소문자 키 집합 */
function ignoredLabelSet(settings) {
  var s = {}; String(settings && settings.ignoreLabels || '').split(',').forEach(function (x) { x = x.trim().toLowerCase().replace(/\s+/g, ' '); if (x) s[x] = true; }); return s;
}
/** labelId → 이름 맵에서 무시 라벨을 뺀다 (백업·라벨 동기화용) */
function dropIgnoredLabels(labelMap, settings) {
  var ig = ignoredLabelSet(settings), out = {}; if (!Object.keys(ig).length) return labelMap || {};
  Object.keys(labelMap || {}).forEach(function (id) { if (!ig[String(labelMap[id]).toLowerCase().replace(/\s+/g, ' ')]) out[id] = labelMap[id]; });
  return out;
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
  module.exports = { SETTINGS_DEFAULTS: SETTINGS_DEFAULTS, SETTINGS_PROP_KEYS: SETTINGS_PROP_KEYS, normalizeSettings: normalizeSettings, settingsFromProps: settingsFromProps, settingsToProps: settingsToProps , ignoredLabelSet: ignoredLabelSet, dropIgnoredLabels: dropIgnoredLabels };
}
