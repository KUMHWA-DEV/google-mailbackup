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
  STATUS_EVERY: 5,        // 진행 상태(건수·용량) 기록 주기 — 대시보드 실시간 표시용
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

/**
 * 상태·설정 저장소. 사용자별(UserProperties)이다.
 * 웹앱은 "접속한 사용자"로 실행되므로(appsscript.json webapp.executeAs=USER_ACCESSING) 직원마다
 * 자기 설정·인덱스 시트·백업 폴더·트리거·이력을 따로 가지며, 백업은 각자의 내 드라이브에 들어간다.
 * 트리거로 실행될 때도 트리거를 만든 사용자 권한으로 돌아 같은 사용자 속성을 읽는다.
 */
function props_() { return PropertiesService.getUserProperties(); }
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
