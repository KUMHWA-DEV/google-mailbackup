/**
 * 예전 백업 가져오기(마이그레이션). 백업과 독립된 작업 (자체 트리거·상태·Import 시트).
 *
 * <루트>/_import 폴더(하위 폴더 포함)에 넣은 파일을 처리한다.
 *  - .eml            : 메일 1통
 *  - .mbox           : 메일 여러 통 (Google Takeout, Thunderbird, Apple Mail 내보내기). 크기 제한 없이 8MB 창으로 나눠 읽는다.
 *  - .mbox.gz/.gz    : 압축 mbox. 압축 상태로 40MB까지 (그 이상은 압축을 풀어서 넣어야 함)
 * 분류는 메일 자체의 속성으로 한다: X-Gmail-Labels(Takeout)가 있으면 Gmail 백업과 같은 규칙(사용자 라벨 > 보낸편지함 > … > 받은편지함 > 보관됨),
 * 없으면 보낸사람이 나면 보낸편지함, 아니면 받은편지함. 저장 위치도 일반 백업과 같은 <루트>/<카테고리>/ 폴더.
 *
 * 권한: 사용자가 넣은 파일은 앱이 만든 파일이 아니므로 drive.readonly 로 읽는다. 옮기거나 지우지는 못하므로
 * 처리한 파일은 Import 시트에 'src:<fileId>' 로 기록해 다시 처리하지 않는다 (_import 폴더는 언제든 비워도 됨).
 * 인덱스 id: 'eml:' + Message-ID 해시 (없으면 파일ID#오프셋) — 같은 메일이 여러 파일에 있어도 한 번만 저장.
 */
var IMPORT_FOLDER_NAME = '_import';
var IMPORT_MAX_EML_BYTES = 30 * 1024 * 1024;
var IMPORT_MAX_GZ_BYTES = 40 * 1024 * 1024;
var IMPORT_WINDOW_BYTES = 8 * 1024 * 1024;      // mbox를 한 번에 읽는 창
var IMPORT_WINDOW_MAX_BYTES = 40 * 1024 * 1024; // 한 통이 창보다 크면 여기까지 키움
var IMPORT_FN = 'runImport';
var IMPORT_PROP = { STATUS: 'IMPORT_STATUS_JSON', CURSOR: 'IMPORT_CURSOR_JSON', HISTORY: 'IMPORT_HISTORY_JSON', STOP: 'IMPORT_STOP', LEASE: 'IMPORT_LEASE_UNTIL' };
var IMPORT_LEASE_MS = 7 * 60 * 1000;

// ---------- 폴더 ----------
/** _import 폴더: 기억된 ID → 루트 안의 같은 이름 폴더(사용자가 직접 만든 것도 인정, 읽기만 하므로) → 새로 생성 */
function importFolder_(createIfMissing) {
  var id = getProp_('IMPORT_FOLDER_ID', '');
  if (id) { try { var f0 = DriveApp.getFolderById(id); if (!f0.isTrashed()) return f0; } catch (e) { /* 지워졌으면 아래로 */ } }
  var root = rootFolder_();
  var it = root.getFoldersByName(IMPORT_FOLDER_NAME);
  var f = it.hasNext() ? it.next() : (createIfMissing ? root.createFolder(IMPORT_FOLDER_NAME) : null);
  if (f) props_().setProperty('IMPORT_FOLDER_ID', f.getId());
  return f;
}
function importFolderUrl_() { var id = getProp_('IMPORT_FOLDER_ID', ''); return id ? 'https://drive.google.com/drive/folders/' + id : ''; }
/** 웹앱: 폴더가 없으면 만들고 링크를 돌려준다 */
function ensureImportFolder() { var f = importFolder_(true); return { url: importFolderUrl_(), path: rootFolderPath_() + ' › ' + IMPORT_FOLDER_NAME, name: f ? f.getName() : '' }; }

function importKind_(file) {
  var name = String(file.getName() || '').toLowerCase(), mime = String(file.getMimeType() || '');
  if (/\.eml$/.test(name) || mime === 'message/rfc822') return 'eml';
  if (/\.mbox\.gz$/.test(name) || /\.gz$/.test(name) || mime === 'application/gzip' || mime === 'application/x-gzip') return 'gz';
  if (/\.mbox$/.test(name) || /\.mbx$/.test(name) || mime === 'application/mbox') return 'mbox';
  return '';
}
/**
 * _import 아래의 가져올 파일(하위 폴더 포함). skipSet에 'src:<id>'가 있으면 제외.
 * @returns {{file:GoogleAppsScript.Drive.File, kind:string}[]}
 */
function listImportFiles_(skipSet, limit) {
  var out = [];
  var top = importFolder_(false);
  if (!top) return out;
  var walk = function (folder, depth) {
    if (out.length >= limit || depth > 6) return;
    var files = folder.getFiles();
    while (files.hasNext() && out.length < limit) {
      var f = files.next(), kind = importKind_(f);
      if (!kind) continue;
      if (skipSet && skipSet['src:' + f.getId()]) continue;
      out.push({ file: f, kind: kind });
    }
    var subs = folder.getFolders();
    while (subs.hasNext() && out.length < limit) walk(subs.next(), depth + 1);
  };
  walk(top, 0);
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
function bytesToBin_(bytes) { return Utilities.newBlob(bytes).getDataAsString('ISO-8859-1'); }
function sha1Hex_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, s, Utilities.Charset.UTF_8).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }

/** 메일 속성으로 카테고리 결정: X-Gmail-Labels → Gmail 백업과 같은 규칙, 없으면 보낸사람 기준 */
function classifyImported_(m, settings) {
  var me = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var sent = !!me && String(m.headers.from || '').toLowerCase().indexOf(me) >= 0;
  var labelIds = [], labelMap = {};
  if (m.gmailLabels) { var g = gmailLabelsToIds(m.gmailLabels); labelIds = g.labelIds; labelMap = g.labelMap; }
  if (!labelIds.length) labelIds = [sent ? 'SENT' : 'INBOX'];
  else if (sent && labelIds.indexOf('SENT') < 0 && labelIds.indexOf('INBOX') < 0) labelIds.push('SENT');
  return { category: categorize(labelIds, labelMap, { splitGmailTabs: settings.splitGmailTabs }), labelNames: labelNamesOf(labelIds, labelMap) };
}

/**
 * 메일 1통(바이너리 문자열)을 저장하고 인덱스 행을 만든다.
 * @param {string} bin 원문 @param {string} fallbackId Message-ID가 없을 때 쓸 id 재료 @param {number} sizeHint
 */
function importMessage_(bin, fallbackId, backedUp, settings, srcFileId) {
  var m = parseEml(bin, decodeCharsetGas_);
  var id = 'eml:' + (m.messageId ? sha1Hex_(m.messageId).slice(0, 24) : sha1Hex_(fallbackId).slice(0, 24));
  if (backedUp[id]) return { id: id, skipped: true };
  var cls = classifyImported_(m, settings);
  var date = m.date || new Date();
  var folder = ensureFolderPath_(buildFolderPath(cls.category, date, CONFIG.TIME_ZONE, settings.folderLayout));
  var fileName = buildFileName({ date: date, subject: m.headers.subject, id: id.replace(/^eml:/, '') }, CONFIG.TIME_ZONE);
  var bytes = binToBytes_(bin);
  var saved = saveEml_(folder, fileName, bytes);
  var blobs = m.attachments.map(function (a) { return Utilities.newBlob(a.dataB64 ? Utilities.base64Decode(a.dataB64) : binToBytes_(a.data || ''), a.mime || 'application/octet-stream', a.name); });
  var attachmentFiles = saveAttachments_(id.replace(/^eml:/, ''), blobs, date);
  var attachmentNames = attachmentFiles.length ? attachmentFiles.map(function (f) { return f.name; }) : m.attachments.map(function (a) { return a.name; });
  var row = buildIndexRow({
    id: id, threadId: 'src:' + srcFileId, date: date, category: cls.category,
    labelNames: cls.labelNames, headers: m.headers, snippet: String(m.bodyText || '').replace(/\s+/g, ' ').slice(0, 160),
    sizeEstimate: bin.length, attachmentNames: attachmentNames, attachmentFiles: attachmentFiles, bodyPreview: m.bodyText,
    driveFileId: saved.fileId, driveUrl: saved.url, backedUpAt: new Date(),
  });
  return { row: row, id: id, skipped: false, bytes: bin.length };
}
/** 파일 하나를 끝까지 처리했다는 표시 행 (목록에는 안 보임, 다음 실행에서 건너뜀) */
function importDoneRow_(fileId, note) {
  return buildIndexRow({ id: 'emldup:' + fileId, threadId: 'src:' + fileId, date: new Date(), category: '가져옴-처리됨', labelNames: [], headers: { subject: note || '' }, sizeEstimate: 0, backedUpAt: new Date() });
}

/** Drive 파일의 바이트 구간을 읽는다 (큰 mbox를 창 단위로) */
function readFileRange_(fileId, start, endInclusive) {
  var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + start + '-' + endInclusive }, muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code !== 206 && code !== 200) throw new Error('파일 읽기 실패 (' + code + '): ' + res.getContentText().slice(0, 200));
  return res.getContent();
}

// ---------- 실행 (백업과 독립: 자체 임대·트리거·상태) ----------
function importStatus_() { try { return JSON.parse(getProp_(IMPORT_PROP.STATUS, '{}')) || {}; } catch (e) { return {}; } }
function setImportStatus_(patch) {
  var st = importStatus_(); Object.keys(patch).forEach(function (k) { st[k] = patch[k]; }); st.updatedAt = new Date().toISOString();
  try { props_().setProperty(IMPORT_PROP.STATUS, JSON.stringify(st)); } catch (e) { delete st.cursor; props_().setProperty(IMPORT_PROP.STATUS, JSON.stringify(st)); }
}
function importCursor_() { try { return JSON.parse(getProp_(IMPORT_PROP.CURSOR, '') || 'null'); } catch (e) { return null; } }
function saveImportCursor_(c) { props_().setProperty(IMPORT_PROP.CURSOR, JSON.stringify(c)); }
function importHistory_() { try { return JSON.parse(getProp_(IMPORT_PROP.HISTORY, '[]')) || []; } catch (e) { return []; } }
function deleteImportTriggers_() { ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === IMPORT_FN) ScriptApp.deleteTrigger(t); }); }
function scheduleImport_(delayMs) {
  ScriptApp.newTrigger(IMPORT_FN).timeBased().after(delayMs || CONFIG.CONTINUE_DELAY_MS).create();
  if (ScriptApp.getProjectTriggers().length < 15) ScriptApp.newTrigger(IMPORT_FN).timeBased().after(Math.max(15 * 60 * 1000, (delayMs || 0) + 5 * 60 * 1000)).create();
}
function importLeaseHeld_() { return Number(getProp_(IMPORT_PROP.LEASE, '0')) > Date.now(); }
function newImportCursor_() { return { startedAt: new Date().toISOString(), processed: 0, skipped: 0, errors: 0, chunks: 0, bytes: 0, files: 0, lastError: null, cur: null }; }

function startImport() {
  props_().deleteProperty(IMPORT_PROP.STOP);
  deleteImportTriggers_();
  importFolder_(true);
  var c = importCursor_() || newImportCursor_();
  saveImportCursor_(c);
  var err = '';
  try { scheduleImport_(5 * 1000); } catch (e) { err = String(e && e.message || e); }
  setImportStatus_({ state: 'queued', message: err ? '트리거 생성 실패: ' + err : '대기열 등록 · 곧 시작', cursor: c, queuedAt: new Date().toISOString() });
  return getImportState();
}
function stopImport() { props_().setProperty(IMPORT_PROP.STOP, '1'); deleteImportTriggers_(); if (!importLeaseHeld_()) { props_().deleteProperty(IMPORT_PROP.STOP); setImportStatus_({ state: importCursor_() ? 'paused' : 'idle', message: '중지됨' }); } else setImportStatus_({ state: 'stopping', message: '중지 중 · 현재 파일까지 저장 후 멈춥니다' }); return getImportState(); }
function cancelImport() { props_().deleteProperty(IMPORT_PROP.STOP); deleteImportTriggers_(); var c = importCursor_(); props_().deleteProperty(IMPORT_PROP.CURSOR); if (c && (c.processed || c.errors)) appendImportHistory_(Object.assign(c, { finishedAt: new Date().toISOString(), status: 'cancelled' })); setImportStatus_({ state: 'idle', message: '취소됨', cursor: {} }); return getImportState(); }

function getImportState() {
  var st = importStatus_(), c = st.cursor || importCursor_() || {};
  if (/^(running|queued)$/.test(st.state || '') && !importLeaseHeld_() && Date.now() - new Date(st.updatedAt || 0).getTime() > 20 * 60 * 1000) {
    var pending = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === IMPORT_FN; });
    if (!pending && importCursor_()) { try { scheduleImport_(5 * 1000); } catch (e) { /* 무시 */ } setImportStatus_({ state: 'queued', message: '실행이 끊겨 다시 예약함' }); st = importStatus_(); }
  }
  var pendingCount = null, folderExists = false;
  try { folderExists = !!importFolder_(false); pendingCount = folderExists ? countImportPending_(loadBackedUpIds_(), 2000) : 0; } catch (e) { pendingCount = null; }
  return {
    state: st.state || 'idle', message: st.message || '', updatedAt: st.updatedAt || null,
    cursor: { startedAt: c.startedAt || null, processed: c.processed || 0, skipped: c.skipped || 0, errors: c.errors || 0, chunks: c.chunks || 0, bytes: c.bytes || 0, files: c.files || 0, lastError: c.lastError || null, activeSeconds: c.activeSeconds || 0, curFile: c.cur ? c.cur.name : null, curOffset: c.cur ? c.cur.offset : 0, curSize: c.cur ? c.cur.size : 0 },
    pending: pendingCount, pendingCapped: pendingCount != null && pendingCount >= 2000,
    folderExists: folderExists, folderUrl: folderExists ? importFolderUrl_() : '', folderPath: rootFolderPath_() + ' › ' + IMPORT_FOLDER_NAME,
    history: importHistory_(),
  };
}
function appendImportHistory_(c) {
  var h = importHistory_(); h.unshift({ startedAt: c.startedAt, finishedAt: c.finishedAt, processed: c.processed, skipped: c.skipped, errors: c.errors, bytes: c.bytes, files: c.files, chunks: c.chunks, status: c.status || 'done', lastError: c.lastError || null });
  try { props_().setProperty(IMPORT_PROP.HISTORY, JSON.stringify(h.slice(0, 8))); } catch (e) { /* 무시 */ }
}

/**
 * 트리거 진입점: 한 구간(최대 4분 30초). 파일 단위로 진행하며, mbox는 cur.offset 부터 창 단위로 읽는다.
 */
function runImport() {
  try { deleteImportTriggers_(); } catch (e0) { /* 무시 */ }
  if (importLeaseHeld_()) { Logger.log('가져오기 구간이 이미 실행 중'); return; }
  props_().setProperty(IMPORT_PROP.LEASE, String(Date.now() + IMPORT_LEASE_MS));
  var cursor = importCursor_() || newImportCursor_();
  var started = Date.now(), deadline = started + maxRunSeconds_() * 1000;
  var settings = getSettings_();
  var pending = [], sheet, outOfTime = false, stopped = false, lastStop = Date.now();
  var stopWanted = function () { if (Date.now() - lastStop > 10 * 1000) { lastStop = Date.now(); return getProp_(IMPORT_PROP.STOP, '') === '1'; } return false; };
  var flush = function () { if (pending.length) { appendIndexRows_(sheet, pending); pending = []; } };
  var tickStatus = function (msg) { setImportStatus_({ state: 'running', message: msg, cursor: cursor }); };
  try {
    if (getProp_(IMPORT_PROP.STOP, '') === '1') { props_().deleteProperty(IMPORT_PROP.STOP); setImportStatus_({ state: 'paused', message: '중지됨 · ' + cursor.processed + '건 저장', cursor: cursor }); return; }
    cursor.chunks += 1;
    tickStatus('가져오는 중 (' + cursor.chunks + '번째 구간)');
    sheet = importSheet_();
    var backedUp = loadBackedUpIds_();
    var handleMessage = function (bin, fallbackId, srcId) {
      try {
        var r = importMessage_(bin, fallbackId, backedUp, settings, srcId);
        if (r.skipped) { cursor.skipped += 1; return; }
        pending.push(r.row); backedUp[r.id] = true; cursor.processed += 1; cursor.bytes += r.bytes || 0;
      } catch (e) { cursor.errors += 1; cursor.lastError = fallbackId + ': ' + e.message; Logger.log('가져오기 실패 %s: %s', fallbackId, e.stack || e.message); }
      if (pending.length >= CONFIG.INDEX_FLUSH_EVERY) flush();
      if ((cursor.processed + cursor.errors + cursor.skipped) % 10 === 0) tickStatus('가져오는 중 ' + cursor.processed + '건' + (cursor.cur ? ' · ' + cursor.cur.name : ''));
    };
    // 진행 중이던 파일부터, 그다음 새 파일들
    var entries = listImportFiles_(backedUp, 200);
    if (cursor.cur) { // 진행 중이던 파일을 맨 앞에 (목록에 있으면 그 자리에서 빼고)
      entries = entries.filter(function (e) { return e.file.getId() !== cursor.cur.id; });
      try { var cf = DriveApp.getFileById(cursor.cur.id); entries.unshift({ file: cf, kind: cursor.cur.kind }); } catch (e) { cursor.cur = null; }
    }
    for (var k = 0; k < entries.length; k++) {
      if (Date.now() > deadline) { outOfTime = true; break; }
      if (stopWanted()) { stopped = true; break; }
      var en = entries[k], file = en.file, fid = file.getId(), size = Number(file.getSize()) || 0;
      var resume = cursor.cur && cursor.cur.id === fid ? cursor.cur : null;
      cursor.cur = { id: fid, name: file.getName(), kind: en.kind, size: size, offset: resume ? resume.offset : 0 };
      try {
        if (en.kind === 'eml') {
          if (size > IMPORT_MAX_EML_BYTES) throw new Error('파일이 너무 큽니다 (' + Math.round(size / 1048576) + 'MB)');
          handleMessage(bytesToBin_(file.getBlob().getBytes()), fid, fid);
        } else if (en.kind === 'gz') {
          if (size > IMPORT_MAX_GZ_BYTES) throw new Error('압축 파일이 ' + Math.round(size / 1048576) + 'MB라 처리할 수 없습니다. 압축을 풀어 .mbox로 넣어 주세요');
          var text = bytesToBin_(Utilities.ungzip(file.getBlob()).getBytes());
          var scan = mboxScan(text, true), done = false;
          for (var i = 0; i < scan.messages.length; i++) {
            var sm = scan.messages[i]; if (sm.start < cursor.cur.offset) continue;
            handleMessage(mboxUnwrap(text.slice(sm.start, sm.end)), fid + '#' + sm.start, fid);
            cursor.cur.offset = sm.end;
            if (Date.now() > deadline) { outOfTime = true; break; }
            if (stopWanted()) { stopped = true; break; }
          }
          if (outOfTime || stopped) break;
        } else { // mbox: 창 단위로 읽기
          var offset = cursor.cur.offset, win = IMPORT_WINDOW_BYTES;
          while (offset < size) {
            var end = Math.min(size, offset + win) - 1;
            var bin = bytesToBin_(readFileRange_(fid, offset, end));
            var isEnd = end >= size - 1;
            var sc = mboxScan(bin, isEnd);
            if (!sc.messages.length) { // 한 통이 창보다 큼
              if (win >= IMPORT_WINDOW_MAX_BYTES) { cursor.errors += 1; cursor.lastError = file.getName() + ': ' + Math.round(win / 1048576) + 'MB가 넘는 메일이 있어 건너뜁니다'; var nx = bin.indexOf('\nFrom ', 5); offset = nx > 0 ? offset + nx + 1 : size; cursor.cur.offset = offset; win = IMPORT_WINDOW_BYTES; continue; }
              win = Math.min(IMPORT_WINDOW_MAX_BYTES, win * 4); continue;
            }
            win = IMPORT_WINDOW_BYTES;
            for (var j = 0; j < sc.messages.length; j++) {
              var mm = sc.messages[j];
              handleMessage(mboxUnwrap(bin.slice(mm.start, mm.end)), fid + '#' + (offset + mm.start), fid);
              cursor.cur.offset = offset + mm.end;
              if (Date.now() > deadline) { outOfTime = true; break; }
              if (stopWanted()) { stopped = true; break; }
            }
            offset = cursor.cur.offset;
            if (outOfTime || stopped) break;
            tickStatus('가져오는 중 ' + cursor.processed + '건 · ' + file.getName() + ' ' + Math.round(offset / size * 100) + '%');
            saveImportCursor_(cursor);
          }
          if (outOfTime || stopped) break;
        }
        pending.push(importDoneRow_(fid, file.getName())); backedUp['src:' + fid] = true; cursor.files += 1; cursor.cur = null;
      } catch (e) {
        cursor.errors += 1; cursor.lastError = file.getName() + ': ' + e.message;
        Logger.log('가져오기 파일 실패 %s: %s', file.getName(), e.stack || e.message);
        pending.push(importDoneRow_(fid, '실패: ' + e.message)); backedUp['src:' + fid] = true; cursor.cur = null; // 같은 파일로 반복 실패하지 않게
      }
      flush();
    }
    var exhausted = !outOfTime && !stopped && entries.length < 200;
    flush();
    cursor.activeSeconds = (cursor.activeSeconds || 0) + (Date.now() - started) / 1000;
    if (stopped) { props_().deleteProperty(IMPORT_PROP.STOP); saveImportCursor_(cursor); setImportStatus_({ state: 'paused', message: '중지됨 · ' + cursor.processed + '건 저장 · "이어서"로 계속', cursor: cursor }); refreshSummary_(); return; }
    if (!exhausted) { saveImportCursor_(cursor); scheduleImport_(); setImportStatus_({ state: 'running', message: '구간 ' + cursor.chunks + ' 완료 · 1분 뒤 이어서', cursor: cursor }); refreshSummary_(); return; }
    props_().deleteProperty(IMPORT_PROP.CURSOR);
    cursor.finishedAt = new Date().toISOString();
    appendImportHistory_(cursor);
    setImportStatus_({ state: 'idle', message: '완료: ' + cursor.processed + '건 저장, ' + cursor.skipped + '건 중복, 오류 ' + cursor.errors + '건 (파일 ' + cursor.files + '개)', cursor: cursor, finishedAt: cursor.finishedAt });
    refreshSummary_();
  } catch (e) {
    try { flush(); } catch (e2) { /* 무시 */ }
    cursor.lastError = String(e && e.message || e); cursor.retries = (cursor.retries || 0) + 1;
    saveImportCursor_(cursor);
    if (cursor.retries <= 5) { try { scheduleImport_(5 * 60 * 1000); } catch (e3) { /* 무시 */ } setImportStatus_({ state: 'running', message: '오류 · 5분 뒤 재시도 (' + cursor.retries + '/5) · ' + cursor.lastError, cursor: cursor }); }
    else setImportStatus_({ state: 'error', message: '가져오기 실패: ' + cursor.lastError, cursor: cursor });
  } finally {
    props_().deleteProperty(IMPORT_PROP.LEASE);
  }
}
