/**
 * 예전 백업 가져오기(마이그레이션). 백업과 독립된 작업 (자체 트리거·상태·Import 시트).
 *
 * <루트>/_import 폴더(하위 폴더 포함)에 넣은 파일을 처리한다.
 *  - .eml            : 메일 1통
 *  - .mbox           : 메일 여러 통 (Google Takeout, Thunderbird, Apple Mail 내보내기). 크기 제한 없이 8MB 창으로 나눠 읽는다.
 *  - .mbox.gz/.gz    : 압축 mbox. 크기 제한 없이 스트리밍으로 풀면서 처리 (전역 pako, src/vendor_pako.js)
 *  - .zip            : Google Takeout 등의 zip. 안의 .mbox/.eml 엔트리를 스트리밍으로 처리 (zip64/4GB 초과 미지원)
 * 분류는 메일 자체의 속성으로 한다: X-Gmail-Labels(Takeout)가 있으면 Gmail 백업과 같은 규칙(사용자 라벨 > 보낸편지함 > … > 받은편지함 > 보관됨),
 * 없으면 보낸사람이 나면 보낸편지함, 아니면 받은편지함. 저장 위치도 일반 백업과 같은 <루트>/<카테고리>/ 폴더.
 *
 * 권한: 사용자가 넣은 파일은 앱이 만든 파일이 아니므로 drive.readonly 로 읽는다. 옮기거나 지우지는 못하므로
 * 처리한 파일은 Import 시트에 'src:<fileId>' 로 기록해 다시 처리하지 않는다 (_import 폴더는 언제든 비워도 됨).
 * 인덱스 id: 'eml:' + Message-ID 해시 (없으면 파일ID#오프셋) — 같은 메일이 여러 파일에 있어도 한 번만 저장.
 */
var IMPORT_FOLDER_NAME = '_import';
var IMPORT_MAX_EML_BYTES = 30 * 1024 * 1024;
var IMPORT_CHUNK_BYTES = 4 * 1024 * 1024;       // 파일을 한 번에 읽는 창
var IMPORT_MAX_MESSAGE_BYTES = 40 * 1024 * 1024; // 한 통 상한
var IMPORT_FN = 'runImport';
var IMPORT_PROP = { STATUS: 'IMPORT_STATUS_JSON', CURSOR: 'IMPORT_CURSOR_JSON', HISTORY: 'IMPORT_HISTORY_JSON', STOP: 'IMPORT_STOP', LEASE: 'IMPORT_LEASE_UNTIL', FAILED: 'IMPORT_FAILED_MSGS_JSON' };
/** 저장에 실패한 메일이 있는 원본 파일 { fileId: { name, count, lastError } } — "오류 수정" 때 그 파일을 다시 훑어 실패분만 저장한다 (이미 저장된 메일은 Message-ID 로 건너뜀) */
function importFailedMap_() { try { return JSON.parse(getProp_(IMPORT_PROP.FAILED, '{}')) || {}; } catch (e) { return {}; } }
function saveImportFailedMap_(m) { try { props_().setProperty(IMPORT_PROP.FAILED, JSON.stringify(m)); } catch (e) { /* 무시 */ } }
function noteFailedMessage_(fileId, name, err) { var m = importFailedMap_(); var e = m[fileId] || { name: name, count: 0 }; e.count += 1; e.lastError = String(err).slice(0, 200); e.name = name || e.name; m[fileId] = e; if (Object.keys(m).length > 200) return; saveImportFailedMap_(m); }
function failedMessageCount_() { var m = importFailedMap_(), n = 0; Object.keys(m).forEach(function (k) { n += m[k].count || 0; }); return n; }
var IMPORT_LEASE_MS = 7 * 60 * 1000;

// ---------- 폴더 ----------
/** _import 폴더: 기억된 ID → 루트 안의 같은 이름 폴더(사용자가 직접 만든 것도 인정, 읽기만 하므로) → 새로 생성 */
var IMPORT_DONE_FOLDER = '처리됨', IMPORT_DONE_TAG = 'mailbackup-import-done:';
/** _import/처리됨 폴더 (가져오기가 끝난 원본을 옮겨 두는 곳) */
function importDoneFolder_(createIfMissing) {
  var top = importFolder_(createIfMissing); if (!top) return null;
  var it = top.getFoldersByName(IMPORT_DONE_FOLDER);
  return it.hasNext() ? it.next() : (createIfMissing ? top.createFolder(IMPORT_DONE_FOLDER) : null);
}
/** 처리가 끝난 원본 파일을 처리됨 폴더로 옮기고 처리 시각을 설명에 남긴다 (파일 ID 는 그대로라 오류 수정의 재시도에 영향 없음) */
function archiveImportedFile_(file, settings) {
  if (!settings || !(settings.importKeepDays > 0)) return false;
  try {
    var done = importDoneFolder_(true);
    var ps = file.getParents(); if (ps.hasNext() && ps.next().getId() === done.getId()) return false;
    file.setDescription(IMPORT_DONE_TAG + new Date().toISOString());
    file.moveTo(done);
    return true;
  } catch (e) { Logger.log('처리됨 폴더로 이동 실패 %s: %s', file.getName(), e.message); return false; }
}
/** 처리됨 폴더에서 보관 일수가 지난 파일을 휴지통으로. 6시간에 한 번만 실제로 훑는다 */
function cleanupImportDone_(settings, force) {
  var days = settings && settings.importKeepDays; if (!(days > 0)) return 0;
  var lastAt = Number(getProp_('IMPORT_DONE_CLEANUP_AT', '0')) || 0;
  if (!force && Date.now() - lastAt < 6 * 3600 * 1000) return 0;
  props_().setProperty('IMPORT_DONE_CLEANUP_AT', String(Date.now()));
  var done = importDoneFolder_(false); if (!done) return 0;
  var cutoff = Date.now() - days * 86400 * 1000, n = 0, it = done.getFiles();
  while (it.hasNext()) {
    var f = it.next(), d = String(f.getDescription() || '');
    var at = d.indexOf(IMPORT_DONE_TAG) === 0 ? new Date(d.slice(IMPORT_DONE_TAG.length)).getTime() : f.getLastUpdated().getTime();
    if (at && at < cutoff) { try { f.setTrashed(true); n += 1; } catch (e) { /* 무시 */ } }
  }
  return n;
}
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
  if (/\.zip$/.test(name) || mime === 'application/zip' || mime === 'application/x-zip-compressed') return 'zip';
  if (/\.mbox$/.test(name) || /\.mbx$/.test(name) || mime === 'application/mbox') return 'mbox';
  return '';
}
/**
 * _import 아래의 가져올 파일(하위 폴더 포함). skipSet에 'src:<id>'가 있으면 제외.
 * @returns {{file:GoogleAppsScript.Drive.File, kind:string}[]}
 */
function listImportFiles_(skipSet, limit, report) {
  var out = [];
  var top = importFolder_(false);
  if (!top) return out;
  var walk = function (folder, depth) {
    if (out.length >= limit || depth > 6) return;
    var files = folder.getFiles();
    while (files.hasNext() && out.length < limit) {
      var f = files.next(), kind = importKind_(f);
      if (!kind) { if (report && report.unsupported.length < 10) report.unsupported.push(f.getName()); continue; }
      var mk = skipSet && skipSet['src:' + f.getId()];
      var same = false;
      if (mk === true) same = true;
      else if (mk && mk.size > 0) same = mk.size === (Number(f.getSize()) || 0) && mk.mtime === f.getLastUpdated().toISOString(); // 크기·수정 시각이 그대로면 같은 파일
      else if (mk) same = !(mk.at && f.getLastUpdated().getTime() > new Date(mk.at).getTime() + 60 * 1000); // 예전 표시: 처리된 뒤에 수정(덮어쓰기)됐으면 새 파일
      if (same) { if (report && report.done.length < 10) report.done.push(f.getName()); continue; }
      // (표시가 없거나, 있어도 파일이 바뀌었으면 다시 처리 — 이미 저장된 메일은 Message-ID 로 건너뛰므로 새로 추가된 메일만 들어온다)
      out.push({ file: f, kind: kind });
      if (report && report.pending.length < 20) report.pending.push({ name: f.getName(), kind: kind, size: Number(f.getSize()) || 0, changed: !!mk });
    }
    var subs = folder.getFolders();
    while (subs.hasNext() && out.length < limit) { var sub = subs.next(); if (depth === 0 && sub.getName() === IMPORT_DONE_FOLDER) continue; walk(sub, depth + 1); } // 처리됨 폴더는 대상 아님
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
  try { return Utilities.newBlob(bytes).getDataAsString(cs); } catch (e) { /* 모르는 문자셋 */ }
  try { return Utilities.newBlob(bytes).getDataAsString('UTF-8'); } catch (e2) { /* 깨진 바이트 */ }
  return Utilities.newBlob(bytes).getDataAsString('ISO-8859-1'); // 절대 실패하지 않음 (일부 글자가 깨지더라도 메일은 저장)
}
function binToBytes_(bin) { var bytes = []; for (var i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i) & 255); return bytes; }
function bytesToBin_(bytes) { return Utilities.newBlob(bytes).getDataAsString('ISO-8859-1'); }
function sha1Hex_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, s, Utilities.Charset.UTF_8).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }

/** 메일 속성으로 카테고리 결정: X-Gmail-Labels → Gmail 백업과 같은 규칙, 없으면 보낸사람 기준 */
function classifyImported_(m, settings) { return classifyLabels_(m.gmailLabels, m.headers.from, settings); }
// ---------- 진짜 라벨만: 이 계정의 Gmail 에 실제로 있는 사용자 라벨 이름 (10분 캐시). 헤더의 나머지 이름("수신확인 보냄" 같은 내부 표시)은 라벨로 만들지 않는다 ----------
var KNOWN_LABELS_PROP = 'IMPORT_KNOWN_LABELS_JSON', knownLabelsMem_ = null;
function knownUserLabels_() {
  if (knownLabelsMem_) return knownLabelsMem_;
  var cached = null; try { cached = JSON.parse(getProp_(KNOWN_LABELS_PROP, '') || 'null'); } catch (e) { /* 무시 */ }
  if (cached && cached.at && Date.now() - cached.at < 10 * 60 * 1000 && cached.names) { knownLabelsMem_ = setOf_(cached.names); return knownLabelsMem_; }
  try {
    var res = Gmail.Users.Labels.list('me'), names = [];
    (res.labels || []).forEach(function (l) { if (l.type === 'user') names.push(l.name); });
    try { props_().setProperty(KNOWN_LABELS_PROP, JSON.stringify({ at: Date.now(), names: names })); } catch (e2) { /* 무시 */ }
    knownLabelsMem_ = setOf_(names); return knownLabelsMem_;
  } catch (e3) { Logger.log('라벨 목록 조회 실패: %s', e3.message); return cached && cached.names ? setOf_(cached.names) : null; } // null = 확인 불가 → 걸러내지 않음
}
function setOf_(names) { var s = {}; (names || []).forEach(function (n) { s[labelKey_(n)] = true; }); return s; }
function labelKey_(n) { return String(n || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
/** 'user:이름' id 가 Gmail 의 실제 라벨인지 (목록을 못 얻으면 true) */
function isRealUserLabel_(name, known) { if (!known) return true; return !!known[labelKey_(name)] || !!known[labelKey_(String(name).replace(/-/g, '/'))]; }
/** 디코딩된 라벨 목록(쉼표 구분)과 From 으로 카테고리·라벨명을 정한다 (가져오기와 복구 공용). 실제 Gmail 라벨이 아닌 이름은 버린다 */
function classifyLabels_(labelsCsv, fromHeader, settings) {
  var me = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var sent = !!me && String(fromHeader || '').toLowerCase().indexOf(me) >= 0;
  var labelIds = [], labelMap = {};
  if (labelsCsv) {
    var g = gmailLabelsToIds(labelsCsv), known = knownUserLabels_(), ig = ignoredLabelSet(settings);
    labelIds = g.labelIds.filter(function (id) { return id.indexOf('user:') !== 0 || (isRealUserLabel_(g.labelMap[id], known) && !ig[labelKey_(g.labelMap[id])]); });
    labelIds.forEach(function (id) { if (g.labelMap[id]) labelMap[id] = g.labelMap[id]; });
  }
  if (!labelsCsv) labelIds = [sent ? 'SENT' : 'INBOX']; // 라벨 정보가 아예 없는 .eml 만 기본값 (라벨이 있는데 전부 무시된 경우 = 보관됨)
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
  var blobs = [];
  m.attachments.forEach(function (a) { try { blobs.push(Utilities.newBlob(a.dataB64 ? Utilities.base64Decode(a.dataB64) : binToBytes_(a.data || ''), a.mime || 'application/octet-stream', a.name)); } catch (e) { Logger.log('첨부 해제 실패 (건너뜀) %s: %s', a.name, e.message); } }); // 첨부 하나가 깨져도 메일 본문은 저장
  var attachmentFiles = saveAttachments_(id.replace(/^eml:/, ''), blobs, date);
  var attachmentNames = attachmentFiles.length ? attachmentFiles.map(function (f) { return f.name; }) : m.attachments.map(function (a) { return a.name; });
  var row = buildIndexRow({
    id: id, threadId: importThreadId_(m.threadHint), date: date, category: cls.category,
    labelNames: cls.labelNames, headers: m.headers, snippet: String(m.bodyText || '').replace(/\s+/g, ' ').slice(0, 160),
    sizeEstimate: bin.length, attachmentNames: attachmentNames, attachmentFiles: attachmentFiles, bodyPreview: m.bodyText,
    driveFileId: saved.fileId, driveUrl: saved.url, backedUpAt: new Date(),
  });
  return { row: row, id: id, skipped: false, bytes: bin.length };
}
/** 대화 묶음 키: Takeout X-GM-THRID 는 Gmail threadId(16진)와 같아 백업분과 합쳐지고, 그 외는 대화 첫 Message-ID 해시. 없으면 '' (메일 단독) */
function importThreadId_(hint) {
  hint = String(hint || '');
  if (hint.indexOf('gm:') === 0) return hint.slice(3);
  if (hint.indexOf('ref:') === 0) return 'ref:' + sha1Hex_(hint.slice(4)).slice(0, 24);
  return '';
}

// ---------- 예전 버전이 남긴 행 복구: 인코딩된 라벨명이 수식(#ERROR!)으로 들어간 셀, 원본 파일 ID로 묶인 threadId ----------
var IMPORT_REPAIR_RULES = 7; // 감지 규칙을 넓힐 때마다 올린다 → "고칠 것 없음" 캐시가 무효화돼 다시 훑는다
var IMPORT_REPAIR_PROP = 'IMPORT_REPAIR_DONE_R' + IMPORT_REPAIR_RULES;
/** 복구할 행이 있는지 (한 번 끝나면 속성으로 기억해 다시 훑지 않음) */
function importRepairNeeded_() {
  if (getProp_(IMPORT_REPAIR_PROP, '') === '1') return false;
  try {
    var sheet = importSheet_(), last = sheet.getLastRow();
    if (last < 2) { props_().setProperty(IMPORT_REPAIR_PROP, '1'); return false; }
    var lc = INDEX_HEADERS.indexOf('labels'), vals = sheet.getRange(2, 1, last - 1, lc + 1).getValues();
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).indexOf('eml:') === 0 && (String(vals[i][1]).indexOf('src:') === 0 || repairBadCategory_(String(vals[i][3])) || (String(vals[i][3]) === '보관됨' && !String(vals[i][lc] || '').trim()))) return true; // 라벨 없이 보관됨이 된 행도 원본 헤더로 재확인
    var f = sheet.getRange(2, INDEX_HEADERS.indexOf('category') + 1, last - 1, 1).getFormulas();
    for (var j = 0; j < f.length; j++) if (f[j][0]) return true;
    props_().setProperty(IMPORT_REPAIR_PROP, '1');
    return false;
  } catch (e) { return false; }
}
/** 잘못된 카테고리 값: 수식 오류 표시, 안 풀린 인코딩, 라벨 목록 전체가 통째로 들어간 것(쉼표 포함) */
function repairBadCategory_(v) {
  v = String(v || '').trim();
  if (v === '#ERROR!' || v.indexOf('=?') === 0 || v.indexOf(',') >= 0 || /\uFFFD/.test(v)) return true; // 수식·미해독·목록 통째·깨진 글자
  if (!v || SYSTEM_CATEGORY_NAMES[v]) return false; // 정상 시스템 폴더명
  if (ignoredLabelSet(getSettings_())[labelKey_(v)]) return true; // 설정에서 무시하기로 한 라벨이 폴더가 된 것
  var g = gmailLabelsToIds(v), ids = g.labelIds, known = knownUserLabels_(); // 시스템 라벨 표기("중요편지함", "개인정보 카테고리", "열림" 등)가 폴더가 된 것
  for (var i = 0; i < ids.length; i++) if (ids[i].indexOf('user:') === 0) return !isRealUserLabel_(g.labelMap[ids[i]], known); // 사용자 라벨이라도 Gmail 에 없는 이름("수신확인 보냄")이면 고칠 대상
  return true;
}
/**
 * 복구 한 구간: 행마다 (1) 수식이 된 카테고리/라벨 셀을 디코딩한 텍스트로, (2) 파일을 올바른 카테고리 폴더로 이동, (3) threadId를 메일 헤더(X-GM-THRID 등)로.
 * @returns {{done:boolean, fixed:number, total:number}}
 */
function repairImportRows_(cursor, deadline, settings) {
  var sheet = importSheet_(), last = sheet.getLastRow(), cols = INDEX_HEADERS.length;
  var out = { done: true, fixed: cursor.repairFixed || 0, total: Math.max(0, last - 1) };
  if (last < 2) return out;
  var C = { id: 0, thread: 1, date: 2, category: 3, labels: 5, from: INDEX_HEADERS.indexOf('from'), fileId: INDEX_HEADERS.indexOf('driveFileId') };
  var startRow = cursor.repairRow || 2;
  cursor.repairTotal = last - 1; cursor.repairPhase = 'rows';
  var BATCH = 100;
  for (var r0 = startRow; r0 <= last; r0 += BATCH) {
    var n = Math.min(BATCH, last - r0 + 1);
    var rng = sheet.getRange(r0, 1, n, cols), vals = rng.getValues(), forms = rng.getFormulas(), changed = false;
    for (var i = 0; i < n; i++) {
      if (Date.now() > deadline) { cursor.repairRow = r0 + i; cursor.repairFixed = out.fixed; if (changed) rng.setValues(vals.map(sheetSafeRowGas_)); out.done = false; return out; }
      var id = String(vals[i][C.id] || ''); if (id.indexOf('eml:') !== 0) continue;
      var touched = false;
      for (var c = 0; c < cols; c++) if (forms[i][c] && c !== C.category && c !== C.labels) { vals[i][c] = mimeDecodeWords_(forms[i][c], decodeCharsetGas_); touched = true; } // 수식이 된 다른 셀(제목 등)은 원문 텍스트로
      var suspectArchived = String(vals[i][C.category]) === '보관됨' && !String(vals[i][C.labels] || '').trim();
      if (forms[i][C.category] || forms[i][C.labels] || repairBadCategory_(String(vals[i][C.category])) || suspectArchived) {
        // 기준은 원본 .eml 의 X-Gmail-Labels 헤더 (읽을 수 있으면). 못 읽으면 라벨 셀(수식이면 수식 원문) → 카테고리 셀 순.
        // Takeout은 목록 전체를 인코딩 단어 하나로 싸기도 하므로 먼저 풀고 나서 쉼표로 나눠 다시 분류한다
        var decoded = null, fromHdr = String(vals[i][C.from] || '');
        try { var hh = mimeParseHeaders_(headOf_(String(vals[i][C.fileId]))); if (hh['x-gmail-labels'] != null) { decoded = String(hh['x-gmail-labels']).split(',').map(function (x) { return mimeDecodeWords_(x.trim(), decodeCharsetGas_); }).filter(Boolean).join(','); fromHdr = mimeDecodeWords_(hh['from'] || fromHdr, decodeCharsetGas_); } } catch (eh) { /* 아래 폴백 */ }
        if (decoded == null) { var rawList = forms[i][C.labels] || String(vals[i][C.labels] || '') || forms[i][C.category] || String(vals[i][C.category] || ''); decoded = mimeDecodeWords_(rawList, decodeCharsetGas_).replace(/#ERROR!/g, ''); }
        var cls = classifyLabels_(decoded.split(/\s*,\s*/).filter(Boolean).join(','), fromHdr, settings);
        var moved = cls.category !== String(vals[i][C.category]);
        vals[i][C.category] = cls.category; vals[i][C.labels] = cls.labelNames.join(', ') || (cls.category === '보관됨' ? '(라벨 없음)' : ''); touched = true; // 라벨이 정말 없으면 표시를 남겨 다음부터 재확인하지 않음
        if (moved) { try { moveImportedFile_(String(vals[i][C.fileId]), cls.category, vals[i][C.date], settings); cursor.movedFiles = (cursor.movedFiles || 0) + 1; } catch (e) { cursor.errors += 1; cursor.lastError = '파일 이동 실패: ' + e.message; noteMoveFailed_(String(vals[i][C.fileId])); Logger.log('복구: 파일 이동 실패 %s', e.message); } }
      }
      if (String(vals[i][C.thread] || '').indexOf('src:') === 0) { // 원본 파일 ID로 묶여 있던 대화 → 메일 헤더에서 다시
        var key = '';
        try { key = importThreadId_(mimeThreadHint_(mimeParseHeaders_(headOf_(String(vals[i][C.fileId]))))); } catch (e2) { Logger.log('복구: 헤더 읽기 실패 %s', e2.message); }
        vals[i][C.thread] = key; touched = true;
      }
      if (touched) { changed = true; out.fixed += 1; }
      if ((r0 + i) % 25 === 0) { cursor.repairRow = r0 + i + 1; cursor.repairFixed = out.fixed; setImportStatus_({ state: 'running', message: '오류 수정 중 · 행 점검 ' + (r0 + i) + '/' + (last - 1) + ' · 고침 ' + out.fixed, cursor: cursor }); }
    }
    if (changed) rng.setValues(vals.map(sheetSafeRowGas_));
    cursor.repairRow = r0 + n; cursor.repairFixed = out.fixed;
  }
  // 파일 위치 점검: 가져온 파일이 자기 카테고리 폴더에 없으면 옮긴다 (예전 복구가 시트만 고치고 파일을 못 옮긴 경우)
  var sw = sweepImportedFiles_(cursor, deadline, settings);
  if (!sw.done) { out.done = false; cursor.repairFixed = out.fixed; return out; }
  // 백업 시트도 수식이 된 셀(예: '=== 공지 ===' 제목)을 텍스트로
  try { repairSheetFormulas_(indexSheet_()); } catch (e4) { Logger.log('백업 시트 수식 복구 실패: %s', e4.message); }
  // 비어 버린 '=?…' 폴더 정리
  try { var root = rootFolder_(), it = root.getFolders(); while (it.hasNext()) { var d = it.next(); if ((/^=\?/.test(d.getName()) || d.getName().indexOf(',') >= 0) && !d.getFiles().hasNext() && !d.getFolders().hasNext()) d.setTrashed(true); } } catch (e3) { /* 무시 */ }
  props_().setProperty(IMPORT_REPAIR_PROP, '1');
  delete cursor.repairRow;
  return out;
}
/** 시트의 수식 셀을 모두 그 수식 원문(텍스트)으로 되돌린다 */
function repairSheetFormulas_(sheet) {
  var last = sheet.getLastRow(), cols = INDEX_HEADERS.length; if (last < 2) return 0;
  var rng = sheet.getRange(2, 1, last - 1, cols), forms = rng.getFormulas(), vals = null, n = 0;
  for (var i = 0; i < forms.length; i++) for (var c = 0; c < cols; c++) if (forms[i][c]) { if (!vals) vals = rng.getValues(); vals[i][c] = forms[i][c]; n += 1; }
  if (vals) rng.setValues(vals.map(sheetSafeRowGas_));
  return n;
}
/** 'src:<id>' 완료 표시를 'srcretry:<id>' 로 바꿔 그 파일이 다시 대기 목록에 오르게 한다. @returns 바꾼 파일 수 */
function unmarkImportFiles_(sheet, fileIds) {
  var last = sheet.getLastRow(); if (last < 2 || !fileIds.length) return 0;
  var want = {}; fileIds.forEach(function (id) { want['src:' + id] = true; });
  var rng = sheet.getRange(2, 2, last - 1, 1), vals = rng.getValues(), n = 0, seen = {};
  for (var i = 0; i < vals.length; i++) { var t = String(vals[i][0] || ''); if (want[t]) { vals[i][0] = 'srcretry:' + t.slice(4); if (!seen[t]) { seen[t] = true; n += 1; } } }
  if (n) rng.setValues(vals);
  return n;
}
/** 드라이브 파일의 헤더 부분(첫 32KB 중 빈 줄까지)을 바이너리 문자열로 */
function headOf_(fileId) { var head = u8ToBin(readFileRange_(fileId, 0, 32767)), cut = head.search(/\r?\n\r?\n/); return cut > 0 ? head.slice(0, cut) : head; }
/** 파일을 카테고리 폴더로 옮기고, 실제로 옮겨졌는지 부모 폴더로 확인한다 */
function moveImportedFile_(fileId, category, date, settings) {
  var lastErr = null;
  for (var attempt = 0; attempt < 3; attempt++) { // "서비스 오류: Drive" 같은 일시 오류는 잠깐 쉬고 다시
    try {
      var f = DriveApp.getFileById(fileId);
      var target = ensureFolderPath_(buildFolderPath(category, new Date(date), CONFIG.TIME_ZONE, settings.folderLayout));
      var ps = f.getParents(); if (ps.hasNext() && ps.next().getId() === target.getId()) return false;
      f.moveTo(target);
      var ps2 = f.getParents(); if (!ps2.hasNext() || ps2.next().getId() !== target.getId()) throw new Error('이동 후 확인 실패: ' + f.getName());
      return true;
    } catch (e) { lastErr = e; if (/not found|찾을 수 없|권한|permission/i.test(String(e.message || e))) break; Utilities.sleep(1500 * (attempt + 1)); }
  }
  throw lastErr;
}
/** 끝까지 옮기지 못한 파일 목록 (다음 오류 수정 때 다시 시도하도록 감지 대상에 포함) */
var IMPORT_MOVE_FAILED_PROP = 'IMPORT_MOVE_FAILED_JSON';
/** 지난 오류 수정이 오류를 남기고 끝났으면(파일 이동 실패 등) 다음 오류 수정을 다시 제안한다. 깨끗이 끝나면 해제 */
var IMPORT_REPAIR_RETRY_PROP = 'IMPORT_REPAIR_RETRY';
function repairRetryNeeded_() {
  var v = getProp_(IMPORT_REPAIR_RETRY_PROP, '');
  if (v === '1') return true; if (v === '0') return false;
  var h = importHistory_(); for (var i = 0; i < h.length; i++) if (h[i].kind === 'repair') return (h[i].errors || 0) > 0; // 예전 버전 기록: 마지막 오류 수정이 오류로 끝났는지
  return false;
}
function moveFailedIds_() { try { return JSON.parse(getProp_(IMPORT_MOVE_FAILED_PROP, '[]')) || []; } catch (e) { return []; } }
function noteMoveFailed_(fileId) { var l = moveFailedIds_(); if (l.indexOf(fileId) < 0) { l.push(fileId); try { props_().setProperty(IMPORT_MOVE_FAILED_PROP, JSON.stringify(l.slice(0, 500))); } catch (e) { /* 무시 */ } } }
/** 모든 가져온 행을 훑어 파일이 카테고리 폴더 밖에 있으면 옮긴다. 구간 시간 안에 못 끝내면 cursor.sweepRow 에 이어갈 행을 남긴다 */
function sweepImportedFiles_(cursor, deadline, settings) {
  var sheet = importSheet_(), last = sheet.getLastRow(), out = { done: true, moved: cursor.movedFiles || 0 };
  if (last < 2) return out;
  var C = { id: 0, date: 2, category: 3, fileId: INDEX_HEADERS.indexOf('driveFileId') };
  var vals = sheet.getRange(2, 1, last - 1, C.fileId + 1).getValues();
  cursor.repairPhase = 'sweep'; cursor.sweepTotal = vals.length; cursor.repairRow = last; // 행 점검은 끝남
  if (!cursor.sweepRow) props_().deleteProperty(IMPORT_MOVE_FAILED_PROP); // 새 점검 시작: 실패 목록은 이번 점검 결과로 다시 채운다
  for (var i = (cursor.sweepRow || 2) - 2; i < vals.length; i++) {
    if (Date.now() > deadline) { cursor.sweepRow = i + 2; out.done = false; return out; }
    var id = String(vals[i][C.id] || ''), fid = String(vals[i][C.fileId] || ''), cat = String(vals[i][C.category] || '');
    if (id.indexOf('eml:') !== 0 || !fid || !cat || repairBadCategory_(cat)) continue;
    try { if (moveImportedFile_(fid, cat, vals[i][C.date], settings)) { cursor.movedFiles = (cursor.movedFiles || 0) + 1; out.moved += 1; } }
    catch (e) { cursor.errors += 1; cursor.lastError = '파일 이동 실패: ' + e.message; noteMoveFailed_(fid); Logger.log('위치 점검: 이동 실패 %s', e.message); }
    if (i % 25 === 0) { cursor.sweepRow = i + 2; setImportStatus_({ state: 'running', message: '오류 수정 중 · 파일 위치 점검 ' + (i + 1) + '/' + vals.length + ' · 옮김 ' + (cursor.movedFiles || 0), cursor: cursor }); }
  }
  delete cursor.sweepRow;
  return out;
}
function fmtRepair_(c) { return (c.repairRow ? (c.repairRow - 1) + '행' : '') + (c.repairFixed ? ' · ' + c.repairFixed + '건 수정' : ''); }
function sheetSafeRowGas_(row) { return row.map(function (v) { return typeof v === 'string' && v.charAt(0) === '=' ? "'" + v : v; }); }

/** 파일 하나를 끝까지 처리했다는 표시 행 (목록에는 안 보임, 다음 실행에서 건너뜀). failed=true 면 'srcfail:' 기록만 남기고 다음 "시작" 때 다시 시도한다 */
function importDoneRow_(fileId, note, failed, file) {
  var size = 0, mtime = new Date();
  if (file) { try { size = Number(file.getSize()) || 0; mtime = file.getLastUpdated(); } catch (e) { /* 무시 */ } }
  return buildIndexRow({ id: 'emldup:' + fileId, threadId: (failed ? 'srcfail:' : 'src:') + fileId, date: mtime, category: failed ? '가져옴-실패' : '가져옴-처리됨', labelNames: [], headers: { subject: note || '' }, sizeEstimate: size, backedUpAt: new Date() });
}
/** 예전 버전이 실패한 파일에도 'src:' 완료 표시를 남겨 다시 시도할 수 없던 문제 복구: 실패 표시 행을 'srcfail:'로 바꾼다 */
function repairFailedImportMarkers_() {
  try {
    var sheet = importSheet_(), last = sheet.getLastRow();
    if (last < 2) return 0;
    var subjCol = INDEX_HEADERS.indexOf('subject') + 1;
    var vals = sheet.getRange(2, 1, last - 1, subjCol).getValues(), n = 0;
    for (var i = 0; i < vals.length; i++) {
      var t = String(vals[i][1] || ''), sub = String(vals[i][subjCol - 1] || '');
      if (t.indexOf('src:') === 0 && sub.indexOf('실패:') === 0) { sheet.getRange(i + 2, 2).setValue('srcfail:' + t.slice(4)); n += 1; }
    }
    return n;
  } catch (e) { Logger.log('실패 표시 복구 실패: %s', e.message); return 0; }
}

/** Drive 파일의 바이트 구간을 Uint8Array로 읽는다 (큰 파일을 창 단위로) */
function readFileRange_(fileId, start, endInclusive) {
  var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + start + '-' + endInclusive }, muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code !== 206 && code !== 200) throw new Error('파일 읽기 실패 (' + code + '): ' + res.getContentText().slice(0, 200));
  var bytes = res.getContent(), u8 = new Uint8Array(bytes.length);
  for (var i = 0; i < bytes.length; i++) u8[i] = bytes[i] & 255;
  return u8;
}
/** 압축 해제 상태 스냅샷 저장소: <루트>/_import_state/<fileId>.json (앱이 만든 파일이라 drive.file로 쓰기 가능) */
var IMPORT_STATE_FOLDER = '_import_state';
var importCodec_ = {
  enc: function (u8) { var arr = new Array(u8.length); for (var i = 0; i < u8.length; i++) arr[i] = u8[i] > 127 ? u8[i] - 256 : u8[i]; return Utilities.base64Encode(arr); },
  dec: function (b64) { var bytes = Utilities.base64Decode(b64), u8 = new Uint8Array(bytes.length); for (var i = 0; i < bytes.length; i++) u8[i] = bytes[i] & 255; return u8; },
};
function importStateFolder_() { return ensureFolderPath_([IMPORT_STATE_FOLDER]); }
function importStateFile_(fileId) { var it = importStateFolder_().getFilesByName(fileId + '.json'); return it.hasNext() ? it.next() : null; }
function saveImportSnapshot_(fileId, snapshot) {
  var json = JSON.stringify(snapshot);
  var f = importStateFile_(fileId);
  if (f) f.setContent(json); else importStateFolder_().createFile(fileId + '.json', json, 'application/json');
}
function loadImportSnapshot_(fileId) {
  var f = importStateFile_(fileId); if (!f) return null;
  try { return JSON.parse(f.getBlob().getDataAsString('UTF-8')); } catch (e) { return null; }
}
function deleteImportSnapshot_(fileId) { var f = importStateFile_(fileId); if (f) { try { f.setTrashed(true); } catch (e) { /* 무시 */ } } }

/** zip 엔트리(.eml 등 mbox가 아닌 것) 전체를 바이너리 문자열로 */
function readZipEntryAll_(fileId, entry, dataStart) {
  if (entry.size > IMPORT_MAX_EML_BYTES) throw new Error(entry.name + ': 파일이 너무 큽니다');
  var comp = entry.compSize ? readFileRange_(fileId, dataStart, dataStart + entry.compSize - 1) : new Uint8Array(0);
  if (entry.method === 0) return u8ToBin(comp);
  if (entry.method !== 8) throw new Error(entry.name + ': 지원하지 않는 압축 방식(' + entry.method + ')');
  return u8ToBin(pako.inflateRaw(comp));
}

// ---------- 실행 (백업과 독립: 자체 임대·트리거·상태) ----------
function importStatus_() { try { return JSON.parse(getProp_(IMPORT_PROP.STATUS, '{}')) || {}; } catch (e) { return {}; } }
var importRunClock_ = null; // { started, base } — 실행 중 상태 기록마다 경과 시간을 커서에 반영
function setImportStatus_(patch) {
  if (patch.cursor && importRunClock_) patch.cursor.activeSeconds = importRunClock_.base + (Date.now() - importRunClock_.started) / 1000;
  var st = importStatus_(); Object.keys(patch).forEach(function (k) { st[k] = patch[k]; }); st.updatedAt = new Date().toISOString();
  try { props_().setProperty(IMPORT_PROP.STATUS, JSON.stringify(st)); } catch (e) { delete st.cursor; props_().setProperty(IMPORT_PROP.STATUS, JSON.stringify(st)); }
}
function importCursor_() { try { return JSON.parse(getProp_(IMPORT_PROP.CURSOR, '') || 'null'); } catch (e) { return null; } }
function saveImportCursor_(c) { if (c && importRunClock_) c.activeSeconds = importRunClock_.base + (Date.now() - importRunClock_.started) / 1000; props_().setProperty(IMPORT_PROP.CURSOR, JSON.stringify(c)); }
function importHistory_() { try { return JSON.parse(getProp_(IMPORT_PROP.HISTORY, '[]')) || []; } catch (e) { return []; } }
function deleteImportTriggers_() { ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === IMPORT_FN) ScriptApp.deleteTrigger(t); }); }
function scheduleImport_(delayMs) {
  ScriptApp.newTrigger(IMPORT_FN).timeBased().after(delayMs || CONFIG.CONTINUE_DELAY_MS).create();
  if (ScriptApp.getProjectTriggers().length < 15) ScriptApp.newTrigger(IMPORT_FN).timeBased().after(Math.max(15 * 60 * 1000, (delayMs || 0) + 5 * 60 * 1000)).create();
}
function importLeaseHeld_() { return Number(getProp_(IMPORT_PROP.LEASE, '0')) > Date.now(); }
/** 커서만으로 계산하는 진행률: 이번 실행에서 끝낸 파일 바이트 + 현재 파일의 읽은 입력 위치 / 구간 시작 때 잰 전체 바이트 (200개 넘는 파일은 다음 구간에서 합산되므로 99%로 막음) */
/** 오류 수정 실행의 진행 정보 (실행 중·대기 중인 오류 수정 커서에서) */
function importRepairInfo_(c) {
  c = c || {};
  if (!c.repairOnly && !c.wasRepair) return null;
  var phase = c.repairPhase || 'rows', done, total;
  if (phase === 'sweep') { done = Math.max(0, (c.sweepRow || 2) - 2); total = c.sweepTotal || 0; }
  else { done = Math.max(0, (c.repairRow || 2) - 2); total = c.repairTotal || 0; }
  return { active: !!c.repairOnly, phase: phase, done: done, total: total, percent: total ? Math.min(100, Math.floor(done / total * 100)) : null, fixed: c.repairFixed || 0, moved: c.movedFiles || 0, retrying: c.retrying || 0 };
}
function importProgress_(c) {
  c = c || {};
  var done = (c.fileBytes || 0) + (c.cur ? (c.cur.inPos || 0) : 0), total = c.totalBytes || 0;
  var pct = total ? Math.min(c.totalCapped ? 99 : 100, Math.floor(done / total * 100)) : null;
  var active = c.activeSeconds || 0, eta = pct && pct < 100 && active > 5 ? Math.round(active * (100 - pct) / pct) : null;
  return { percent: pct, doneBytes: done, totalBytes: total, filesDone: c.files || 0, filesTotal: (c.files || 0) + (c.pendingFiles || 0), etaSeconds: eta,
    curFile: c.cur ? c.cur.name : null, curPos: c.cur ? (c.cur.inPos || 0) : 0, curSize: c.cur ? (c.cur.size || 0) : 0, curPercent: c.cur && c.cur.size ? Math.min(100, Math.floor((c.cur.inPos || 0) / c.cur.size * 100)) : null };
}
function newImportCursor_() { return { startedAt: new Date().toISOString(), processed: 0, skipped: 0, errors: 0, chunks: 0, bytes: 0, files: 0, lastError: null, cur: null }; }

function startImport() {
  props_().deleteProperty(IMPORT_PROP.STOP);
  deleteImportTriggers_();
  importFolder_(true);
  var existing = importCursor_(), c = existing || newImportCursor_();
  if (!existing) { repairFailedImportMarkers_(); c.failed = {}; } // 새 실행: 지난 실행에서 실패한 파일을 다시 시도 (failed = 이번 실행에서 실패한 파일, 구간이 바뀌어도 같은 실행 안에서는 재시도 안 함)
  saveImportCursor_(c);
  var err = '';
  try { scheduleImport_(5 * 1000); } catch (e) { err = String(e && e.message || e); }
  setImportStatus_({ state: 'queued', message: err ? '트리거 생성 실패: ' + err : '대기열 등록 · 곧 시작', cursor: c, queuedAt: new Date().toISOString() });
  return getImportState();
}
/** "오류 수정" 버튼: 예전 행 복구만 하는 실행을 예약한다 (가져오기 중이면 거부). 중지된 가져오기가 있으면 복구 뒤 다시 중지 상태로 둔다 */
function startImportRepair() {
  var st = importStatus_();
  if (/^(running|queued|stopping)$/.test(st.state || '') || importLeaseHeld_()) throw new Error('가져오기가 실행 중입니다. 끝나거나 중지한 뒤 눌러 주세요');
  if (!importRepairNeeded_() && !Object.keys(importFailedMap_()).length && !moveFailedIds_().length && !repairRetryNeeded_()) return getImportState();
  armImportRepair_(st.state, 5 * 1000, '');
  return getImportState();
}
/** 오류 수정 실행을 예약한다 (버튼·자동 공용). auto 는 상태 메시지에 표시할 접두어 */
function armImportRepair_(prevState, delayMs, auto) {
  props_().deleteProperty(IMPORT_PROP.STOP);
  deleteImportTriggers_();
  var c = importCursor_() || newImportCursor_(); c.repairOnly = true; c.repairPrevState = prevState === 'paused' || prevState === 'error' ? 'paused' : 'idle';
  c.retryFiles = Object.keys(importFailedMap_()); // 실패한 메일이 있던 원본 파일: 복구 뒤 다시 훑는다
  if (auto) c.autoRepair = true;
  saveImportCursor_(c);
  var err = '';
  try { scheduleImport_(delayMs); } catch (e) { err = String(e && e.message || e); }
  setImportStatus_({ state: 'queued', message: err ? '트리거 생성 실패: ' + err : (auto ? auto + ' · ' : '') + '오류 수정(라벨·폴더·대화 묶음) 예약 · 곧 시작', cursor: c, queuedAt: new Date().toISOString() });
}
// ---------- 자동 오류 수정: 일반 가져오기가 "완료"된 직후 한 번만 (오류 수정 실행이 끝난 뒤에는 다시 걸지 않아 무한 반복이 없음) ----------
var IMPORT_AUTO_PROP = 'IMPORT_AUTO_REPAIR', IMPORT_AUTO_LOG = 'IMPORT_AUTO_REPAIR_LOG', IMPORT_AUTO_MAX_PER_DAY = 3;
function importAutoRepairOn_() { return getProp_(IMPORT_AUTO_PROP, '') === '1'; }
function setImportAutoRepair(on) { if (on) props_().setProperty(IMPORT_AUTO_PROP, '1'); else props_().deleteProperty(IMPORT_AUTO_PROP); return getImportState(); }
/** 오늘 자동 수정 횟수가 상한 미만이면 기록하고 true */
function autoRepairAllowed_() {
  var day = Utilities.formatDate(new Date(), CONFIG.TIME_ZONE, 'yyyy-MM-dd'), log = {};
  try { log = JSON.parse(getProp_(IMPORT_AUTO_LOG, '{}')) || {}; } catch (e) { /* 무시 */ }
  if (log.day !== day) log = { day: day, n: 0 };
  if (log.n >= IMPORT_AUTO_MAX_PER_DAY) return false;
  log.n += 1; props_().setProperty(IMPORT_AUTO_LOG, JSON.stringify(log));
  return true;
}
/** 가져오기 완료 지점에서 호출: 자동 수정이 켜져 있고, 이번 실행이 오류 수정 실행이 아니었고, 고칠 것이 있으면 예약. @returns 예약했으면 메시지 */
function maybeAutoRepair_(cursor) {
  if (!importAutoRepairOn_() || cursor.wasRepair) return '';
  var need = false; try { need = Object.keys(importFailedMap_()).length > 0 || moveFailedIds_().length > 0 || repairRetryNeeded_() || importRepairNeeded_(); } catch (e) { return ''; }
  if (!need) return '';
  if (!autoRepairAllowed_()) return ' · 자동 오류 수정은 하루 ' + IMPORT_AUTO_MAX_PER_DAY + '회까지라 이번엔 건너뜀 (버튼으로 실행 가능)';
  try { armImportRepair_('idle', 60 * 1000, '자동'); } catch (e) { return ''; }
  return ' · 자동 오류 수정을 1분 뒤 시작합니다';
}
/** "재감지": 고칠 것 없음 캐시와 Gmail 라벨 목록 캐시를 지우고 다시 검사한다 */
function redetectImport() {
  props_().deleteProperty(IMPORT_REPAIR_PROP);
  props_().deleteProperty(KNOWN_LABELS_PROP); knownLabelsMem_ = null;
  return getImportState();
}
function stopImport() { props_().setProperty(IMPORT_PROP.STOP, '1'); deleteImportTriggers_(); if (!importLeaseHeld_()) { props_().deleteProperty(IMPORT_PROP.STOP); setImportStatus_({ state: importCursor_() ? 'paused' : 'idle', message: '중지됨' }); } else setImportStatus_({ state: 'stopping', message: '중지 중 · 현재 파일까지 저장 후 멈춥니다' }); return getImportState(); }
function cancelImport() { props_().deleteProperty(IMPORT_PROP.STOP); deleteImportTriggers_(); var c = importCursor_(); props_().deleteProperty(IMPORT_PROP.CURSOR); if (c && c.cur && c.cur.id) { try { deleteImportSnapshot_(c.cur.id); } catch (e) { /* 무시 */ } } if (c && (c.processed || c.errors)) appendImportHistory_(Object.assign(c, { finishedAt: new Date().toISOString(), status: 'cancelled' })); setImportStatus_({ state: 'idle', message: '취소됨', cursor: {} }); return getImportState(); }

function getImportState() {
  var st = importStatus_(), c = st.cursor || importCursor_() || {};
  if (/^(running|queued)$/.test(st.state || '') && !importLeaseHeld_() && Date.now() - new Date(st.updatedAt || 0).getTime() > 20 * 60 * 1000) {
    var pending = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === IMPORT_FN; });
    if (!pending && importCursor_()) { try { scheduleImport_(5 * 1000); } catch (e) { /* 무시 */ } setImportStatus_({ state: 'queued', message: '실행이 끊겨 다시 예약함' }); st = importStatus_(); }
  }
  var failedMsgs = failedMessageCount_();
  var moveFailed = moveFailedIds_().length, retryRepair = repairRetryNeeded_();
  var repairNeeded = failedMsgs > 0 || moveFailed > 0 || retryRepair; try { repairNeeded = repairNeeded || importRepairNeeded_(); } catch (e) { /* 무시 */ } // 실행 중에도 감지 (버튼은 실행 중이면 비활성), 실행은 사용자가 버튼으로
  var pendingCount = null, folderExists = false;
  try { cleanupImportDone_(getSettings_(), false); } catch (e0) { /* 무시 */ }
  try {
    folderExists = !!importFolder_(false);
    var rep = { pending: [], unsupported: [], done: [] };
    pendingCount = folderExists ? listImportFiles_(loadBackedUpIds_(), 2000, rep).length : 0;
    var files = rep;
    // 대기 0인데 예전 버전이 실패한 파일에 남긴 완료 표시가 있으면 여기서 복구 (시작 버튼은 대기 0이면 눌리지 않으므로)
    if (folderExists && !pendingCount && !/^(running|queued|stopping)$/.test(st.state || '') && repairFailedImportMarkers_() > 0) { rep = { pending: [], unsupported: [], done: [] }; pendingCount = listImportFiles_(loadBackedUpIds_(), 2000, rep).length; files = rep; }
  } catch (e) { pendingCount = null; }
  return {
    state: st.state || 'idle', message: st.message || '', updatedAt: st.updatedAt || null,
    cursor: { startedAt: c.startedAt || null, processed: c.processed || 0, skipped: c.skipped || 0, errors: c.errors || 0, chunks: c.chunks || 0, bytes: c.bytes || 0, files: c.files || 0, lastError: c.lastError || null, activeSeconds: c.activeSeconds || 0, curFile: c.cur ? c.cur.name : null, curOffset: c.cur ? c.cur.offset : 0, curSize: c.cur ? c.cur.size : 0 },
    progress: importProgress_(c), repair: importRepairInfo_(c), repairNeeded: repairNeeded, failedMsgs: failedMsgs, moveFailed: moveFailed, retryRepair: retryRepair, autoRepair: importAutoRepairOn_(),
    pending: pendingCount, pendingCapped: pendingCount != null && pendingCount >= 2000, files: typeof files !== 'undefined' ? files : null,
    folderExists: folderExists, folderUrl: folderExists ? importFolderUrl_() : '', folderPath: rootFolderPath_() + ' › ' + IMPORT_FOLDER_NAME,
    history: importHistory_(),
  };
}
function appendImportHistory_(c) {
  var h = importHistory_();
  if (c.kind === 'repair') h.unshift(c);
  else h.unshift({ kind: 'import', startedAt: c.startedAt, finishedAt: c.finishedAt, processed: c.processed, skipped: c.skipped, errors: c.errors, bytes: c.bytes, files: c.files, chunks: c.chunks, activeSeconds: c.activeSeconds || 0, status: c.status || 'done', lastError: c.lastError || null });
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
  importRunClock_ = { started: started, base: cursor.activeSeconds || 0 };
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
    if (cursor.repairOnly && (importRepairNeeded_() || moveFailedIds_().length || repairRetryNeeded_() || cursor.repairRow || cursor.sweepRow)) { // "오류 수정" 버튼으로 예약된 실행에서만 복구 (일반 가져오기 구간에는 끼어들지 않음)
      tickStatus('가져온 메일 복구 중 (라벨·폴더·대화 묶음)' + (cursor.repairRow ? ' · ' + fmtRepair_(cursor) : ''));
      var rep = repairImportRows_(cursor, deadline, settings);
      cursor.repairedTotal = rep.fixed;
      if (!rep.done) { saveImportCursor_(cursor); scheduleImport_(); setImportStatus_({ state: 'running', message: '복구 중 ' + fmtRepair_(cursor) + ' · 1분 뒤 이어서', cursor: cursor }); return; }
      refreshSummary_();
    }
    if (cursor.repairOnly) { // 오류 수정 실행: 행 복구가 끝난 자리
      var prev = cursor.repairPrevState, fixedN = cursor.repairedTotal || 0, retry = cursor.retryFiles || [];
      delete cursor.repairOnly; delete cursor.repairPrevState; delete cursor.repairedTotal; delete cursor.retryFiles; cursor.wasRepair = true; // 이 실행은 오류 수정 실행: 끝나도 자동 수정을 다시 걸지 않음
      cursor.activeSeconds = (cursor.activeSeconds || 0) + (Date.now() - started) / 1000; importRunClock_ = { started: Date.now(), base: cursor.activeSeconds };
      props_().setProperty(IMPORT_REPAIR_RETRY_PROP, cursor.errors ? '1' : '0'); // 오류가 남았으면 다음 오류 수정을 다시 제안
      appendImportHistory_({ kind: 'repair', startedAt: cursor.startedAt, finishedAt: new Date().toISOString(), fixed: fixedN, moved: cursor.movedFiles || 0, retryFiles: retry.length, errors: cursor.errors || 0, chunks: cursor.chunks, activeSeconds: cursor.activeSeconds, lastError: cursor.lastError || null, status: cursor.errors ? 'errors' : 'done' });
      var doneMsg = (fixedN ? '오류 수정 완료: ' + fixedN + '건의 라벨·폴더·대화 묶음을 고쳤습니다' : '오류 수정 완료') + (cursor.movedFiles ? ' · 파일 ' + cursor.movedFiles + '개를 맞는 폴더로 옮김' : '') + (cursor.errors ? ' · 오류 ' + cursor.errors + '건 (마지막: ' + (cursor.lastError || '') + ')' : ''); delete cursor.movedFiles;
      if (retry.length) { // 실패한 메일이 있던 파일은 완료 표시를 풀어 다시 훑는다 (이미 저장된 메일은 건너뛰므로 실패분만 추가됨)
        var unmarked = unmarkImportFiles_(sheet, retry);
        saveImportFailedMap_({});
        cursor.retrying = unmarked;
        tickStatus(doneMsg + ' · 실패했던 메일 재시도 중 (파일 ' + unmarked + '개)');
      } else {
        if (prev === 'paused') { saveImportCursor_(cursor); setImportStatus_({ state: 'paused', message: doneMsg + ' · 중지된 가져오기는 "이어서"로 계속', cursor: cursor }); }
        else { props_().deleteProperty(IMPORT_PROP.CURSOR); setImportStatus_({ state: 'idle', message: doneMsg, cursor: cursor }); }
        return;
      }
    }
    var backedUp = loadBackedUpIds_();
    var handleMessage = function (bin, fallbackId, srcId) {
      try {
        var r = importMessage_(bin, fallbackId, backedUp, settings, srcId);
        if (r.skipped) { cursor.skipped += 1; return; }
        pending.push(r.row); backedUp[r.id] = true; cursor.processed += 1; cursor.bytes += r.bytes || 0;
      } catch (e) { cursor.errors += 1; cursor.lastError = (cursor.cur ? cursor.cur.name : fallbackId) + ': ' + e.message; noteFailedMessage_(srcId, cursor.cur ? cursor.cur.name : '', e.message); Logger.log('가져오기 실패 %s: %s', fallbackId, e.stack || e.message); }
      if (pending.length >= CONFIG.INDEX_FLUSH_EVERY) flush();
      if ((cursor.processed + cursor.errors + cursor.skipped) % 10 === 0) tickStatus('가져오는 중 ' + cursor.processed + '건' + (cursor.cur ? ' · ' + cursor.cur.name : ''));
    };
    // 진행 중이던 파일부터, 그다음 새 파일들
    var entries = listImportFiles_(backedUp, 200).filter(function (e) { return !(cursor.failed && cursor.failed[e.file.getId()]); }); // 이번 실행에서 이미 실패한 파일은 제외
    if (cursor.cur) { // 진행 중이던 파일을 맨 앞에 (목록에 있으면 그 자리에서 빼고)
      entries = entries.filter(function (e) { return e.file.getId() !== cursor.cur.id; });
      try { var cf = DriveApp.getFileById(cursor.cur.id); entries.unshift({ file: cf, kind: cursor.cur.kind }); } catch (e) { cursor.cur = null; }
    }
    // 진행률 기준: 이번 실행에서 끝낸 파일 바이트 + 아직 남은 파일(현재 파일 포함) 바이트
    var pendingBytes = 0; for (var pi = 0; pi < entries.length; pi++) { try { pendingBytes += Number(entries[pi].file.getSize()) || 0; } catch (e) { /* 무시 */ } }
    cursor.fileBytes = cursor.fileBytes || 0; cursor.totalBytes = cursor.fileBytes + pendingBytes; cursor.pendingFiles = entries.length; cursor.totalCapped = entries.length >= 200;
    tickStatus('가져오는 중 (' + cursor.chunks + '번째 구간) · 파일 ' + entries.length + '개');
    for (var k = 0; k < entries.length; k++) {
      if (Date.now() > deadline) { outOfTime = true; break; }
      if (stopWanted()) { stopped = true; break; }
      var en = entries[k], file = en.file, fid = file.getId(), size = Number(file.getSize()) || 0;
      var resume = cursor.cur && cursor.cur.id === fid ? cursor.cur : null;
      cursor.cur = { id: fid, name: file.getName(), kind: en.kind, size: size, offset: resume ? resume.offset : 0, entry: resume ? (resume.entry || 0) : 0, inPos: resume ? (resume.inPos || 0) : 0 };
      try {
        var readRange = function (st, en2) { cursor.cur.inPos = en2 + 1; return readFileRange_(fid, st, en2); }; // inPos = 파일 안에서 읽은 위치 (압축 파일도 파일 기준 %)
        var stopRes = function () { return (Date.now() > deadline || stopWanted()) ? 'stop' : undefined; };
        var stream = function (opt) { // mbox 스트림 공통 (일반/ gzip / zip 엔트리). 스냅샷이 있으면 압축 해제기 상태째 이어간다 (GB급도 되감기 없음)
          var snap = loadImportSnapshot_(fid);
          if (snap && (snap.entry || 0) !== (cursor.cur.entry || 0)) snap = null;
          var r = streamMbox(Object.assign({ size: size, readRange: readRange, chunkBytes: IMPORT_CHUNK_BYTES, startOffset: cursor.cur.offset, maxMessageBytes: IMPORT_MAX_MESSAGE_BYTES, codec: importCodec_, resume: snap,
            log: function (m) { cursor.errors += 1; cursor.lastError = file.getName() + ': ' + m; },
            onMessage: function (bin, off) { handleMessage(mboxUnwrap(bin), fid + '#' + cursor.cur.entry + '#' + off, fid); cursor.cur.offset = off + bin.length; if ((cursor.processed + cursor.skipped + cursor.errors) % 20 === 0) saveImportCursor_(cursor); return stopRes(); } }, opt));
          if (r.stopped) { if (Date.now() > deadline) outOfTime = true; else stopped = true; if (r.snapshot) { r.snapshot.entry = cursor.cur.entry || 0; try { saveImportSnapshot_(fid, r.snapshot); } catch (e) { Logger.log('스냅샷 저장 실패: %s', e.message); } } }
          else deleteImportSnapshot_(fid);
          return r;
        };
        cursor.cur.entry = cursor.cur.entry || 0;
        if (en.kind === 'eml') {
          if (size > IMPORT_MAX_EML_BYTES) throw new Error('파일이 너무 큽니다 (' + Math.round(size / 1048576) + 'MB)');
          cursor.cur.inPos = size; handleMessage(bytesToBin_(file.getBlob().getBytes()), fid, fid);
        } else if (en.kind === 'mbox') {
          var r1 = stream({ decode: 'none' }); if (!r1.done) break;
        } else if (en.kind === 'gz') {
          var r2 = stream({ decode: 'gzip' }); if (!r2.done) break;
        } else if (en.kind === 'zip') {
          var zentries = listZipEntries(readRange, size);
          var zi = cursor.cur.entry, brokeOut = false;
          for (; zi < zentries.length; zi++) {
            var ze = zentries[zi], zname = String(ze.name || '').toLowerCase();
            if (zi !== cursor.cur.entry) { cursor.cur.entry = zi; cursor.cur.offset = 0; }
            if (!ze.size || /\/$/.test(ze.name)) continue;
            var ds = zipDataStart(readRange, ze);
            if (/\.mbox$/.test(zname) || /\.mbx$/.test(zname)) {
              var r3 = stream({ decode: ze.method === 8 ? 'deflate-raw' : 'none', dataStart: ds, dataEnd: ds + ze.compSize });
              if (!r3.done) { brokeOut = true; break; }
            } else if (/\.eml$/.test(zname)) {
              handleMessage(readZipEntryAll_(fid, ze, ds), fid + '#' + zi, fid);
              if (stopRes()) { cursor.cur.entry = zi + 1; cursor.cur.offset = 0; brokeOut = true; if (Date.now() > deadline) outOfTime = true; else stopped = true; break; }
            }
            tickStatus('가져오는 중 ' + cursor.processed + '건 · ' + file.getName() + ' (' + (zi + 1) + '/' + zentries.length + ')');
          }
          if (brokeOut) break;
        }
        pending.push(importDoneRow_(fid, file.getName(), false, file)); backedUp['src:' + fid] = true; if (archiveImportedFile_(file, settings)) cursor.archived = (cursor.archived || 0) + 1; cursor.files += 1; cursor.fileBytes = (cursor.fileBytes || 0) + size; cursor.pendingFiles = Math.max(0, (cursor.pendingFiles || 1) - 1); cursor.cur = null; deleteImportSnapshot_(fid);
      } catch (e) {
        cursor.errors += 1; cursor.lastError = file.getName() + ': ' + e.message;
        Logger.log('가져오기 파일 실패 %s: %s', file.getName(), e.stack || e.message);
        pending.push(importDoneRow_(fid, '실패: ' + e.message, true, file)); cursor.failed = cursor.failed || {}; cursor.failed[fid] = 1; cursor.fileBytes = (cursor.fileBytes || 0) + size; cursor.pendingFiles = Math.max(0, (cursor.pendingFiles || 1) - 1); cursor.cur = null; // 이번 실행에서는 다시 시도하지 않음 (다음 "시작" 때 재시도, 스냅샷은 남겨 이어감)
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
    if (cursor.processed || cursor.skipped || cursor.errors || cursor.files) appendImportHistory_(cursor);
    var nFailed = Object.keys(cursor.failed || {}).length;
    var trashed = 0; try { trashed = cleanupImportDone_(settings, true); } catch (e6) { /* 무시 */ }
    var autoMsg = maybeAutoRepair_(cursor) + (cursor.archived ? ' · 원본 ' + cursor.archived + '개를 처리됨 폴더로 옮김 (' + settings.importKeepDays + '일 보관)' : '') + (trashed ? ' · 보관 기간이 지난 원본 ' + trashed + '개 휴지통' : '');
    setImportStatus_({ state: 'idle', message: (cursor.repairedTotal ? '복구 완료: ' + cursor.repairedTotal + '건의 라벨·폴더·대화 묶음 수정 · ' : '') + '완료: ' + cursor.processed + '건 저장, ' + cursor.skipped + '건 중복, 오류 ' + cursor.errors + '건 (파일 ' + cursor.files + '개)' + (nFailed ? ' · 실패한 파일 ' + nFailed + '개는 "가져오기 시작"을 다시 누르면 재시도합니다' : '') + autoMsg, cursor: cursor, finishedAt: cursor.finishedAt });
    if (autoMsg && /시작합니다/.test(autoMsg)) { var stA = importStatus_(); setImportStatus_({ state: 'queued', message: stA.message, queuedAt: new Date().toISOString() }); } // 예약이 됐으면 대기열 상태로
    refreshSummary_();
  } catch (e) {
    try { flush(); } catch (e2) { /* 무시 */ }
    cursor.lastError = String(e && e.message || e); cursor.retries = (cursor.retries || 0) + 1;
    saveImportCursor_(cursor);
    if (cursor.retries <= 5) { try { scheduleImport_(5 * 60 * 1000); } catch (e3) { /* 무시 */ } setImportStatus_({ state: 'running', message: '오류 · 5분 뒤 재시도 (' + cursor.retries + '/5) · ' + cursor.lastError, cursor: cursor }); }
    else setImportStatus_({ state: 'error', message: '가져오기 실패: ' + cursor.lastError, cursor: cursor });
  } finally {
    importRunClock_ = null;
    props_().deleteProperty(IMPORT_PROP.LEASE);
  }
}
