/**
 * 트리거 관리. 주기(N일) 트리거 1개 + 시간 제한 시 이어서 실행하는 일회성 트리거.
 */
var BACKUP_FN = 'runBackup';

/** 편집기 또는 웹앱에서 실행: 설정의 intervalDays마다 새벽 03시 runBackup. */
function setupWeeklyTrigger() { return setupScheduledTrigger(); }
function setupScheduledTrigger() {
  removeScheduledTrigger();
  var days = getSettings_().intervalDays;
  var builder = ScriptApp.newTrigger(BACKUP_FN).timeBased().inTimezone(CONFIG.TIME_ZONE).atHour(CONFIG.TRIGGER_HOUR);
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

function scheduleContinuation_(delayMs) {
  ScriptApp.newTrigger(BACKUP_FN).timeBased().after(delayMs || CONFIG.CONTINUE_DELAY_MS).create();
}
