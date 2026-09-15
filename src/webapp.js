/**
 * 웹앱 진입점과 클라이언트(google.script.run)에서 호출하는 함수들.
 */
function doGet(e) {
  var t = HtmlService.createTemplateFromFile('index');
  t.searchLib = searchClientLib_();
  t.initialTab = (e && e.parameter && /^(ai|explorer|settings|history)$/.test(e.parameter.tab)) ? e.parameter.tab : ''; // 애드온의 "연결 방법 보기" 링크 (#해시는 iframe 안으로 전달되지 않음)
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
    importHistory: (function () { try { return importHistory_(); } catch (e) { return []; } })(),   // 가져오기 이력 (대시보드·이력 탭에 함께 표시)
    importRun: (function () { try { var st = importStatus_(); var cur = st.cursor || importCursor_() || {}; return { state: st.state || 'idle', message: st.message || '', cursor: cur, progress: importProgress_(cur) }; } catch (e) { return { state: 'idle' }; } })(),
    summary: loadSummary_(), // 캐시 (시트 전체를 매 폴링마다 읽지 않음)
    settings: settings,
    triggerInstalled: scheduledTriggerInstalled_(),
    folderUrl: links.folderUrl || null,
    folderPath: rootFolderPath_(),
    indexSheetUrl: links.indexSheetUrl || null,
    webAppUrl: links.webAppUrl || null,
    user: Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail(),
    isOwner: isOwner_(),
    hasOauthClient: !!oauthClientJson_(), // 실제 값은 AI 연결 탭이 열릴 때 getOauthClientJson()으로만 내려준다
    scriptId: ScriptApp.getScriptId(),
    // Apps Script API(scripts.run)로 실행할 때는 스크립트 ID 대신 배포 ID를 쓴다: 이 배포의 매니페스트에 executionApi가 있어 직원(편집자 아님)도 호출 가능
    deploymentId: (function () { var m = String(links.webAppUrl || '').match(/\/s\/(AKfycb[\w-]+)\//); return m ? m[1] : ''; })(),
    gitSha: typeof MB_GIT_SHA !== 'undefined' ? MB_GIT_SHA : '', // 배포된 코드의 커밋 (npx 버전 고정용)
  };
}

/** 관리자 여부: CONFIG.ADMIN_EMAILS 목록 기준 (Drive 소유자 조회에 의존하지 않음 → drive.file 스코프로 충분). */
function isOwner_() {
  try {
    var me = (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').toLowerCase();
    return !!me && (CONFIG.ADMIN_EMAILS || []).map(function (x) { return String(x).toLowerCase(); }).indexOf(me) >= 0;
  } catch (e) { return false; }
}
function oauthClientJson_() {
  return PropertiesService.getScriptProperties().getProperty('OAUTH_CLIENT_JSON') || (typeof DEFAULT_OAUTH_CLIENT_JSON !== 'undefined' ? DEFAULT_OAUTH_CLIENT_JSON : null);
}
/** MCP용 OAuth 데스크톱 클라이언트 (AI 연결 탭에서만 요청). */
function getOauthClientJson() { return { json: oauthClientJson_() }; }
/** 메일함 사이드바의 라벨 순서 (사용자별, 드래그로 바꾸면 자동 저장) */
function loadLabelOrder_() { try { var v = JSON.parse(PropertiesService.getUserProperties().getProperty('LABEL_ORDER_JSON') || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function saveLabelOrder(order) {
  var list = (Array.isArray(order) ? order : []).map(function (x) { return String(x).slice(0, 200); }).slice(0, 500);
  PropertiesService.getUserProperties().setProperty('LABEL_ORDER_JSON', JSON.stringify(list));
  return { ok: true, labelOrder: list };
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
var EXPLORER_CAP = 6000;   // 브라우저로 한 번에 보내는 최대 건수 (1건 ≈ 1KB)
/**
 * 탐색기 데이터. 인덱스가 EXPLORER_CAP 이하면 전부 보내고 브라우저가 필터링한다.
 * 넘으면 최근 EXPLORER_CAP건만 보내고, 검색어(q)가 있으면 서버가 전체에서 검색해 상위 3000건을 보낸다.
 */
function getExplorerData(opt) {
  opt = opt || {};
  var records = loadIndexRecords_();
  var total = records.length, capped = total > EXPLORER_CAP;
  var out = records;
  if (capped) out = opt.q ? filterRecords(records, { q: opt.q }).slice(0, 3000) : records.slice(-EXPLORER_CAP);
  return { records: capped ? out : filterRecords(records, {}), total: total, capped: capped, summary: loadSummary_(), history: loadRunHistory_(), labelOrder: loadLabelOrder_() };
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
    return cached.preview;
  }
  var p = previewBackup_(opt.scope, opt.sinceDate);
  try { props_().setProperty('PREVIEW_CACHE_JSON', JSON.stringify({ key: key, at: new Date().toISOString(), preview: p })); } catch (e) { /* 크기 초과 등은 무시 */ }
  return p;
}

/** 지금 백업: 웹 요청 시간 제한을 피하려고 5초 뒤 트리거로 백그라운드 실행. */
function runBackupNow() {
  deleteContinuationTriggers_();
  // 감지 결과는 "지금 백업"을 눌렀을 때만 실행 범위로 채택한다 (감지만 하고 취소한 모달이 자동 백업 범위를 바꾸지 않게)
  var pv = null;
  try { var c = JSON.parse(getProp_('PREVIEW_CACHE_JSON', '') || 'null'); if (c && c.preview && Date.now() - new Date(c.at).getTime() < PREVIEW_CACHE_MS) pv = c.preview; } catch (e) { pv = null; }
  if (pv) savePreview_(pv); else props_().deleteProperty(PROP.PREVIEW_JSON);
  // 범위가 바뀐 새 요청이면 이전 실행의 커서를 버린다 (예전 쿼리로 이어가지 않게)
  var old = loadCursor_();
  if (old && pv && (old.scope || 'incremental') !== (pv.scope || 'incremental')) props_().deleteProperty(PROP.CURSOR_JSON);
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
