/**
 * 웹앱 진입점과 클라이언트(google.script.run)에서 호출하는 함수들.
 */
function doGet() {
  var t = HtmlService.createTemplateFromFile('index');
  t.searchLib = searchClientLib_();
  return t.evaluate()
    .setTitle('Mail Backup')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** lib/search.js의 함수 소스를 클라이언트 스크립트로 내보낸다 (서버와 같은 검색 문법). */
function searchClientLib_() {
  return 'var SEARCH_LIST_KEYS = ' + JSON.stringify(SEARCH_LIST_KEYS) + ';\n' +
    SEARCH_CLIENT_FUNCS.map(function (f) { return f.toString(); }).join('\n');
}

/** 대시보드/이력/설정 화면에 필요한 모든 상태를 한 번에. */
function getDashboard() {
  var status = getStatus_();
  var settings = getSettings_();
  var last = getProp_(PROP.LAST_SYNC_EPOCH, '');
  var c = status.cursor || {};
  var links = appLinks_();
  return {
    state: status.state || 'idle',
    message: status.message || '아직 실행된 적 없음',
    updatedAt: status.updatedAt || null,
    lastSyncAt: last ? new Date(Number(last) * 1000).toISOString() : null,
    schedule: computeSchedule({ lastSyncEpoch: last || null, intervalDays: settings.intervalDays }),
    currentRun: {
      startedAt: c.startedAt || null, finishedAt: c.finishedAt || null, chunks: c.chunks || 0,
      chunkStartedAt: c.chunkStartedAt || null, resumeAt: c.resumeAt || null,
      found: c.found || 0, processed: c.processed || 0, skipped: c.skipped || 0, errors: c.errors || 0,
      bytes: c.bytes || 0, mailFrom: c.mailFrom || null, mailTo: c.mailTo || null, limitHit: !!c.limitHit,
      expectedTotal: c.expectedTotal || 0, manual: !!c.manual,
      byCategory: breakdownList(c.cats || {}).slice(0, 12),
      progress: runProgress(c),
    },
    lastError: c.lastError || null,
    history: loadRunHistory_(),
    summary: summarizeRecords(loadIndexRecords_()),
    settings: settings,
    triggerInstalled: scheduledTriggerInstalled_(),
    folderUrl: links.folderUrl || null,
    indexSheetUrl: links.indexSheetUrl || null,
    webAppUrl: links.webAppUrl || null,
    user: Session.getEffectiveUser().getEmail(),
  };
}

/** 하위 호환: 예전 클라이언트용. */
function getStatus() { return getDashboard(); }

/** 탐색기용 전체 인덱스(본문 제외). 필터링은 클라이언트에서. */
function getExplorerData() {
  var records = loadIndexRecords_();
  return { records: filterRecords(records, {}), summary: summarizeRecords(records), history: loadRunHistory_() };
}

/** 서버 측 검색 (페이지 단위). */
function searchMessages(f) {
  f = f || {};
  var hits = filterRecords(loadIndexRecords_(), f);
  var pageSize = Math.max(1, Math.min(200, Number(f.pageSize) || 50));
  var page = Math.max(1, Number(f.page) || 1);
  var start = (page - 1) * pageSize;
  return { total: hits.length, page: page, pageSize: pageSize, items: hits.slice(start, start + pageSize) };
}

/** 메일 1건의 본문 미리보기(인덱스에 저장된 plain text). */
function getMessageBody(id) {
  return { id: id, body: loadBodyPreview_(id) };
}

function getCategories() {
  return summarizeRecords(loadIndexRecords_()).categories;
}

function getSettings() { return getSettings_(); }

function saveSettings(input) {
  var before = getSettings_();
  var s = saveSettings_(input);
  // 폴더가 바뀌면 인덱스 시트도 새 폴더에서 다시 찾거나 만든다 (BACKUP_FOLDER_ID 자체는 설정 저장에 포함됨)
  if (s.folderId !== before.folderId) props_().deleteProperty(PROP.INDEX_SHEET_ID);
  if (s.intervalDays !== before.intervalDays && scheduledTriggerInstalled_()) setupScheduledTrigger();
  return getDashboard();
}

/** 지금 백업 전 감지: 새 메일 수, 라벨별 건수·용량, 기간. 저장하지 않는다. */
function previewBackup() {
  var p = previewBackup_();
  savePreview_(p);
  return p;
}

/** 지금 백업: 웹 요청 시간 제한을 피하려고 5초 뒤 트리거로 백그라운드 실행. */
function runBackupNow() {
  deleteContinuationTriggers_();
  scheduleContinuation_(5 * 1000);
  var pv = loadPreview_();
  setStatus_({ state: 'queued', message: '대기열 등록 · 곧 시작' + (pv && pv.newCount ? ' (예상 ' + pv.newCount + '건)' : ''), cursor: { expectedTotal: pv ? pv.newCount : 0, manual: true, queuedAt: new Date().toISOString() } });
  return getDashboard();
}

function installWeeklyTrigger() { return installScheduledTrigger(); }
function installScheduledTrigger() {
  setupScheduledTrigger();
  return getDashboard();
}
function uninstallScheduledTrigger() {
  removeScheduledTrigger();
  return getDashboard();
}
