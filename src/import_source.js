/**
 * 예전 .eml 백업 가져오기(마이그레이션). 백업과 독립된 작업.
 *
 * 사용자가 <루트>/_import 폴더(하위 폴더 포함)에 .eml 파일을 넣고 "가져오기 시작"을 누르면, 트리거로 4분 30초 구간씩
 * 서버에서 .eml을 직접 해석해 <루트>/가져옴/<라벨>/ 에 원본을, <루트>/_attachments_import/ 에 첨부를 저장하고
 * 인덱스 스프레드시트의 별도 시트(Import)에 행을 쓴다. 백업과 잠금·트리거·시트·폴더를 공유하지 않으므로 동시에 돌 수 있다.
 *
 * 권한: 사용자가 Drive에서 넣은 파일은 앱이 만든 파일이 아니므로 drive.readonly 로 읽는다. 옮기거나 지우지는 못하므로
 * 처리한 파일은 인덱스에 'src:<fileId>' 로 기록해 다시 처리하지 않는다. 사용자는 _import 폴더를 언제든 비워도 된다.
 *
 * 인덱스 id: 'eml:' + Message-ID 해시 (없으면 파일 ID) — 같은 메일이 두 파일로 있어도 한 번만 저장.
 */
var IMPORT_FOLDER_NAME = '_import';
var IMPORT_ROOT_NAME = '가져옴';
var IMPORT_ATTACHMENT_FOLDER = '_attachments_import';
var IMPORT_MAX_BYTES = 30 * 1024 * 1024;
var IMPORT_FN = 'runImport';
var IMPORT_PROP = { STATUS: 'IMPORT_STATUS_JSON', CURSOR: 'IMPORT_CURSOR_JSON', HISTORY: 'IMPORT_HISTORY_JSON', STOP: 'IMPORT_STOP', LEASE: 'IMPORT_LEASE_UNTIL' };
var IMPORT_LEASE_MS = 7 * 60 * 1000;

// ---------- 폴더 ----------
function importFolder_() {
  var id = getProp_('IMPORT_FOLDER_ID', '');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* 지워졌으면 새로 */ } }
  var root = rootFolder_();
  var f = root.createFolder(IMPORT_FOLDER_NAME);
  props_().setProperty('IMPORT_FOLDER_ID', f.getId());
  return f;
}
function importFolderUrl_() { var id = getProp_('IMPORT_FOLDER_ID', ''); return id ? 'https://drive.google.com/drive/folders/' + id : ''; }

/**
 * _import 아래의 .eml 파일을 (하위 폴더 포함) 나열. skipSet에 'src:<id>'가 있으면 제외.
 * @returns {{file:GoogleAppsScript.Drive.File, label:string}[]} label = 첫 하위 폴더 이름('' 이면 루트)
 */
function listImportFiles_(skipSet, limit) {
  var out = [];
  var walk = function (folder, label, depth) {
    if (out.length >= limit || depth > 6) return;
    var files = folder.getFiles();
    while (files.hasNext() && out.length < limit) {
      var f = files.next();
      var name = f.getName() || '';
      if (!/\.eml$/i.test(name) && f.getMimeType() !== 'message/rfc822') continue;
      if (skipSet && skipSet['src:' + f.getId()]) continue;
      out.push({ file: f, label: label });
    }
    var subs = folder.getFolders();
    while (subs.hasNext() && out.length < limit) { var s = subs.next(); walk(s, label || s.getName(), depth + 1); }
  };
  walk(importFolder_(), '', 0);
  return out;
}
function countImportPending_(skipSet, cap) { return listImportFiles_(skipSet, cap || 2000).length; }

// ---------- 해석 ----------
function decodeCharsetGas_(bin, charset) {
  var bytes = [];
  for (var i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i) & 255);
  var cs = String(charset || 'UTF-8').toUpperCase();
  if (cs === 'KS_C_5601-1987' || cs === 'KS_C_5601-1989' || cs === 'CP949' || cs === 'KSC5601') cs = 'EUC-KR';
  try { return Utilities.newBlob(bytes).getDataAsString(cs); } catch (e) { return Utilities.newBlob(bytes).getDataAsString('UTF-8'); }
}
function binToBytes_(bin) { var bytes = []; for (var i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i) & 255); return bytes; }
function sha1Hex_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, s, Utilities.Charset.UTF_8).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }

/**
 * .eml 파일 1건 → 저장 → 인덱스 행.
 * @returns {{row:any[], id:string, skipped:boolean}}
 */
function importOne_(entry, backedUp, settings) {
  var file = entry.file, fileId = file.getId();
  if (file.getSize() > IMPORT_MAX_BYTES) throw new Error('파일이 너무 큽니다 (' + Math.round(file.getSize() / 1048576) + 'MB)');
  var bytes = file.getBlob().getBytes();
  var bin = Utilities.newBlob(bytes).getDataAsString('ISO-8859-1');
  var m = parseEml(bin, decodeCharsetGas_);
  var id = 'eml:' + (m.messageId ? sha1Hex_(m.messageId).slice(0, 24) : fileId);
  if (backedUp[id]) return { id: id, skipped: true, row: importMarkerRow_(id, fileId) }; // 같은 메일이 이미 있음 → 원본 파일만 처리됨으로 기록
  var me = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var fromAddr = String(m.headers.from || '').toLowerCase();
  var sent = !!me && fromAddr.indexOf(me) >= 0;
  var category = entry.label ? String(entry.label).replace(/\//g, '-') : (sent ? '보낸편지함' : '받은편지함');
  var date = m.date || file.getDateCreated();
  var path = [IMPORT_ROOT_NAME].concat(buildFolderPath(category, date, CONFIG.TIME_ZONE, settings.folderLayout));
  var folder = ensureFolderPath_(path);
  var fileName = buildFileName({ date: date, subject: m.headers.subject, id: id.replace(/^eml:/, '') }, CONFIG.TIME_ZONE);
  var saved = saveEml_(folder, fileName, bytes);
  var blobs = m.attachments.map(function (a) { return Utilities.newBlob(a.dataB64 ? Utilities.base64Decode(a.dataB64) : binToBytes_(a.data || ''), a.mime || 'application/octet-stream', a.name); });
  var attachmentFiles = saveAttachments_(id.replace(/^eml:/, ''), blobs, date, IMPORT_ATTACHMENT_FOLDER);
  var attachmentNames = attachmentFiles.length ? attachmentFiles.map(function (f) { return f.name; }) : m.attachments.map(function (a) { return a.name; });
  var labels = ['가져옴'].concat(entry.label ? [entry.label] : []).concat(sent ? ['SENT'] : []);
  var row = buildIndexRow({
    id: id, threadId: 'src:' + fileId, date: date, category: category,
    labelNames: labels, headers: m.headers, snippet: String(m.bodyText || '').replace(/\s+/g, ' ').slice(0, 160),
    sizeEstimate: bytes.length, attachmentNames: attachmentNames, attachmentFiles: attachmentFiles, bodyPreview: m.bodyText,
    driveFileId: saved.fileId, driveUrl: saved.url, backedUpAt: new Date(),
  });
  return { row: row, id: id, skipped: false };
}
/** 이미 있는 메일의 중복 파일: 파일 ID만 "처리됨"으로 남기는 표시 행 (목록에는 안 보임). */
function importMarkerRow_(dupId, fileId) {
  return buildIndexRow({ id: 'emldup:' + fileId, threadId: 'src:' + fileId, date: new Date(), category: '가져옴-중복', labelNames: ['가져옴', '중복'], headers: { subject: '(중복: ' + dupId + ')' }, sizeEstimate: 0, backedUpAt: new Date() });
}

// ---------- 실행 (백업과 독립: 자체 잠금·트리거·상태) ----------
function importStatus_() { try { return JSON.parse(getProp_(IMPORT_PROP.STATUS, '{}')) || {}; } catch (e) { return {}; } }
function setImportStatus_(patch) {
  var st = importStatus_(); Object.keys(patch).forEach(function (k) { st[k] = patch[k]; }); st.updatedAt = new Date().toISOString();
  try { props_().setProperty(IMPORT_PROP.STATUS, JSON.stringify(st)); } catch (e) { delete st.cursor; props_().setProperty(IMPORT_PROP.STATUS, JSON.stringify(st)); }
}
function importCursor_() { try { return JSON.parse(getProp_(IMPORT_PROP.CURSOR, '') || 'null'); } catch (e) { return null; } }
function saveImportCursor_(c) { props_().setProperty(IMPORT_PROP.CURSOR, JSON.stringify(c)); }
function importHistory_() { try { return JSON.parse(getProp_(IMPORT_PROP.HISTORY, '[]')) || []; } catch (e) { return []; } }
function deleteImportTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === IMPORT_FN) ScriptApp.deleteTrigger(t); });
}
function scheduleImport_(delayMs) {
  ScriptApp.newTrigger(IMPORT_FN).timeBased().after(delayMs || CONFIG.CONTINUE_DELAY_MS).create();
  if (ScriptApp.getProjectTriggers().length < 15) ScriptApp.newTrigger(IMPORT_FN).timeBased().after(Math.max(15 * 60 * 1000, (delayMs || 0) + 5 * 60 * 1000)).create();
}
/** 실행 중 여부: 임대(lease) 시각이 미래면 다른 실행이 구간을 돌고 있는 것 */
function importLeaseHeld_() { var u = Number(getProp_(IMPORT_PROP.LEASE, '0')); return u > Date.now(); }

/** 웹앱: 가져오기 시작 (5초 뒤 트리거). */
function startImport() {
  props_().deleteProperty(IMPORT_PROP.STOP);
  deleteImportTriggers_();
  var c = importCursor_();
  if (!c) c = { startedAt: new Date().toISOString(), processed: 0, skipped: 0, errors: 0, chunks: 0, bytes: 0, lastError: null };
  saveImportCursor_(c);
  var err = '';
  try { scheduleImport_(5 * 1000); } catch (e) { err = String(e && e.message || e); }
  setImportStatus_({ state: 'queued', message: err ? '트리거 생성 실패: ' + err : '대기열 등록 · 곧 시작', cursor: c, queuedAt: new Date().toISOString() });
  return getImportState();
}
function stopImport() { props_().setProperty(IMPORT_PROP.STOP, '1'); deleteImportTriggers_(); var st = importStatus_(); if (!importLeaseHeld_()) setImportStatus_({ state: importCursor_() ? 'paused' : 'idle', message: '중지됨' }); else setImportStatus_({ state: 'stopping', message: '중지 중 · 현재 파일까지 저장 후 멈춥니다' }); return getImportState(); }
function cancelImport() { props_().deleteProperty(IMPORT_PROP.STOP); deleteImportTriggers_(); var c = importCursor_(); props_().deleteProperty(IMPORT_PROP.CURSOR); if (c && c.processed) appendImportHistory_(Object.assign(c, { finishedAt: new Date().toISOString(), status: 'cancelled' })); setImportStatus_({ state: 'idle', message: '취소됨', cursor: {} }); return getImportState(); }

/** 웹앱: 가져오기 화면 상태 */
function getImportState() {
  var st = importStatus_(), c = st.cursor || importCursor_() || {};
  // 끊긴 실행 복구: 실행 중이라는데 임대가 끝났고 트리거도 없으면 다시 예약
  if (/^(running|queued)$/.test(st.state || '') && !importLeaseHeld_() && Date.now() - new Date(st.updatedAt || 0).getTime() > 20 * 60 * 1000) {
    var pending = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === IMPORT_FN; });
    if (!pending && importCursor_()) { try { scheduleImport_(5 * 1000); } catch (e) { /* 무시 */ } setImportStatus_({ state: 'queued', message: '실행이 끊겨 다시 예약함' }); st = importStatus_(); }
  }
  var pendingCount = null;
  try { pendingCount = countImportPending_(loadBackedUpIds_(), 2000); } catch (e) { pendingCount = null; }
  return {
    state: st.state || 'idle', message: st.message || '', updatedAt: st.updatedAt || null,
    cursor: { startedAt: c.startedAt || null, processed: c.processed || 0, skipped: c.skipped || 0, errors: c.errors || 0, chunks: c.chunks || 0, bytes: c.bytes || 0, lastError: c.lastError || null, activeSeconds: c.activeSeconds || 0 },
    pending: pendingCount, pendingCapped: pendingCount != null && pendingCount >= 2000,
    folderUrl: (function () { try { importFolder_(); } catch (e) { /* 무시 */ } return importFolderUrl_(); })(),
    history: importHistory_(),
  };
}
function appendImportHistory_(c) {
  var h = importHistory_(); h.unshift({ startedAt: c.startedAt, finishedAt: c.finishedAt, processed: c.processed, skipped: c.skipped, errors: c.errors, bytes: c.bytes, chunks: c.chunks, status: c.status || 'done', lastError: c.lastError || null });
  try { props_().setProperty(IMPORT_PROP.HISTORY, JSON.stringify(h.slice(0, 8))); } catch (e) { /* 무시 */ }
}

/** 트리거 진입점: 한 구간(최대 4분 30초) 처리 후 남았으면 이어서 예약. 백업의 사용자 잠금은 쓰지 않는다. */
function runImport() {
  try { deleteImportTriggers_(); } catch (e0) { /* 무시 */ }
  if (importLeaseHeld_()) { Logger.log('가져오기 구간이 이미 실행 중'); return; }
  props_().setProperty(IMPORT_PROP.LEASE, String(Date.now() + IMPORT_LEASE_MS));
  var cursor = importCursor_() || { startedAt: new Date().toISOString(), processed: 0, skipped: 0, errors: 0, chunks: 0, bytes: 0, lastError: null };
  var started = Date.now(), deadline = started + maxRunSeconds_() * 1000;
  var settings = getSettings_();
  var pending = [], sheet, outOfTime = false, stopped = false;
  try {
    if (getProp_(IMPORT_PROP.STOP, '') === '1') { props_().deleteProperty(IMPORT_PROP.STOP); setImportStatus_({ state: 'paused', message: '중지됨 · ' + cursor.processed + '건 저장', cursor: cursor }); return; }
    cursor.chunks += 1; cursor.chunkStartedAt = new Date().toISOString();
    setImportStatus_({ state: 'running', message: '가져오는 중 (' + cursor.chunks + '번째 구간)', cursor: cursor });
    sheet = importSheet_();
    var backedUp = loadBackedUpIds_();
    var entries = listImportFiles_(backedUp, 300), lastStop = Date.now();
    for (var k = 0; k < entries.length; k++) {
      if (Date.now() > deadline) { outOfTime = true; break; }
      if (Date.now() - lastStop > 10 * 1000) { lastStop = Date.now(); if (getProp_(IMPORT_PROP.STOP, '') === '1') { stopped = true; break; } }
      var en = entries[k], srcKey = 'src:' + en.file.getId();
      try {
        var r = importOne_(en, backedUp, settings);
        pending.push(r.row);
        backedUp[srcKey] = true;
        if (!r.skipped) { backedUp[r.id] = true; cursor.processed += 1; cursor.bytes += Number(en.file.getSize()) || 0; }
        else cursor.skipped += 1;
      } catch (e) {
        cursor.errors += 1; cursor.lastError = (en.file.getName() || srcKey) + ': ' + e.message;
        Logger.log('가져오기 실패 %s: %s', en.file.getName(), e.stack || e.message);
      }
      if (pending.length >= CONFIG.INDEX_FLUSH_EVERY) { appendIndexRows_(sheet, pending); pending = []; }
      if ((cursor.processed + cursor.errors + cursor.skipped) % 10 === 0) setImportStatus_({ state: 'running', message: '가져오는 중 ' + cursor.processed + '건', cursor: cursor });
    }
    var exhausted = !outOfTime && !stopped && entries.length < 300;
    appendIndexRows_(sheet, pending); pending = [];
    cursor.activeSeconds = (cursor.activeSeconds || 0) + (Date.now() - started) / 1000;
    if (stopped) { props_().deleteProperty(IMPORT_PROP.STOP); saveImportCursor_(cursor); setImportStatus_({ state: 'paused', message: '중지됨 · ' + cursor.processed + '건 저장 · "이어서"로 계속', cursor: cursor }); refreshSummary_(); return; }
    if (!exhausted) { saveImportCursor_(cursor); scheduleImport_(); setImportStatus_({ state: 'running', message: '구간 ' + cursor.chunks + ' 완료 · 1분 뒤 이어서', cursor: cursor }); refreshSummary_(); return; }
    props_().deleteProperty(IMPORT_PROP.CURSOR);
    cursor.finishedAt = new Date().toISOString();
    appendImportHistory_(cursor);
    setImportStatus_({ state: 'idle', message: '완료: ' + cursor.processed + '건 저장, ' + cursor.skipped + '건 중복, 오류 ' + cursor.errors + '건', cursor: cursor, finishedAt: cursor.finishedAt });
    refreshSummary_();
  } catch (e) {
    try { if (sheet && pending.length) appendIndexRows_(sheet, pending); } catch (e2) { /* 무시 */ }
    cursor.lastError = String(e && e.message || e); cursor.retries = (cursor.retries || 0) + 1;
    saveImportCursor_(cursor);
    if (cursor.retries <= 5) { try { scheduleImport_(5 * 60 * 1000); } catch (e3) { /* 무시 */ } setImportStatus_({ state: 'running', message: '오류 · 5분 뒤 재시도 (' + cursor.retries + '/5) · ' + cursor.lastError, cursor: cursor }); }
    else setImportStatus_({ state: 'error', message: '가져오기 실패: ' + cursor.lastError, cursor: cursor });
  } finally {
    props_().deleteProperty(IMPORT_PROP.LEASE);
  }
}
