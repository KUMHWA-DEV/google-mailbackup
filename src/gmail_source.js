/**
 * Gmail 고급 서비스 어댑터. 목록 조회, raw 메시지, 라벨 맵.
 */

/** labelId -> 사용자 라벨 이름. 시스템 라벨은 제외. */
function fetchLabelMap_() {
  var res = Gmail.Users.Labels.list('me');
  var map = {};
  (res.labels || []).forEach(function (l) {
    if (l.type === 'user') map[l.id] = l.name;
  });
  return map;
}

/** @returns {{ids:string[], nextPageToken:string|undefined}} */
function listMessageIds_(query, pageToken) {
  var params = { q: query, maxResults: CONFIG.PAGE_SIZE };
  if (pageToken) params.pageToken = pageToken;
  var res = Gmail.Users.Messages.list('me', params);
  return {
    ids: (res.messages || []).map(function (m) { return m.id; }),
    nextPageToken: res.nextPageToken,
  };
}

/** 미리보기용 가벼운 메타데이터 (라벨, 크기, 날짜, 보낸사람). */
function fetchMessageMeta_(id) {
  var api = Gmail.Users.Messages.get('me', id, { format: 'metadata', metadataHeaders: ['From'] });
  var headers = headersFromPayload(api.payload);
  return {
    id: api.id, labelIds: api.labelIds || [], sizeBytes: api.sizeEstimate || 0,
    date: api.internalDate ? new Date(Number(api.internalDate)).toISOString() : '',
    from: headers.from || '',
  };
}

/**
 * 메시지 1건의 백업에 필요한 모든 정보.
 * raw는 Gmail API(정확한 원본 바이트), 헤더/본문/첨부는 GmailApp(디코딩된 값).
 */
function fetchMessage_(id) {
  var t0 = Date.now();
  var api = Gmail.Users.Messages.get('me', id, { format: 'raw' });
  tick_('api', t0); t0 = Date.now();
  var rawBytes = decodeRawBytes_(api.raw);
  // 아주 큰 메일(원문 15MB 초과)은 첨부·본문을 따로 풀지 않는다: 메모리에 사본이 3~4개 생겨 실행이 죽는 것보다 원문(.eml)만이라도 확실히 남기는 쪽이 낫다.
  if (rawBytes && Number(api.sizeEstimate) > LARGE_MESSAGE_BYTES) {
    var hdr = headersFromRaw_(rawBytes);
    tick_('gmailapp', t0);
    return { id: api.id, threadId: api.threadId, labelIds: api.labelIds || [], snippet: api.snippet || '', sizeEstimate: api.sizeEstimate,
      date: new Date(Number(api.internalDate)), headers: hdr, bodyPreview: api.snippet || '', rawBytes: rawBytes, attachments: [], large: true };
  }
  var msg = GmailApp.getMessageById(id);
  if (!rawBytes) rawBytes = Utilities.newBlob(msg.getRawContent(), 'message/rfc822').getBytes(); // API raw를 못 풀면 GmailApp 원문으로
  var date = msg.getDate();
  if (!(date instanceof Date) || isNaN(date.getTime())) date = new Date(Number(api.internalDate));

  // 첨부 목록은 항상 읽고(이름 기록용), 별도 저장 여부는 drive_store에서 설정으로 판단한다.
  var attachments = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });

  var bodyPreview = '';
  try { bodyPreview = msg.getPlainBody() || ''; } catch (e) { bodyPreview = api.snippet || ''; }
  tick_('gmailapp', t0);

  return {
    id: api.id,
    threadId: api.threadId,
    labelIds: api.labelIds || [],
    snippet: api.snippet || '',
    sizeEstimate: api.sizeEstimate || rawBytes.length,
    date: date,
    headers: {
      from: msg.getFrom(), to: msg.getTo(), cc: msg.getCc(), subject: msg.getSubject(),
    },
    bodyPreview: bodyPreview,
    rawBytes: rawBytes,
    attachments: attachments,
  };
}

var LARGE_MESSAGE_BYTES = 15 * 1024 * 1024;
/** 원문 앞부분(헤더 블록)에서 From/To/Cc/Subject만 뽑는다. 큰 메일용 최소 파싱 (encoded-word는 디코딩하지 않음). */
function headersFromRaw_(bytes) {
  var head = '';
  try { head = Utilities.newBlob(bytes.slice(0, 64 * 1024)).getDataAsString('UTF-8'); } catch (e) { head = ''; }
  head = head.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  var get = function (n) { var m = head.match(new RegExp('^' + n + ':[ \\t]*(.*)$', 'im')); return m ? m[1].trim() : ''; };
  return { from: get('From'), to: get('To'), cc: get('Cc'), subject: get('Subject') };
}

/**
 * Gmail API의 raw(base64url)를 바이트로. 일부 메시지는 base64DecodeWebSafe가 "문자열을 디코딩할 수 없습니다"를 던지므로
 * 표준 base64로 바꾸고 패딩을 채워 다시 시도한다. 그래도 안 되면 null.
 */
function decodeRawBytes_(raw) {
  if (!raw) return null;
  try { return Utilities.base64DecodeWebSafe(raw); } catch (e) { /* 아래에서 재시도 */ }
  var std = String(raw).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (std.length % 4) std += '=';
  try { return Utilities.base64Decode(std); } catch (e2) { return null; }
}
