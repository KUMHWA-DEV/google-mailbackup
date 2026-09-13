/**
 * 백업 오케스트레이션. 트리거/수동 실행 진입점은 runBackup().
 *
 * 실행 흐름
 *  1. 커서(CURSOR_JSON)가 있으면 이어서, 없으면 새 실행(쿼리 생성, 시작 시각 기록)
 *  2. 페이지 단위로 id 목록 → 인덱스에 없는 것만 저장
 *  3. MAX_RUN_SECONDS 초과 시 커서 저장 후 1분 뒤 이어서 실행되는 트리거 생성
 *  4. 페이지 소진 시 LAST_SYNC_EPOCH = 이번 실행 시작 시각, 커서 삭제
 */
function runBackup() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    Logger.log('다른 백업 실행이 진행 중이라 건너뜁니다.');
    return;
  }
  try {
    deleteContinuationTriggers_();
    runBackupLocked_();
  } finally {
    lock.releaseLock();
  }
}

function runBackupLocked_() {
  var startedAt = Date.now();
  var deadline = startedAt + maxRunSeconds_() * 1000;
  var cursor = loadCursor_();
  var isNewRun = !cursor;
  if (isNewRun) {
    cursor = {
      query: buildQuery(getProp_(PROP.LAST_SYNC_EPOCH, null)),
      pageToken: null,
      runStartEpoch: Math.floor(startedAt / 1000),
      startedAt: new Date(startedAt).toISOString(),
      found: 0, processed: 0, skipped: 0, errors: 0, chunks: 0,
      bytes: 0, mailFrom: null, mailTo: null,
    };
  }
  cursor.chunks += 1;
  setStatus_({ state: 'running', message: (isNewRun ? '새 백업 시작' : '이어서 실행') + ' (' + cursor.chunks + '번째 구간)', cursor: cursor });
  Logger.log('백업 %s: query="%s" pageToken=%s', isNewRun ? '시작' : '재개', cursor.query, cursor.pageToken || '-');

  var labelMap = fetchLabelMap_();
  var sheet = indexSheet_();
  var backedUp = loadBackedUpIds_(sheet);
  var pending = [];
  var outOfTime = false;

  try {
    while (true) {
      var page = listMessageIds_(cursor.query, cursor.pageToken);
      cursor.found += page.ids.length;
      for (var i = 0; i < page.ids.length; i++) {
        var id = page.ids[i];
        if (backedUp[id]) { cursor.skipped += 1; continue; }
        try {
          var row = backupOne_(id, labelMap);
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
        if (Date.now() > deadline) { outOfTime = true; break; }
      }
      if (outOfTime) {
        // 이 페이지의 남은 id는 다음 구간에서 같은 pageToken으로 다시 조회 (중복은 id로 걸러짐)
        break;
      }
      cursor.pageToken = page.nextPageToken || null;
      if (!cursor.pageToken) break;
      if (Date.now() > deadline) { outOfTime = true; break; }
    }
  } finally {
    appendIndexRows_(sheet, pending);
  }

  if (outOfTime) {
    saveCursor_(cursor);
    scheduleContinuation_();
    setStatus_({ state: 'running', message: '시간 제한으로 일시 중지, 1분 뒤 이어서 실행', cursor: cursor });
    Logger.log('시간 제한. 처리 %s건, 이어서 실행 예약.', cursor.processed);
    return;
  }

  props_().setProperty(PROP.LAST_SYNC_EPOCH, String(cursor.runStartEpoch));
  props_().deleteProperty(PROP.CURSOR_JSON);
  cursor.finishedAt = new Date().toISOString();
  appendRunHistory_(cursor);
  setStatus_({
    state: 'idle',
    message: '완료: 감지 ' + cursor.found + '건, 새로 ' + cursor.processed + '건 저장, ' + cursor.skipped + '건 이미 있음, 오류 ' + cursor.errors + '건',
    cursor: cursor,
    finishedAt: cursor.finishedAt,
  });
  Logger.log('백업 완료. 새 %s건, 건너뜀 %s건, 오류 %s건', cursor.processed, cursor.skipped, cursor.errors);
}

/** 메시지 1건을 저장하고 인덱스 행을 돌려준다. */
function backupOne_(id, labelMap) {
  var m = fetchMessage_(id);
  var category = categorize(m.labelIds, labelMap);
  var folder = ensureFolderPath_(buildFolderPath(category, m.date, CONFIG.TIME_ZONE, folderLayout_()));
  var fileName = buildFileName({ date: m.date, subject: m.headers.subject, id: m.id }, CONFIG.TIME_ZONE);
  var saved = saveEml_(folder, fileName, m.rawBytes);
  var attachmentNames = saveAttachments_(m.id, m.attachments);
  return buildIndexRow({
    id: m.id, threadId: m.threadId, date: m.date, category: category,
    labelNames: labelNamesOf(m.labelIds, labelMap), headers: m.headers, snippet: m.snippet,
    sizeEstimate: m.sizeEstimate, attachmentNames: attachmentNames,
    driveFileId: saved.fileId, driveUrl: saved.url, backedUpAt: new Date(),
  });
}

/** 이번 실행의 용량 합계와 메일 날짜 범위를 커서에 누적. */
function noteRowStats_(cursor, row) {
  var rec = rowToRecord(row);
  cursor.bytes += Number(rec.sizeBytes) || 0;
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
  });
  props_().setProperty(PROP.RUN_HISTORY_JSON, JSON.stringify(hist.slice(0, RUN_HISTORY_MAX)));
}
function loadRunHistory_() {
  try { return JSON.parse(getProp_(PROP.RUN_HISTORY_JSON, '[]')) || []; } catch (e) { return []; }
}

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
