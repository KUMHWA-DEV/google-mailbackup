/**
 * 트리거 관리. 주간 트리거 1개 + 시간 제한 시 이어서 실행하는 일회성 트리거.
 */
var BACKUP_FN = 'runBackup';

/** 편집기 또는 웹앱에서 한 번 실행: 매주 월요일 03~04시 runBackup. */
function setupWeeklyTrigger() {
  removeWeeklyTrigger();
  var t = ScriptApp.newTrigger(BACKUP_FN).timeBased()
    .onWeekDay(ScriptApp.WeekDay[CONFIG.WEEKLY_DAY]).atHour(CONFIG.WEEKLY_HOUR)
    .inTimezone(CONFIG.TIME_ZONE).create();
  props_().setProperty(PROP.WEEKLY_TRIGGER_ID, t.getUniqueId());
  return t.getUniqueId();
}

function removeWeeklyTrigger() {
  var id = getProp_(PROP.WEEKLY_TRIGGER_ID, '');
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getUniqueId() === id) ScriptApp.deleteTrigger(t);
  });
  props_().deleteProperty(PROP.WEEKLY_TRIGGER_ID);
}

function weeklyTriggerInstalled_() {
  var id = getProp_(PROP.WEEKLY_TRIGGER_ID, '');
  if (!id) return false;
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getUniqueId() === id; });
}

/** runBackup을 호출하는 트리거 중 주간 트리거가 아닌 것(=이어서 실행용)을 모두 삭제. */
function deleteContinuationTriggers_() {
  var weeklyId = getProp_(PROP.WEEKLY_TRIGGER_ID, '');
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === BACKUP_FN && t.getUniqueId() !== weeklyId) ScriptApp.deleteTrigger(t);
  });
}

function scheduleContinuation_(delayMs) {
  ScriptApp.newTrigger(BACKUP_FN).timeBased().after(delayMs || CONFIG.CONTINUE_DELAY_MS).create();
}
