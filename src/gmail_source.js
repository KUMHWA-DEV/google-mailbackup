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

/**
 * 메시지 1건의 백업에 필요한 모든 정보.
 * raw는 Gmail API(정확한 원본 바이트), 헤더/첨부는 GmailApp(디코딩된 값).
 */
function fetchMessage_(id) {
  var api = Gmail.Users.Messages.get('me', id, { format: 'raw' });
  var rawBytes = Utilities.base64DecodeWebSafe(api.raw);
  var msg = GmailApp.getMessageById(id);
  var date = msg.getDate();
  if (!(date instanceof Date) || isNaN(date.getTime())) date = new Date(Number(api.internalDate));

  var attachments = saveAttachmentsEnabled_()
    ? msg.getAttachments({ includeInlineImages: false, includeAttachments: true })
    : [];

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
    rawBytes: rawBytes,
    attachments: attachments,
  };
}
