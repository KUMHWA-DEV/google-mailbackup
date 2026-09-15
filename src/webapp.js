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
  return 'var SEARCH_LIST_KEYS = ' + JSON.stringify(SEARCH_LIST_KEYS) + ';\nvar SEARCH_ALIASES = null;\nvar ALIAS_GENERIC_LOCAL = ' + JSON.stringify(ALIAS_GENERIC_LOCAL) + ';\n' +
    SEARCH_CLIENT_FUNCS.map(function (f) { return f.toString(); }).join('\n');
}

/** 대시보드/이력/설정 화면에 필요한 모든 상태를 한 번에. */
function getDashboard() {
  var status = reconcileStatus_();
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
      chunkStartedAt: c.chunkStartedAt || null, resumeAt: c.resumeAt || null, resumeReason: c.resumeReason || null,
      found: c.found || 0, processed: c.processed || 0, skipped: c.skipped || 0, errors: c.errors || 0,
      bytes: c.bytes || 0, mailFrom: c.mailFrom || null, mailTo: c.mailTo || null, limitHit: !!c.limitHit,
      expectedTotal: c.expectedTotal || 0, manual: !!c.manual,
      byCategory: breakdownList(c.cats || {}).slice(0, 12),
      progress: runProgress(c),
    },
    lastError: c.lastError || null,
    errorStack: status.errorStack || null,
    queuedAt: c.queuedAt || null,
    triggerError: c.triggerError || null,
    history: loadRunHistory_(),
    summary: summarizeRecords(loadIndexRecords_()),
    settings: settings,
    triggerInstalled: scheduledTriggerInstalled_(),
    folderUrl: links.folderUrl || null,
    folderPath: rootFolderPath_(),
    indexSheetUrl: links.indexSheetUrl || null,
    webAppUrl: links.webAppUrl || null,
    user: Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail(),
    isOwner: isOwner_(),
    oauthClientJson: PropertiesService.getScriptProperties().getProperty('OAUTH_CLIENT_JSON') || (typeof DEFAULT_OAUTH_CLIENT_JSON !== 'undefined' ? DEFAULT_OAUTH_CLIENT_JSON : null), // 관리자 등록값 > 배포에 동봉된 src/oauth_client.js(git 제외)
    scriptId: ScriptApp.getScriptId(),
    gitSha: typeof MB_GIT_SHA !== 'undefined' ? MB_GIT_SHA : '', // 배포된 코드의 커밋 (npx 버전 고정용)
  };
}

/** 스크립트 소유자 여부 (관리자 카드 표시용). */
function isOwner_() {
  try {
    var sp = PropertiesService.getScriptProperties();
    var owner = sp.getProperty('OWNER_EMAIL');
    if (!owner) { owner = DriveApp.getFileById(ScriptApp.getScriptId()).getOwner().getEmail(); sp.setProperty('OWNER_EMAIL', owner); }
    var me = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
    return !!me && me.toLowerCase() === String(owner).toLowerCase();
  } catch (e) { return false; }
}

/** 관리자(소유자)만: MCP용 OAuth 데스크톱 클라이언트 JSON을 저장/삭제. 직원은 AI 연결 탭에서 내려받는다. */
function saveOauthClientJson(json) {
  if (!isOwner_()) throw new Error('스크립트 소유자만 설정할 수 있습니다');
  var sp = PropertiesService.getScriptProperties();
  if (!json || !String(json).trim()) { sp.deleteProperty('OAUTH_CLIENT_JSON'); return getDashboard(); }
  var obj = JSON.parse(json);
  var c = obj.installed || obj.web || obj;
  if (!c.client_id || !c.client_secret) throw new Error('client_id / client_secret 이 없는 파일입니다. GCP 콘솔에서 "데스크톱 앱" 유형으로 만든 JSON을 넣으세요');
  sp.setProperty('OAUTH_CLIENT_JSON', JSON.stringify({ installed: { client_id: c.client_id, client_secret: c.client_secret, project_id: c.project_id || '', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', redirect_uris: ['http://localhost'] } }));
  return getDashboard();
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

/**
 * 지금 백업 전 감지: 새 메일 수, 라벨별 건수·용량, 기간. 저장하지 않는다.
 * @param {{scope?:'incremental'|'all'|'since', sinceDate?:string}} [opt] 범위. 없으면 첫 백업=all, 그 외=incremental
 */
function previewBackup(opt) {
  opt = opt || {};
  var key = (opt.scope || 'auto') + '|' + (opt.sinceDate || '') + '|' + getProp_(PROP.LAST_SYNC_EPOCH, '');
  var cached = null;
  try { cached = JSON.parse(getProp_('PREVIEW_CACHE_JSON', '') || 'null'); } catch (e) { cached = null; }
  if (cached && cached.key === key && Date.now() - new Date(cached.at).getTime() < PREVIEW_CACHE_MS) {
    cached.preview.cached = true;
    savePreview_(cached.preview);
    return cached.preview;
  }
  var p = previewBackup_(opt.scope, opt.sinceDate);
  savePreview_(p);
  try { props_().setProperty('PREVIEW_CACHE_JSON', JSON.stringify({ key: key, at: new Date().toISOString(), preview: p })); } catch (e) { /* 크기 초과 등은 무시 */ }
  return p;
}

/** 지금 백업: 웹 요청 시간 제한을 피하려고 5초 뒤 트리거로 백그라운드 실행. */
function runBackupNow() {
  deleteContinuationTriggers_();
  var pv = loadPreview_();
  var triggerError = '';
  try { scheduleContinuation_(5 * 1000); } catch (e) { triggerError = String(e && e.message || e); }
  setStatus_({ state: 'queued', message: triggerError ? '트리거 생성 실패 · 브라우저에서 직접 실행합니다' : '대기열 등록 · 곧 시작' + (pv && pv.newCount ? ' (예상 ' + pv.newCount + '건)' : ''),
    cursor: { expectedTotal: pv ? pv.newCount : 0, manual: true, queuedAt: new Date().toISOString(), triggerError: triggerError || null } });
  return getDashboard();
}

/**
 * 앱 연결 끊기: 이 사용자의 권한 승인을 취소한다. 자동 백업 트리거도 제거한다(권한이 없으면 실행 실패하므로).
 * 백업 파일·인덱스·설정은 남는다. 다음 접속 때 다시 승인하면 그대로 이어서 쓸 수 있다.
 */
function disconnectApp() {
  try { removeScheduledTrigger(); deleteContinuationTriggers_(); } catch (e) { /* 무시 */ }
  ScriptApp.invalidateAuth();
  return { ok: true };
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
