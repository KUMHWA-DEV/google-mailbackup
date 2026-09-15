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
    // 이름이 같은 기존 폴더를 가져다 쓰지 않는다 (동명의 다른 폴더나 남이 공유한 폴더에 백업이 섞이지 않게). 항상 새로 만들고 ID를 기억.
    folder = DriveApp.createFolder(CONFIG.ROOT_FOLDER_NAME);
    props_().setProperty(PROP.FOLDER_ID, folder.getId());
  }
  folderCache_['/'] = folder;
  return folder;
}

/** 루트 폴더의 경로 문자열 ("내 드라이브 › Mail Backup"). 사용자 속성에 캐시. */
function rootFolderPath_() {
  var id = getSettings_().folderId || getProp_(PROP.FOLDER_ID, '');
  if (!id) return '내 드라이브 › ' + CONFIG.ROOT_FOLDER_NAME + ' (첫 백업 때 생성)';
  var cached = getProp_('FOLDER_PATH_' + id, '');
  if (cached) return cached;
  try {
    var folder = DriveApp.getFolderById(id), names = [folder.getName()], guard = 0;
    var parents = folder.getParents();
    while (parents.hasNext() && guard++ < 10) { var p = parents.next(); names.unshift(p.getName()); parents = p.getParents(); }
    if (names[0] !== '내 드라이브' && names[0] !== 'My Drive') names.unshift('공유됨');
    else names[0] = '내 드라이브';
    var path = names.join(' › ');
    props_().setProperty('FOLDER_PATH_' + id, path);
    return path;
  } catch (e) { return CONFIG.ROOT_FOLDER_NAME; }
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
 * 첨부파일을 <루트>/_attachments/<YYYY-MM>/<messageId>_<파일명> 으로 저장.
 * (메일마다 폴더를 만들면 수천 개 폴더가 생기고 폴더 조회가 느려지므로 월별 폴더 하나에 파일명 접두어로 구분)
 * @returns {{name:string, fileId:string, size:number, mime:string}[]} 저장된 파일 정보 (다운로드 링크용)
 */
function saveAttachments_(messageId, attachments, date, folderName) {
  var files = [];
  if (!attachments || !attachments.length || !getSettings_().saveAttachments) return files;
  var month = Utilities.formatDate(date instanceof Date && !isNaN(date.getTime()) ? date : new Date(), CONFIG.TIME_ZONE, 'yyyy-MM');
  var folder = ensureFolderPath_([folderName || CONFIG.ATTACHMENT_FOLDER_NAME, month]);
  attachments.forEach(function (att, i) {
    var name = att.getName() || ('attachment-' + (i + 1));
    try {
      var f = folder.createFile(att.copyBlob().setName(messageId + '_' + name));
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
    // 기억된 ID가 없으면 새로 만든다 (이름이 같은 다른 시트를 가져다 쓰면 남의 인덱스로 중복 판정을 할 수 있음)
    var root = rootFolder_();
    ss = SpreadsheetApp.create(CONFIG.INDEX_SHEET_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(root);
    props_().setProperty(PROP.INDEX_SHEET_ID, ss.getId());
  }
  var sheet = ss.getSheets()[0];
  initIndexSheet_(sheet);
  return sheet;
}
function initIndexSheet_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(INDEX_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, INDEX_HEADERS.length).setFontWeight('bold');
  }
}
/** 가져오기(.eml 마이그레이션) 전용 시트. 백업과 다른 실행이 동시에 써도 겹치지 않게 시트를 분리한다. */
var IMPORT_SHEET_NAME = 'Import';
function importSheet_() {
  var main = indexSheet_();
  var ss = main.getParent();
  var sheet = ss.getSheetByName(IMPORT_SHEET_NAME) || ss.insertSheet(IMPORT_SHEET_NAME);
  initIndexSheet_(sheet);
  return sheet;
}
/** 읽기용: 메인 + Import 시트 (Import 시트는 있을 때만) */
function indexSheets_() {
  var main = indexSheet_();
  var imp = main.getParent().getSheetByName(IMPORT_SHEET_NAME);
  return imp ? [main, imp] : [main];
}
/** id 접두어로 시트를 고른다 ('eml:' → Import) */
function sheetForId_(id) {
  if (String(id).indexOf('eml:') === 0) { var imp = indexSheet_().getParent().getSheetByName(IMPORT_SHEET_NAME); return imp || indexSheet_(); }
  return indexSheet_();
}

/** 이미 백업된 메시지 id 집합. */
function loadBackedUpIds_() {
  var set = {};
  indexSheets_().forEach(function (sheet) {
    var last = sheet.getLastRow();
    if (last < 2) return;
    var vals = sheet.getRange(2, 1, last - 1, 2).getValues(); // A: id, B: threadId 또는 가져온 원본 'src:<fileId>'
    for (var i = 0; i < vals.length; i++) {
      if (vals[i][0]) set[String(vals[i][0])] = true;
      if (vals[i][1] && String(vals[i][1]).indexOf('src:') === 0) set[String(vals[i][1])] = true;
    }
  });
  return set;
}

function appendIndexRows_(sheet, rows) {
  if (!rows.length) return;
  var start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, rows.length, INDEX_HEADERS.length).setValues(rows);
}

/** 인덱스 전체를 레코드 배열로 읽는다 (웹앱 검색용). 본문 미리보기 열은 제외. */
function loadIndexRecords_() {
  var values = [];
  indexSheets_().forEach(function (sheet) {
    var last = sheet.getLastRow();
    if (last < 2) return;
    values = values.concat(sheet.getRange(2, 1, last - 1, INDEX_LIST_COLUMNS).getValues());
  });
  values = values.filter(function (row) { return String(row[0] || '').indexOf('emldup:') !== 0; }); // 가져오기 중복 표시 행은 메일이 아님
  return values.map(function (row) {
    var rec = rowToRecord(row);
    if (rec.date instanceof Date) rec.date = rec.date.toISOString();
    if (rec.backedUpAt instanceof Date) rec.backedUpAt = rec.backedUpAt.toISOString();
    return rec;
  });
}

/** 메시지 id로 인덱스 레코드 1건(본문 제외)을 읽는다. 없으면 null. */
function loadRecordById_(id) {
  var sheet = sheetForId_(id);
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
  var sheet = sheetForId_(id);
  var last = sheet.getLastRow();
  if (last < 2) return '';
  var hit = sheet.getRange(2, 1, last - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!hit) return '';
  var v = sheet.getRange(hit.getRow(), INDEX_HEADERS.length).getValue();
  return v == null ? '' : String(v);
}
