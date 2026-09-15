/**
 * 트리거 관리. 주기(N일) 트리거 1개 + 시간 제한 시 이어서 실행하는 일회성 트리거.
 */
var BACKUP_FN = 'runBackup';

/** 편집기 또는 웹앱에서 실행: 설정의 intervalDays마다 새벽 03시 runBackup. */
function setupWeeklyTrigger() { return setupScheduledTrigger(); }
function setupScheduledTrigger() {
  removeScheduledTrigger();
  var days = getSettings_().intervalDays;
  // 200명이 같은 시각에 몰리지 않게 계정별로 새벽 1~5시 사이에 분산 (이메일 해시)
  var email = (Session.getEffectiveUser().getEmail() || ''), h = 0; for (var i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  var hour = 1 + (h % 5);
  var builder = ScriptApp.newTrigger(BACKUP_FN).timeBased().inTimezone(CONFIG.TIME_ZONE).atHour(hour);
  var t = days === 7
    ? builder.onWeekDay(ScriptApp.WeekDay.MONDAY).create()
    : builder.everyDays(days).create();
  props_().setProperty(PROP.TRIGGER_ID, t.getUniqueId());
  return t.getUniqueId();
}

function removeWeeklyTrigger() { removeScheduledTrigger(); }
function removeScheduledTrigger() {
  var id = getProp_(PROP.TRIGGER_ID, '');
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getUniqueId() === id) ScriptApp.deleteTrigger(t);
  });
  props_().deleteProperty(PROP.TRIGGER_ID);
}

function scheduledTriggerInstalled_() {
  var id = getProp_(PROP.TRIGGER_ID, '');
  if (!id) return false;
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getUniqueId() === id; });
}

/** runBackup을 호출하는 트리거 중 주기 트리거가 아닌 것(=이어서 실행용)을 모두 삭제. */
function deleteContinuationTriggers_() {
  var keepId = getProp_(PROP.TRIGGER_ID, '');
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === BACKUP_FN && t.getUniqueId() !== keepId) ScriptApp.deleteTrigger(t);
  });
}

/**
 * 이어서 실행 트리거 + 안전망 트리거. 주 트리거(delayMs 뒤)가 지연·유실되거나 구간이 오류로 끝나도
 * 안전망(SAFETY_DELAY_MS 뒤)이 커서 위치부터 다시 이어간다. 다음 구간이 정상 시작되면 runBackup 첫 줄에서 둘 다 지운다.
 */
var SAFETY_DELAY_MS = 15 * 60 * 1000;
function scheduleContinuation_(delayMs, noSafety) {
  ScriptApp.newTrigger(BACKUP_FN).timeBased().after(delayMs || CONFIG.CONTINUE_DELAY_MS).create();
  // 안전망은 트리거가 쌓여 있지 않을 때만 (사용자·스크립트당 20개 한도)
  if (!noSafety && ScriptApp.getProjectTriggers().length < 15) ScriptApp.newTrigger(BACKUP_FN).timeBased().after(Math.max(SAFETY_DELAY_MS, (delayMs || 0) + 5 * 60 * 1000)).create();
}
