/**
 * 고정 설정과 스크립트 속성 접근.
 * 사용자 설정(주기, 시작 기준일, 알림 등)은 lib/settings.js 스키마를 따르며
 * 웹앱 설정 화면 또는 프로젝트 설정 > 스크립트 속성에서 바꿀 수 있다.
 */
var CONFIG = {
  ROOT_FOLDER_NAME: 'Mail Backup',
  INDEX_SHEET_NAME: 'Mail Backup Index',
  ATTACHMENT_FOLDER_NAME: '_attachments',
  TIME_ZONE: 'Asia/Seoul',
  DEFAULT_MAX_RUN_SECONDS: 270,
  PAGE_SIZE: 100,
  INDEX_FLUSH_EVERY: 20,
  CONTINUE_DELAY_MS: 60 * 1000,
  TRIGGER_HOUR: 3,
};

/** 내부 상태용 속성 키 (사용자 설정 키는 SETTINGS_PROP_KEYS) */
var PROP = {
  MAX_RUN_SECONDS: 'MAX_RUN_SECONDS',
  INDEX_SHEET_ID: 'INDEX_SHEET_ID',
  LAST_SYNC_EPOCH: 'LAST_SYNC_EPOCH',
  CURSOR_JSON: 'CURSOR_JSON',
  STATUS_JSON: 'STATUS_JSON',
  RUN_HISTORY_JSON: 'RUN_HISTORY_JSON',
  PREVIEW_JSON: 'PREVIEW_JSON',
  TRIGGER_ID: 'WEEKLY_TRIGGER_ID',
  FOLDER_ID: 'BACKUP_FOLDER_ID',
};

function props_() { return PropertiesService.getScriptProperties(); }
function getProp_(key, fallback) {
  var v = props_().getProperty(key);
  return v == null || v === '' ? fallback : v;
}
function maxRunSeconds_() { return Number(getProp_(PROP.MAX_RUN_SECONDS, CONFIG.DEFAULT_MAX_RUN_SECONDS)); }

var settingsCache_ = null;
/** 현재 사용자 설정 (스크립트 속성에서 읽어 정규화). 실행 중 캐시. */
function getSettings_() {
  if (!settingsCache_) settingsCache_ = settingsFromProps(props_().getProperties());
  return settingsCache_;
}
function saveSettings_(input) {
  var s = normalizeSettings(input);
  props_().setProperties(settingsToProps(s), false);
  settingsCache_ = s;
  return s;
}
