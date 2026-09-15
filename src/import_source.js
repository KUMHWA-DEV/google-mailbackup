/**
 * 예전 .eml 백업 가져오기.
 * 사용자가 <루트>/_import 폴더(하위 폴더 포함)에 .eml 파일을 넣어 두면, 백업 실행이 이 폴더를 훑어
 * 서버에서 직접 해석해 일반 백업과 같은 구조(카테고리 폴더의 .eml 원본 + 첨부 + 인덱스 행)로 저장한다.
 *
 * 권한: 사용자가 Drive에서 넣은 파일은 앱이 만든 파일이 아니므로 drive.readonly 로 읽는다. 옮기거나 지우지는 못하므로
 * 처리한 파일은 인덱스에 'src:<fileId>' 로 기록해 다시 처리하지 않는다. 사용자는 _import 폴더를 언제든 비워도 된다.
 *
 * 인덱스 id: 'eml:' + Message-ID 해시 (없으면 파일 ID) — 같은 메일이 두 파일로 있어도 한 번만 저장.
 * 라벨: '가져옴' + 하위 폴더 이름(있으면). 보낸사람이 나면 보낸편지함, 아니면 하위 폴더명 또는 받은편지함.
 */
var IMPORT_FOLDER_NAME = '_import';
var IMPORT_MAX_BYTES = 30 * 1024 * 1024;

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

/** 가져올 파일 수(미리보기용). 상한까지만 센다. */
function countImportPending_(skipSet, cap) {
  return listImportFiles_(skipSet, cap || 5000).length;
}

/** Apps Script용 문자셋 디코더: 바이너리 문자열 → 바이트 → 문자셋 해석 */
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
 * .eml 파일 1건 → 저장 → 인덱스 행. backupOne_와 같은 형태의 행을 돌려준다.
 * @returns {{row:any[], id:string, skipped:boolean}}
 */
function importOne_(entry, backedUp, settings) {
  var file = entry.file, fileId = file.getId();
  if (file.getSize() > IMPORT_MAX_BYTES) throw new Error('파일이 너무 큽니다 (' + Math.round(file.getSize() / 1048576) + 'MB)');
  var bytes = file.getBlob().getBytes();
  var bin = Utilities.newBlob(bytes).getDataAsString('ISO-8859-1');
  var m = parseEml(bin, decodeCharsetGas_);
  var id = 'eml:' + (m.messageId ? sha1Hex_(m.messageId).slice(0, 24) : fileId);
  if (backedUp[id]) return { id: id, skipped: true, sourceRow: importMarkerRow_(id, fileId) }; // 같은 메일이 이미 있음 → 원본 파일만 처리됨으로 기록
  var me = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var fromAddr = String(m.headers.from || '').toLowerCase();
  var sent = !!me && fromAddr.indexOf(me) >= 0;
  var category = sent ? '보낸편지함' : (entry.label ? String(entry.label).replace(/\//g, '-') : '받은편지함');
  var date = m.date || file.getDateCreated();
  var folder = ensureFolderPath_(buildFolderPath(category, date, CONFIG.TIME_ZONE, settings.folderLayout));
  var fileName = buildFileName({ date: date, subject: m.headers.subject, id: id.replace(/^eml:/, '') }, CONFIG.TIME_ZONE);
  var saved = saveEml_(folder, fileName, bytes);
  var blobs = m.attachments.map(function (a) { return Utilities.newBlob(a.dataB64 ? Utilities.base64Decode(a.dataB64) : binToBytes_(a.data || ''), a.mime || 'application/octet-stream', a.name); });
  var attachmentFiles = saveAttachments_(id.replace(/^eml:/, ''), blobs, date);
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
/** 이미 있는 메일의 중복 파일: 파일 ID만 "처리됨"으로 남기는 최소 행 (id는 파일 기준, 본문 없음). */
function importMarkerRow_(dupId, fileId) {
  return buildIndexRow({ id: 'emldup:' + fileId, threadId: 'src:' + fileId, date: new Date(), category: '가져옴-중복', labelNames: ['가져옴', '중복'], headers: { subject: '(중복: ' + dupId + ')' }, sizeEstimate: 0, backedUpAt: new Date() });
}
