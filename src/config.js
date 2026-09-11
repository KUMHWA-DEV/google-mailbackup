/**
 * 설정. 스크립트 속성(프로젝트 설정 > 스크립트 속성)으로 덮어쓸 수 있다.
 *
 *  BACKUP_FOLDER_ID   백업 루트 폴더 ID. 비우면 내 드라이브에 ROOT_FOLDER_NAME 폴더를 만든다.
 *                     개인 계정 드라이브에 넣으려면 그 계정에서 폴더를 만들어 이 계정에
 *                     '편집자'로 공유한 뒤 그 폴더 ID를 넣는다.
 *  SAVE_ATTACHMENTS   'false'면 첨부파일 별도 저장을 끈다 (.eml 안에는 항상 포함).
 *  MAX_RUN_SECONDS    한 번의 실행에서 쓸 최대 시간(초). 기본 270 (6분 제한 대비).
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
  WEEKLY_DAY: 'MONDAY',
  WEEKLY_HOUR: 3,
};

var PROP = {
  FOLDER_ID: 'BACKUP_FOLDER_ID',
  SAVE_ATTACHMENTS: 'SAVE_ATTACHMENTS',
  MAX_RUN_SECONDS: 'MAX_RUN_SECONDS',
  INDEX_SHEET_ID: 'INDEX_SHEET_ID',
  LAST_SYNC_EPOCH: 'LAST_SYNC_EPOCH',
  CURSOR_JSON: 'CURSOR_JSON',
  STATUS_JSON: 'STATUS_JSON',
  WEEKLY_TRIGGER_ID: 'WEEKLY_TRIGGER_ID',
};

function props_() { return PropertiesService.getScriptProperties(); }
function getProp_(key, fallback) {
  var v = props_().getProperty(key);
  return v == null || v === '' ? fallback : v;
}
function saveAttachmentsEnabled_() { return getProp_(PROP.SAVE_ATTACHMENTS, 'true') !== 'false'; }
function maxRunSeconds_() { return Number(getProp_(PROP.MAX_RUN_SECONDS, CONFIG.DEFAULT_MAX_RUN_SECONDS)); }
