/**
 * 웹앱 진입점과 클라이언트(google.script.run)에서 호출하는 함수들.
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Mail Backup')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * @param {{q?:string, category?:string, from?:string, dateFrom?:string, dateTo?:string, page?:number, pageSize?:number}} f
 */
function searchMessages(f) {
  f = f || {};
  var all = loadIndexRecords_();
  var hits = filterRecords(all, f);
  var pageSize = Math.max(1, Math.min(200, Number(f.pageSize) || 50));
  var page = Math.max(1, Number(f.page) || 1);
  var start = (page - 1) * pageSize;
  return {
    total: hits.length,
    page: page,
    pageSize: pageSize,
    items: hits.slice(start, start + pageSize),
  };
}

function getCategories() {
  var seen = {};
  loadIndexRecords_().forEach(function (r) { if (r.category) seen[r.category] = (seen[r.category] || 0) + 1; });
  return Object.keys(seen).sort().map(function (c) { return { name: c, count: seen[c] }; });
}

function getStatus() {
  var status = getStatus_();
  var last = getProp_(PROP.LAST_SYNC_EPOCH, '');
  var sheetId = getProp_(PROP.INDEX_SHEET_ID, '');
  var folderId = getProp_(PROP.FOLDER_ID, '');
  return {
    state: status.state || 'idle',
    message: status.message || '아직 실행된 적 없음',
    updatedAt: status.updatedAt || null,
    lastSyncAt: last ? new Date(Number(last) * 1000).toISOString() : null,
    processed: status.cursor ? status.cursor.processed : 0,
    errors: status.cursor ? status.cursor.errors : 0,
    lastError: status.cursor ? status.cursor.lastError || null : null,
    weeklyTriggerInstalled: weeklyTriggerInstalled_(),
    folderUrl: folderId ? 'https://drive.google.com/drive/folders/' + folderId : null,
    indexSheetUrl: sheetId ? 'https://docs.google.com/spreadsheets/d/' + sheetId : null,
    user: Session.getEffectiveUser().getEmail(),
  };
}

/** 지금 백업: 웹 요청 시간 제한을 피하려고 5초 뒤 트리거로 실행. */
function runBackupNow() {
  deleteContinuationTriggers_();
  scheduleContinuation_(5 * 1000);
  setStatus_({ state: 'queued', message: '수동 실행 요청됨, 잠시 후 시작' });
  return getStatus();
}

function installWeeklyTrigger() {
  setupWeeklyTrigger();
  return getStatus();
}
