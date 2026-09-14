/**
 * 백업 오케스트레이션. 트리거/수동 실행 진입점은 runBackup().
 *
 * 실행 흐름
 *  1. 커서(CURSOR_JSON)가 있으면 이어서, 없으면 새 실행(쿼리 생성, 시작 시각 기록)
 *  2. 페이지 단위로 id 목록 → 인덱스에 없는 것만 저장
 *  3. MAX_RUN_SECONDS 초과 시 커서 저장 후 1분 뒤 이어서 실행되는 트리거 생성
 *  4. 페이지 소진(또는 회당 최대 건수 도달) 시 LAST_SYNC_EPOCH = 이번 실행 시작 시각,
 *     커서 삭제, 실행 이력 기록, 알림 메일 발송
 */
function runBackup() {
  var lock = LockService.getUserLock(); // 사용자별 잠금: 같은 사람의 백업만 겹치지 않게
  if (!lock.tryLock(10 * 1000)) {
    Logger.log('다른 백업 실행이 진행 중이라 건너뜁니다.');
    return;
  }
  try {
    deleteContinuationTriggers_();
    runBackupLocked_();
  } catch (e) {
    var msg = String(e && e.message || e);
    var cur = e.cursor || loadCursor_() || (getStatus_().cursor || {});
    if (isQuotaError_(msg)) {
      // Gmail 분당 할당량(사용자당 15,000단위) 초과: 실패가 아니라 잠시 뒤 이어서 실행
      cur.resumeAt = new Date(Date.now() + QUOTA_BACKOFF_MS).toISOString();
      cur.quotaHits = (cur.quotaHits || 0) + 1;
      saveCursor_(cur);
      try { scheduleContinuation_(QUOTA_BACKOFF_MS); } catch (e2) { Logger.log('재개 트리거 생성 실패: %s', e2.message); }
      setStatus_({ state: 'running', message: 'Gmail 분당 할당량 초과 · ' + Math.round(QUOTA_BACKOFF_MS / 60000) + '분 뒤 자동 재개 (' + cur.processed + '건 저장됨)', cursor: cur });
      Logger.log('할당량 초과, %s 후 재개', QUOTA_BACKOFF_MS);
      return;
    }
    // 그 외 예외: 상태에 남겨 대시보드/애드온에서 보이게 한다 (안 그러면 '대기 중'으로 영원히 보임)
    cur.lastError = msg;
    cur.failedAt = new Date().toISOString();
    saveCursor_(cur); // 다시 시도하면 저장된 위치부터
    Logger.log('runBackup 실패: %s', e && e.stack || e);
    setStatus_({ state: 'error', message: '실행 실패: ' + msg, cursor: cur, errorStack: String(e && e.stack || '') });
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 브라우저에서 직접 이어 실행 (트리거가 안 돌 때의 대체 경로). 한 구간(최대 4분 30초)만 돌고 상태를 돌려준다.
 * 클라이언트가 running 상태인 동안 반복 호출한다. 같은 사용자의 트리거 실행과 겹치면 사용자 잠금으로 건너뛴다.
 */
function runBackupInline() {
  var c = loadCursor_();
  if (c && c.resumeAt && new Date(c.resumeAt) > new Date()) return getDashboard(); // 재개 시각 전이면 대기 (클라이언트가 기다림)
  try { runBackup(); } catch (e) { /* 상태에 기록됨 */ }
  return getDashboard();
}

var QUOTA_BACKOFF_MS = 2 * 60 * 1000;
function isQuotaError_(msg) { return /quota|rate ?limit|too many|429|user-rate/i.test(String(msg || '')); }

function runBackupLocked_() {
  var startedAt = Date.now();
  var deadline = startedAt + maxRunSeconds_() * 1000;
  var settings = getSettings_();
  var cursor = loadCursor_();
  var isNewRun = !cursor;
  if (isNewRun) {
    var preview = loadPreview_();
    cursor = {
      // 수동 실행이면 감지 모달에서 고른 범위(전체/날짜부터/증분)를, 자동 실행이면 증분을 쓴다.
      query: scopeQuery_(preview && preview.manual ? preview.scope : 'incremental', preview && preview.sinceDate, settings),
      scope: preview && preview.manual ? (preview.scope || 'incremental') : 'incremental',
      pageToken: null,
      runStartEpoch: Math.floor(startedAt / 1000),
      startedAt: new Date(startedAt).toISOString(),
      found: 0, processed: 0, skipped: 0, errors: 0, chunks: 0,
      bytes: 0, mailFrom: null, mailTo: null, limitHit: false,
      expectedTotal: preview ? preview.newCount : 0, // 미리보기에서 감지한 새 메일 수 (진행률용)
      cats: {}, // 라벨(카테고리)별 {count, bytes}
      manual: !!(preview && preview.manual),
    };
    props_().deleteProperty(PROP.PREVIEW_JSON);
  }
  cursor.chunks += 1;
  cursor.chunkStartedAt = new Date().toISOString();
  setStatus_({ state: 'running', message: (isNewRun ? '새 백업 시작' : '이어서 실행') + ' (' + cursor.chunks + '번째 구간)', cursor: cursor });
  Logger.log('백업 %s: query="%s" pageToken=%s', isNewRun ? '시작' : '재개', cursor.query, cursor.pageToken || '-');

  var labelMap, sheet, backedUp;
  try { labelMap = fetchLabelMap_(); sheet = indexSheet_(); backedUp = loadBackedUpIds_(sheet); }
  catch (e0) { e0.cursor = cursor; throw e0; }
  var pending = [];
  var outOfTime = false;
  var maxPerRun = settings.maxPerRun || 0;

  try {
    while (true) {
      var page = listMessageIds_(cursor.query, cursor.pageToken);
      cursor.found += page.ids.length;
      for (var i = 0; i < page.ids.length; i++) {
        var id = page.ids[i];
        if (backedUp[id]) { cursor.skipped += 1; continue; }
        if (maxPerRun && cursor.processed >= maxPerRun) { cursor.limitHit = true; break; }
        try {
          var row = backupOne_(id, labelMap, settings);
          pending.push(row);
          backedUp[id] = true;
          cursor.processed += 1;
          noteRowStats_(cursor, row);
        } catch (e) {
          cursor.errors += 1;
          cursor.lastError = id + ': ' + e.message;
          Logger.log('메시지 %s 백업 실패: %s', id, e.stack || e.message);
        }
        if (pending.length >= CONFIG.INDEX_FLUSH_EVERY) { appendIndexRows_(sheet, pending); pending = []; }
        if ((cursor.processed + cursor.errors) % CONFIG.STATUS_EVERY === 0) setStatus_({ state: 'running', message: '저장 중 ' + cursor.processed + '건' + (cursor.expectedTotal ? ' / ' + cursor.expectedTotal : ''), cursor: cursor });
        if (Date.now() > deadline) { outOfTime = true; break; }
      }
      if (outOfTime || cursor.limitHit) break; // 시간 초과: 같은 pageToken으로 재개 (중복은 id로 걸러짐)
      cursor.pageToken = page.nextPageToken || null;
      if (!cursor.pageToken) break;
      if (Date.now() > deadline) { outOfTime = true; break; }
    }
  } catch (e) {
    // 루프 중 예외(할당량 등): 지금까지 저장한 행을 기록하고 커서를 예외에 실어 올린다
    appendIndexRows_(sheet, pending); pending = [];
    e.cursor = cursor;
    throw e;
  } finally {
    appendIndexRows_(sheet, pending);
  }

  if (outOfTime) {
    cursor.resumeAt = new Date(Date.now() + CONFIG.CONTINUE_DELAY_MS).toISOString();
    saveCursor_(cursor);
    scheduleContinuation_();
    setStatus_({ state: 'running', message: '구간 ' + cursor.chunks + ' 완료 · 1분 뒤 이어서 실행', cursor: cursor });
    Logger.log('시간 제한. 처리 %s건, 이어서 실행 예약.', cursor.processed);
    return;
  }

  // 회당 최대 건수에 걸렸으면 다음 실행에서 이어받도록 마지막 동기화 시각을 올리지 않는다.
  if (!cursor.limitHit) props_().setProperty(PROP.LAST_SYNC_EPOCH, String(cursor.runStartEpoch));
  props_().deleteProperty(PROP.CURSOR_JSON);
  cursor.finishedAt = new Date().toISOString();
  appendRunHistory_(cursor);
  setStatus_({
    state: 'idle',
    message: '완료: 감지 ' + cursor.found + '건, 새로 ' + cursor.processed + '건 저장, ' + cursor.skipped + '건 이미 있음, 오류 ' + cursor.errors + '건' +
      (cursor.limitHit ? ' (회당 최대 ' + maxPerRun + '건 도달, 나머지는 다음 실행)' : ''),
    cursor: cursor,
    finishedAt: cursor.finishedAt,
  });
  Logger.log('백업 완료. 새 %s건, 건너뜀 %s건, 오류 %s건', cursor.processed, cursor.skipped, cursor.errors);
  sendCompletionNotice_(cursor, settings);
}

/** 메시지 1건을 저장하고 인덱스 행을 돌려준다. */
function backupOne_(id, labelMap, settings) {
  var m = fetchMessage_(id);
  var category = categorize(m.labelIds, labelMap);
  var agenda = classifyAgenda(m.headers.subject, m.snippet, m.labelIds);
  var folderName = settings.folderBy === 'agenda' ? agenda.replace(/\//g, '-') : category;
  var folder = ensureFolderPath_(buildFolderPath(folderName, m.date, CONFIG.TIME_ZONE, settings.folderLayout));
  var fileName = buildFileName({ date: m.date, subject: m.headers.subject, id: m.id }, CONFIG.TIME_ZONE);
  var saved = saveEml_(folder, fileName, m.rawBytes);
  var attachmentFiles = saveAttachments_(m.id, m.attachments);
  // 첨부 별도 저장을 껐어도 이름은 기록해 두어 목록/필터에 보이게 한다.
  var attachmentNames = attachmentFiles.length
    ? attachmentFiles.map(function (f) { return f.name; })
    : (m.attachments || []).map(function (a, i) { return a.getName() || ('attachment-' + (i + 1)); });
  return buildIndexRow({
    id: m.id, threadId: m.threadId, date: m.date, category: category, agenda: agenda,
    labelNames: labelNamesOf(m.labelIds, labelMap), headers: m.headers, snippet: m.snippet,
    sizeEstimate: m.sizeEstimate, attachmentNames: attachmentNames, attachmentFiles: attachmentFiles, bodyPreview: m.bodyPreview,
    driveFileId: saved.fileId, driveUrl: saved.url, backedUpAt: new Date(),
  });
}

/** 이번 실행의 용량 합계, 메일 날짜 범위, 라벨별 분포를 커서에 누적. */
function noteRowStats_(cursor, row) {
  var rec = rowToRecord(row);
  cursor.bytes += Number(rec.sizeBytes) || 0;
  if (!cursor.cats) cursor.cats = {};
  addToBreakdown(cursor.cats, rec.category, rec.sizeBytes);
  var d = rec.date ? String(rec.date) : '';
  if (d && (!cursor.mailFrom || d < cursor.mailFrom)) cursor.mailFrom = d;
  if (d && (!cursor.mailTo || d > cursor.mailTo)) cursor.mailTo = d;
}

var RUN_HISTORY_MAX = 12;

/** 완료된 실행 요약을 최근 12개까지 보관. */
function appendRunHistory_(cursor) {
  var hist = loadRunHistory_();
  hist.unshift({
    startedAt: cursor.startedAt, finishedAt: cursor.finishedAt, chunks: cursor.chunks,
    found: cursor.found, processed: cursor.processed, skipped: cursor.skipped, errors: cursor.errors,
    bytes: cursor.bytes, mailFrom: cursor.mailFrom, mailTo: cursor.mailTo, query: cursor.query,
    limitHit: !!cursor.limitHit, notifiedTo: cursor.notifiedTo || null,
    manual: !!cursor.manual, expectedTotal: cursor.expectedTotal || 0, scope: cursor.scope || 'incremental',
    byCategory: breakdownList(cursor.cats || {}).slice(0, 12),
  });
  props_().setProperty(PROP.RUN_HISTORY_JSON, JSON.stringify(hist.slice(0, RUN_HISTORY_MAX)));
}
function loadRunHistory_() {
  try { return JSON.parse(getProp_(PROP.RUN_HISTORY_JSON, '[]')) || []; } catch (e) { return []; }
}

/** 완료 알림 메일. 실패해도 백업 결과에는 영향 없음. */
function sendCompletionNotice_(cursor, settings) {
  if (!settings.notifyOnComplete) return;
  var to = settings.notifyEmail || Session.getEffectiveUser().getEmail();
  if (!to) return;
  try {
    var summary = summarizeRecords(loadIndexRecords_());
    var mail = buildCompletionEmail(cursor, summary, appLinks_(), Session.getEffectiveUser().getEmail());
    MailApp.sendEmail({ to: to, subject: mail.subject, htmlBody: mail.htmlBody, body: mail.textBody, name: 'Mail Backup' });
    cursor.notifiedTo = to;
    var hist = loadRunHistory_();
    if (hist.length) { hist[0].notifiedTo = to; props_().setProperty(PROP.RUN_HISTORY_JSON, JSON.stringify(hist)); }
  } catch (e) {
    Logger.log('알림 메일 발송 실패: %s', e.message);
  }
}

function appLinks_() {
  var sheetId = getProp_(PROP.INDEX_SHEET_ID, '');
  var folderId = getProp_(PROP.FOLDER_ID, '') || getSettings_().folderId;
  var webAppUrl = '';
  try { webAppUrl = ScriptApp.getService().getUrl() || ''; } catch (e) { webAppUrl = ''; }
  return {
    folderUrl: folderId ? 'https://drive.google.com/drive/folders/' + folderId : '',
    indexSheetUrl: sheetId ? 'https://docs.google.com/spreadsheets/d/' + sheetId : '',
    webAppUrl: webAppUrl,
  };
}

// ---------- 미리보기(감지) ----------

var PREVIEW_DETAIL_MAX = 150;      // 상세(크기·라벨)까지 읽는 새 메일 수 상한 (Gmail 분당 할당량 15,000단위 고려, 150건 ≈ 750단위)
var PREVIEW_CACHE_MS = 3 * 60 * 1000; // 같은 범위 재감지는 3분간 캐시
var PREVIEW_TIME_BUDGET_MS = 40000; // 웹 요청 안에서 끝내기 위한 시간 예산

/**
 * 다음 백업에서 저장될 메일을 감지해 라벨별 건수·용량·기간을 돌려준다. 저장은 하지 않는다.
 * 새 메일이 PREVIEW_DETAIL_MAX보다 많으면 표본으로 추정(estimated=true).
 */
/**
 * 백업 범위 → Gmail 쿼리.
 *  scope: 'incremental'(마지막 백업 이후, 기본) | 'all'(전체, 저장된 건 id로 건너뜀) | 'since'(sinceDate부터)
 */
function scopeQuery_(scope, sinceDate, settings) {
  var lastSync = getProp_(PROP.LAST_SYNC_EPOCH, null);
  if (scope === 'all') return buildQuery(null, Object.assign({}, settings, { initialStartDate: '' }));
  if (scope === 'since' && sinceDate) return buildQuery(null, Object.assign({}, settings, { initialStartDate: sinceDate }));
  return buildQuery(lastSync, settings);
}

function previewBackup_(scope, sinceDate) {
  var t0 = Date.now();
  var settings = getSettings_();
  var lastSync = getProp_(PROP.LAST_SYNC_EPOCH, null);
  var isFirst = !lastSync;
  if (!scope) scope = isFirst ? 'all' : 'incremental';
  var query = scopeQuery_(scope, sinceDate, settings);
  var backedUp = loadBackedUpIds_(indexSheet_());
  var labelMap = fetchLabelMap_();
  // 첫 백업이면 메일함 전체 건수를 프로필에서 즉시 가져온다 (수만 건이어도 1회 호출).
  var mailboxTotal = 0;
  var wholeBox = scope === 'all' && !settings.filterQuery; // 메일함 전체가 대상이면 프로필 건수로 보정 가능
  if (wholeBox) { try { mailboxTotal = Number(Gmail.Users.getProfile('me').messagesTotal) || 0; } catch (e) { mailboxTotal = 0; } }
  var found = 0, skipped = 0, newIds = [], pageToken = null, truncated = false;
  do {
    var page = listMessageIds_(query, pageToken);
    found += page.ids.length;
    page.ids.forEach(function (id) { if (backedUp[id]) skipped += 1; else newIds.push(id); });
    pageToken = page.nextPageToken || null;
    // 전체 범위는 표본 300건만 있으면 되므로 목록을 끝까지 세지 않는다 (전체 건수는 프로필 값 사용).
    if (wholeBox && mailboxTotal && skipped === 0 && newIds.length >= PREVIEW_DETAIL_MAX) { truncated = !!pageToken; break; }
    if (Date.now() - t0 > PREVIEW_TIME_BUDGET_MS / 2) { truncated = !!pageToken; break; }
  } while (pageToken);
  var metas = [];
  for (var i = 0; i < newIds.length && i < PREVIEW_DETAIL_MAX; i++) {
    if (Date.now() - t0 > PREVIEW_TIME_BUDGET_MS) break;
    try {
      var m = fetchMessageMeta_(newIds[i]);
      metas.push({ category: categorize(m.labelIds, labelMap), sizeBytes: m.sizeBytes, date: m.date, from: nameOrAddress_(m.from) });
    } catch (e) { /* 표본에서 제외 */ }
  }
  // 목록 조회가 시간 예산에 걸려 잘렸으면(첫 백업·대량), 전체 건수는 프로필 값으로 보정한다.
  var newCount = newIds.length;
  if (truncated && wholeBox && mailboxTotal > found) newCount = Math.max(newCount, mailboxTotal - skipped);
  var agg = aggregatePreview({ found: found, skipped: skipped, newCount: newCount, metas: metas, detailed: metas.length });
  // 표본은 최신 메일부터라 mailFrom이 표본(300건)의 최소 날짜가 된다. 새 메일이 표본보다 많으면 실제 가장 오래된 날짜로 바꾼다.
  //  - 목록을 끝까지 셌으면(잘리지 않음): 목록은 최신순이므로 마지막 id가 가장 오래된 메일 → 1회 조회
  //  - 목록이 잘렸으면: before: 이진 탐색
  var oldest = null;
  try {
    if (truncated) {
      oldest = findOldestMailDate_(query); // 목록이 잘렸으면 표본 밖에 더 오래된 메일이 있으므로 항상 탐색 (호출 약 13회)
    } else if (newIds.length > metas.length) {
      oldest = fetchMessageMeta_(newIds[newIds.length - 1]).date || null; // 목록은 최신순 → 마지막 id가 가장 오래된 메일
    }
  } catch (e) { Logger.log('가장 오래된 메일 조회 실패: %s', e.message); }
  if (oldest) { agg.mailFrom = oldest; agg.mailFromExact = true; }
  else if (!truncated && newIds.length === metas.length) agg.mailFromExact = true; // 전부 상세를 읽었으므로 정확
  else agg.mailFromExact = false;
  agg.query = query;
  agg.truncated = truncated;
  agg.isFirst = isFirst;
  agg.scope = scope;
  agg.sinceDate = scope === 'since' ? (sinceDate || '') : '';
  agg.mailboxTotal = mailboxTotal;
  agg.initialStartDate = settings.initialStartDate || '';
  agg.estimatedSeconds = estimateRunSeconds(settings.maxPerRun ? Math.min(newCount, settings.maxPerRun) : newCount);
  agg.lastSyncAt = getProp_(PROP.LAST_SYNC_EPOCH, '') ? new Date(Number(getProp_(PROP.LAST_SYNC_EPOCH, '')) * 1000).toISOString() : null;
  agg.previewedAt = new Date().toISOString();
  agg.elapsedMs = Date.now() - t0;
  return agg;
}
/**
 * 쿼리에 해당하는 가장 오래된 메일의 날짜(ISO)를 이진 탐색으로 찾는다 (하루 단위, 목록 호출 약 13회).
 * Gmail 목록은 최신순만 지원해 최소 날짜를 바로 얻을 수 없기 때문.
 */
function findOldestMailDate_(query) {
  var hasBefore = function (day) {
    var res = Gmail.Users.Messages.list('me', { q: query + ' before:' + day, maxResults: 1 });
    return !!(res.messages && res.messages.length);
  };
  var fmt = function (ms) { return Utilities.formatDate(new Date(ms), 'UTC', 'yyyy/MM/dd'); };
  var DAY = 86400000;
  var lo = Date.UTC(2004, 3, 1), hi = Date.now() + DAY; // [lo, hi): lo 이전엔 없음, hi 이전엔 있음
  try {
    if (!hasBefore(fmt(hi))) return null;
    while (hi - lo > DAY) {
      var mid = lo + Math.floor((hi - lo) / 2 / DAY) * DAY;
      if (mid <= lo) break;
      if (hasBefore(fmt(mid))) hi = mid; else lo = mid;
    }
    var res = Gmail.Users.Messages.list('me', { q: query + ' before:' + fmt(hi), maxResults: 1 });
    var id = res.messages && res.messages[0] && res.messages[0].id;
    if (!id) return null;
    var m = Gmail.Users.Messages.get('me', id, { format: 'minimal' });
    return m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null;
  } catch (e) {
    Logger.log('가장 오래된 메일 탐색 실패: %s', e.message);
    return null;
  }
}

function nameOrAddress_(addr) {
  var s = String(addr || '');
  var m = s.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  return m ? (m[1].trim() || m[2]) : s.trim();
}
function savePreview_(p) { props_().setProperty(PROP.PREVIEW_JSON, JSON.stringify({ newCount: p.newCount, bytes: p.bytes, manual: true, previewedAt: p.previewedAt, scope: p.scope, sinceDate: p.sinceDate || '' })); }
function loadPreview_() { try { return JSON.parse(getProp_(PROP.PREVIEW_JSON, '') || 'null'); } catch (e) { return null; } }

// ---------- 커서 / 상태 ----------

function loadCursor_() {
  var raw = getProp_(PROP.CURSOR_JSON, '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function saveCursor_(cursor) { props_().setProperty(PROP.CURSOR_JSON, JSON.stringify(cursor)); }

function setStatus_(patch) {
  var status = getStatus_();
  Object.keys(patch).forEach(function (k) { status[k] = patch[k]; });
  status.updatedAt = new Date().toISOString();
  props_().setProperty(PROP.STATUS_JSON, JSON.stringify(status));
}
function getStatus_() {
  try { return JSON.parse(getProp_(PROP.STATUS_JSON, '{}')) || {}; } catch (e) { return {}; }
}

/** 커서와 마지막 동기화 시각을 지워 다음 실행이 전체 백업이 되게 한다 (편집기에서 수동 실행용). */
function resetBackupState() {
  props_().deleteProperty(PROP.CURSOR_JSON);
  props_().deleteProperty(PROP.LAST_SYNC_EPOCH);
  setStatus_({ state: 'idle', message: '상태 초기화됨. 다음 실행은 전체 백업.' });
}
