/**
 * Drive/Sheets 어댑터. 폴더 캐시, .eml 및 첨부 저장, 인덱스 시트.
 */
var folderCache_ = {};

function rootFolder_() {
  if (folderCache_['/']) return folderCache_['/'];
  var id = getSettings_().folderId || getProp_(PROP.FOLDER_ID, '');
  var folder;
  if (id) {
    try {
      folder = DriveApp.getFolderById(id);
    } catch (e) {
      throw new Error('BACKUP_FOLDER_ID(' + id + ') 폴더를 열 수 없습니다. 공유 권한(편집자)을 확인하세요: ' + e.message);
    }
  } else {
    var it = DriveApp.getRootFolder().getFoldersByName(CONFIG.ROOT_FOLDER_NAME);
    folder = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.ROOT_FOLDER_NAME);
    props_().setProperty(PROP.FOLDER_ID, folder.getId());
  }
  folderCache_['/'] = folder;
  return folder;
}

function childFolder_(parent, parentKey, name) {
  var key = parentKey + '/' + name;
  if (folderCache_[key]) return folderCache_[key];
  var it = parent.getFoldersByName(name);
  var f = it.hasNext() ? it.next() : parent.createFolder(name);
  folderCache_[key] = f;
  return f;
}

/** ['카테고리','2026','2026-09'] 경로의 폴더를 확보한다. */
function ensureFolderPath_(segments) {
  var folder = rootFolder_();
  var key = '';
  for (var i = 0; i < segments.length; i++) {
    folder = childFolder_(folder, key, segments[i]);
    key += '/' + segments[i];
  }
  return folder;
}

/** @returns {{fileId:string, url:string}} */
function saveEml_(folder, fileName, rawBytes) {
  var blob = Utilities.newBlob(rawBytes, 'message/rfc822', fileName);
  var file = folder.createFile(blob);
  return { fileId: file.getId(), url: file.getUrl() };
}

/**
 * 첨부파일을 <루트>/_attachments/<messageId>/ 에 저장.
 * @returns {{name:string, fileId:string, size:number, mime:string}[]} 저장된 파일 정보 (다운로드 링크용)
 */
function saveAttachments_(messageId, attachments) {
  var files = [];
  if (!attachments || !attachments.length || !getSettings_().saveAttachments) return files;
  var folder = ensureFolderPath_([CONFIG.ATTACHMENT_FOLDER_NAME, messageId]);
  attachments.forEach(function (att, i) {
    var name = att.getName() || ('attachment-' + (i + 1));
    try {
      var f = folder.createFile(att.copyBlob().setName(name));
      files.push({ name: name, fileId: f.getId(), size: f.getSize(), mime: f.getMimeType() });
    } catch (e) {
      Logger.log('첨부 저장 실패 %s/%s: %s', messageId, name, e.message);
    }
  });
  return files;
}

// ---------- 인덱스 시트 ----------

function indexSheet_() {
  var id = getProp_(PROP.INDEX_SHEET_ID, '');
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    var root = rootFolder_();
    var it = root.getFilesByType(MimeType.GOOGLE_SHEETS);
    while (it.hasNext()) {
      var f = it.next();
      if (f.getName() === CONFIG.INDEX_SHEET_NAME) { ss = SpreadsheetApp.openById(f.getId()); break; }
    }
    if (!ss) {
      ss = SpreadsheetApp.create(CONFIG.INDEX_SHEET_NAME);
      DriveApp.getFileById(ss.getId()).moveTo(root);
    }
    props_().setProperty(PROP.INDEX_SHEET_ID, ss.getId());
  }
  var sheet = ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(INDEX_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, INDEX_HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

/** 이미 백업된 메시지 id 집합. */
function loadBackedUpIds_(sheet) {
  var set = {};
  var last = sheet.getLastRow();
  if (last < 2) return set;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0]) set[String(ids[i][0])] = true;
  return set;
}

function appendIndexRows_(sheet, rows) {
  if (!rows.length) return;
  var start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, rows.length, INDEX_HEADERS.length).setValues(rows);
}

/** 인덱스 전체를 레코드 배열로 읽는다 (웹앱 검색용). 본문 미리보기 열은 제외. */
function loadIndexRecords_() {
  var sheet = indexSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, INDEX_LIST_COLUMNS).getValues();
  return values.map(function (row) {
    var rec = rowToRecord(row);
    if (rec.date instanceof Date) rec.date = rec.date.toISOString();
    if (rec.backedUpAt instanceof Date) rec.backedUpAt = rec.backedUpAt.toISOString();
    return rec;
  });
}

/** 메시지 id로 인덱스 레코드 1건(본문 제외)을 읽는다. 없으면 null. */
function loadRecordById_(id) {
  var sheet = indexSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var hit = sheet.getRange(2, 1, last - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!hit) return null;
  var rec = rowToRecord(sheet.getRange(hit.getRow(), 1, 1, INDEX_LIST_COLUMNS).getValues()[0]);
  if (rec.date instanceof Date) rec.date = rec.date.toISOString();
  if (rec.backedUpAt instanceof Date) rec.backedUpAt = rec.backedUpAt.toISOString();
  return rec;
}

/** 메시지 id로 해당 행의 본문 미리보기만 읽는다. */
function loadBodyPreview_(id) {
  var sheet = indexSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return '';
  var hit = sheet.getRange(2, 1, last - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!hit) return '';
  var v = sheet.getRange(hit.getRow(), INDEX_HEADERS.length).getValue();
  return v == null ? '' : String(v);
}
