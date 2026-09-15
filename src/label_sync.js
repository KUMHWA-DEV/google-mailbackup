/**
 * 라벨 변경 따라가기: 이미 백업된 메일의 Gmail 라벨이 바뀌면(라벨 추가·제거, 보관, 받은편지함 복귀 …) 인덱스의 라벨·카테고리를 갱신하고
 * 파일을 새 카테고리 폴더로 옮긴다. Gmail 변경 이력(History API)으로 바뀐 메일만 골라내므로 전체를 다시 훑지 않는다.
 *
 * - 첫 실행은 기준점(historyId)만 잡는다. 그 뒤 실행마다 기준점 이후의 라벨 변경만 처리하고 기준점을 올린다.
 * - 변경 이력은 Gmail 이 약 일주일만 보관하므로, 만료(404)되면 기준점을 다시 잡고 그 사이 변경은 건너뛴다.
 * - 시간이 모자라면 남은 메일 ID 를 저장해 두고 다음 백업 때 이어서 처리한다.
 * - 가져오기(.eml/.mbox)로 들어온 메일은 Gmail 메시지 ID 가 없어 대상이 아니다.
 */
var LABEL_SYNC_PROP = { HISTORY_ID: 'GMAIL_HISTORY_ID', STATE: 'LABEL_SYNC_STATE_JSON' };

function labelSyncState_() { try { return JSON.parse(getProp_(LABEL_SYNC_PROP.STATE, '') || 'null') || null; } catch (e) { return null; } }
function saveLabelSyncState_(st) { if (st) props_().setProperty(LABEL_SYNC_PROP.STATE, JSON.stringify(st)); else props_().deleteProperty(LABEL_SYNC_PROP.STATE); }

/**
 * @param {number} deadline 이 시각까지만
 * @param {Object} settings
 * @returns {{checked:number, changed:number, moved:number, pending:number, note:string}}
 */
function syncLabels_(deadline, settings) {
  var out = { checked: 0, changed: 0, moved: 0, pending: 0, note: '' };
  var baseline = getProp_(LABEL_SYNC_PROP.HISTORY_ID, '');
  var st = labelSyncState_();
  if (!baseline) { // 첫 실행: 기준점만
    try { props_().setProperty(LABEL_SYNC_PROP.HISTORY_ID, String(Gmail.Users.getProfile('me').historyId)); out.note = '기준점 설정'; } catch (e) { out.note = '기준점 설정 실패: ' + e.message; }
    return out;
  }
  // 1. 지난번에 못 끝낸 목록이 있으면 그것부터, 없으면 변경 이력에서 새로 수집
  var ids, newBaseline;
  if (st && st.ids && st.ids.length) { ids = st.ids; newBaseline = st.newBaseline || baseline; }
  else {
    var col = collectChangedIds_(baseline);
    if (col.expired) { // 이력 만료: 기준점 재설정
      try { props_().setProperty(LABEL_SYNC_PROP.HISTORY_ID, String(Gmail.Users.getProfile('me').historyId)); } catch (e2) { /* 무시 */ }
      out.note = '변경 이력이 만료돼 기준점을 다시 잡음 (그 사이 라벨 변경은 반영 안 됨)';
      return out;
    }
    ids = col.ids; newBaseline = col.historyId || baseline;
    if (!ids.length) { props_().setProperty(LABEL_SYNC_PROP.HISTORY_ID, String(newBaseline)); return out; }
  }
  // 2. 인덱스에 있는 메일만
  var sheet = indexSheet_(), last = sheet.getLastRow();
  var rowOf = {}; if (last >= 2) { var idCol = sheet.getRange(2, 1, last - 1, 1).getValues(); for (var i = 0; i < idCol.length; i++) if (idCol[i][0]) rowOf[String(idCol[i][0])] = i + 2; }
  var labelMap = fetchLabelMap_();
  var C = { category: INDEX_HEADERS.indexOf('category') + 1, labels: INDEX_HEADERS.indexOf('labels') + 1, date: INDEX_HEADERS.indexOf('date') + 1, fileId: INDEX_HEADERS.indexOf('driveFileId') + 1 };
  var remaining = [];
  for (var k = 0; k < ids.length; k++) {
    var id = ids[k];
    if (Date.now() > deadline) { remaining = ids.slice(k); break; }
    var row = rowOf[id]; if (!row) continue;
    out.checked += 1;
    try {
      var m = Gmail.Users.Messages.get('me', id, { format: 'minimal' });
      var labelIds = m.labelIds || [];
      var category = categorize(labelIds, labelMap, { splitGmailTabs: settings.splitGmailTabs }), names = labelNamesOf(labelIds, labelMap).join(', ');
      var cur = sheet.getRange(row, C.category, 1, C.labels - C.category + 1).getValues()[0];
      var oldCat = String(cur[0] || ''), oldLabels = String(cur[C.labels - C.category] || '');
      if (oldCat === category && oldLabels === names) continue;
      sheet.getRange(row, C.category).setValue(sheetSafeCell(category));
      sheet.getRange(row, C.labels).setValue(sheetSafeCell(names));
      out.changed += 1;
      if (oldCat !== category) {
        var fileId = String(sheet.getRange(row, C.fileId).getValue() || ''), date = sheet.getRange(row, C.date).getValue();
        if (fileId) { try { moveImportedFile_(fileId, category, date, settings); out.moved += 1; } catch (e3) { Logger.log('라벨 동기화: 파일 이동 실패 %s: %s', id, e3.message); } }
      }
    } catch (e4) {
      if (/not found|404/i.test(String(e4.message || e4))) continue; // Gmail 에서 지워진 메일: 백업은 그대로 둔다
      Logger.log('라벨 동기화 실패 %s: %s', id, e4.message);
    }
  }
  if (remaining.length) { saveLabelSyncState_({ ids: remaining, newBaseline: newBaseline }); out.pending = remaining.length; out.note = '시간이 모자라 ' + remaining.length + '건은 다음 백업 때 이어서'; }
  else { saveLabelSyncState_(null); props_().setProperty(LABEL_SYNC_PROP.HISTORY_ID, String(newBaseline)); }
  return out;
}

/** 기준점 이후 라벨이 바뀐 메시지 ID 들 (중복 제거) */
function collectChangedIds_(startHistoryId) {
  var ids = {}, order = [], token = null, historyId = null, pages = 0;
  try {
    do {
      var params = { startHistoryId: startHistoryId, historyTypes: ['labelAdded', 'labelRemoved'], maxResults: 500 };
      if (token) params.pageToken = token;
      var res = Gmail.Users.History.list('me', params);
      historyId = res.historyId || historyId;
      (res.history || []).forEach(function (h) {
        [].concat(h.labelsAdded || [], h.labelsRemoved || []).forEach(function (x) { var id = x.message && x.message.id; if (id && !ids[id]) { ids[id] = true; order.push(id); } });
      });
      token = res.nextPageToken; pages += 1;
    } while (token && pages < 40);
  } catch (e) {
    if (/404|not found|historyId/i.test(String(e.message || e))) return { expired: true, ids: [], historyId: null };
    throw e;
  }
  return { expired: false, ids: order, historyId: historyId };
}
