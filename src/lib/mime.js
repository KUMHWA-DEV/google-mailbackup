/**
 * .eml(RFC 5322/2045) 파서. 순수 함수 — Apps Script와 Node 양쪽에서 동작.
 * 입력은 "바이너리 문자열"(바이트 1개 = 문자 1개, ISO-8859-1로 읽은 문자열)이고,
 * 문자셋 변환은 호출자가 넘기는 decodeCharset(binaryString, charset) 콜백이 담당한다
 * (Apps Script: Utilities.newBlob(bytes).getDataAsString(charset), Node: Buffer/TextDecoder).
 *
 * parseEml(bin, decodeCharset) → { messageId, date, headers:{from,to,cc,subject}, bodyText, attachments:[{name, mime, data(bin)}] }
 */

function mimeSplitHeaders_(bin) {
  var idx = bin.search(/\r?\n\r?\n/);
  if (idx < 0) return { head: bin, body: '' };
  var sep = bin.match(/\r?\n\r?\n/);
  return { head: bin.slice(0, idx), body: bin.slice(idx + sep[0].length) };
}

/** 헤더 블록 → {name(lower): value} (접힌 줄 펼침, 같은 이름은 마지막 값) */
function mimeParseHeaders_(head) {
  var out = {};
  var lines = head.replace(/\r\n[ \t]+/g, ' ').replace(/\n[ \t]+/g, ' ').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

/** "text/plain; charset=utf-8; name=a.pdf" → { type:'text/plain', params:{charset:'utf-8', name:'a.pdf'} } (RFC 2231 name*=도 기본 처리) */
function mimeParseParams_(value) {
  var parts = String(value || '').split(';');
  var out = { type: parts.shift().trim().toLowerCase(), params: {} };
  var cont = {};
  parts.forEach(function (p) {
    var m = p.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/); if (!m) return;
    var k = m[1].toLowerCase(), v = m[2].replace(/^"(.*)"$/, '$1');
    var star = k.match(/^([^*]+)\*(\d*)\*?$/);
    if (star) { // RFC 2231: name*0*=utf-8''..., name*1*=...
      var base = star[1], n = Number(star[2] || 0);
      if (!cont[base]) cont[base] = [];
      cont[base][n] = v;
    } else out.params[k] = v;
  });
  Object.keys(cont).forEach(function (base) {
    var joined = cont[base].join('');
    var m2 = joined.match(/^([^']*)'[^']*'(.*)$/);
    if (m2) { var cs = m2[1] || 'utf-8', pct = m2[2].replace(/%([0-9A-Fa-f]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); }); out.params[base] = { __charset: cs, __bin: pct }; }
    else out.params[base] = joined;
  });
  return out;
}

function mimeDecodeQP_(s, forHeader) {
  var t = forHeader ? s.replace(/_/g, ' ') : s.replace(/=\r?\n/g, '');
  return t.replace(/=([0-9A-Fa-f]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
}
function mimeDecodeB64_(s) {
  var clean = String(s).replace(/[^A-Za-z0-9+/=]/g, '');
  if (typeof atob === 'function') { try { return atob(clean); } catch (e) { return ''; } }
  if (typeof Buffer !== 'undefined') return Buffer.from(clean, 'base64').toString('latin1');
  if (typeof Utilities !== 'undefined') { var bytes = Utilities.base64Decode(clean); var out = ''; for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] & 255); return out; }
  return '';
}
/** 전송 인코딩 해제 → 바이너리 문자열 */
function mimeDecodeTransfer_(bin, encoding) {
  var e = String(encoding || '').toLowerCase().trim();
  if (e === 'base64') return mimeDecodeB64_(bin);
  if (e === 'quoted-printable') return mimeDecodeQP_(bin, false);
  return bin;
}

/** RFC 2047 encoded-word 디코딩: =?EUC-KR?B?...?= / =?utf-8?Q?...?= */
function mimeDecodeWords_(value, decodeCharset) {
  var s = String(value || '');
  // 인접한 encoded-word 사이 공백은 제거 (RFC 2047 §6.2)
  s = s.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, function (_, cs, enc, text) {
    var bin = enc.toLowerCase() === 'b' ? mimeDecodeB64_(text) : mimeDecodeQP_(text, true);
    try { return decodeCharset(bin, cs.replace(/\*.*$/, '')); } catch (e) { return text; }
  });
}

function mimeParamText_(p, decodeCharset) {
  if (p == null) return '';
  if (typeof p === 'object' && p.__bin != null) { try { return decodeCharset(p.__bin, p.__charset); } catch (e) { return p.__bin; } }
  return mimeDecodeWords_(p, decodeCharset);
}

function mimeStripHtml_(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 파트 하나(헤더+본문 바이너리 문자열)를 재귀 처리해 acc에 본문/첨부를 쌓는다. */
function mimeWalk_(bin, acc, decodeCharset, depth) {
  var sp = mimeSplitHeaders_(bin);
  var h = mimeParseHeaders_(sp.head);
  var ct = mimeParseParams_(h['content-type'] || 'text/plain; charset=us-ascii');
  var cd = mimeParseParams_(h['content-disposition'] || '');
  var enc = h['content-transfer-encoding'] || '7bit';
  if (ct.type.indexOf('multipart/') === 0 && depth < 20) {
    var boundary = ct.params.boundary; if (!boundary) return;
    var parts = sp.body.split('--' + boundary);
    for (var i = 1; i < parts.length; i++) {
      var p = parts[i];
      if (p.indexOf('--') === 0) break; // 끝 표시
      mimeWalk_(p.replace(/^\r?\n/, '').replace(/\r?\n$/, ''), acc, decodeCharset, depth + 1); // 경계 앞 CRLF는 파트 내용이 아님
    }
    return;
  }
  if (ct.type === 'message/rfc822' && depth < 20) { // 첨부된 메일: 첨부로 취급
    var inner = mimeParseHeaders_(mimeSplitHeaders_(sp.body).head);
    acc.attachments.push({ name: (mimeDecodeWords_(inner.subject, decodeCharset) || 'message') + '.eml', mime: 'message/rfc822', data: mimeDecodeTransfer_(sp.body, enc) });
    return;
  }
  var filename = mimeParamText_(cd.params.filename, decodeCharset) || mimeParamText_(ct.params.name, decodeCharset);
  var isAttachment = cd.type === 'attachment' || (!!filename && ct.type.indexOf('text/') !== 0) || (cd.type === 'inline' && !!filename && ct.type.indexOf('text/') !== 0);
  var cid = (h['content-id'] || '').replace(/^<|>$/g, '');
  if (isAttachment) {
    // base64 첨부는 디코딩하지 않고 base64 텍스트로 넘긴다 (Apps Script에서 Utilities.base64Decode가 훨씬 가볍다). 그 외는 바이너리 문자열.
    var isB64 = String(enc).toLowerCase().trim() === 'base64';
    acc.attachments.push({ name: filename || ('attachment-' + (acc.attachments.length + 1)), mime: ct.type || 'application/octet-stream', data: isB64 ? null : mimeDecodeTransfer_(sp.body, enc), dataB64: isB64 ? String(sp.body).replace(/[^A-Za-z0-9+/=]/g, '') : null, inline: cd.type === 'inline' || (!!cid && !filename) });
    return;
  }
  var data = mimeDecodeTransfer_(sp.body, enc);
  if (ct.type === 'text/plain' || ct.type === 'text/html') {
    var text = '';
    try { text = decodeCharset(data, ct.params.charset || 'utf-8'); } catch (e) { text = data; }
    if (ct.type === 'text/plain') { if (!acc.text) acc.text = text; }
    else if (!acc.html) acc.html = text;
    return;
  }
  // 그 밖의 파트(예: 파일명 없는 바이너리)는 첨부로
  if (data && data.length) acc.attachments.push({ name: filename || ('attachment-' + (acc.attachments.length + 1)), mime: ct.type || 'application/octet-stream', data: data, inline: cd.type === 'inline' || !!cid });
}

function mimeParseDate_(v) {
  if (!v) return null;
  var s = String(v).replace(/\(.*?\)/g, '').trim();
  var d = new Date(s);
  if (isNaN(d.getTime())) { var m = s.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Z]{1,4})?/); if (m) d = new Date(m[1] + ' ' + m[2] + ' ' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + (m[6] || '00') + ' ' + (m[7] || 'GMT')); }
  return isNaN(d.getTime()) ? null : d;
}

/**
 * @param {string} bin .eml 전체를 바이너리 문자열로
 * @param {function(string,string):string} decodeCharset (바이너리 문자열, 문자셋) → 유니코드 문자열
 */
function parseEml(bin, decodeCharset) {
  decodeCharset = decodeCharset || function (b) { return b; };
  var sp = mimeSplitHeaders_(bin);
  var h = mimeParseHeaders_(sp.head);
  var acc = { text: '', html: '', attachments: [] };
  mimeWalk_(bin, acc, decodeCharset, 0);
  var body = acc.text || (acc.html ? mimeStripHtml_(acc.html) : '');
  var atts = acc.attachments.filter(function (a) { return !a.inline; });
  return {
    messageId: (h['message-id'] || '').replace(/^<|>$/g, '').trim(),
    date: mimeParseDate_(h['date']),
    headers: { from: mimeDecodeWords_(h['from'], decodeCharset), to: mimeDecodeWords_(h['to'], decodeCharset), cc: mimeDecodeWords_(h['cc'], decodeCharset), subject: mimeDecodeWords_(h['subject'], decodeCharset) },
    bodyText: body,
    attachments: atts,
    // Google Takeout mbox: "Inbox,Important,Category Promotions,라벨명" — 한글 라벨은 =?UTF-8?B?…?= 로 인코딩돼 있으므로 항목별로 푼다
    threadHint: mimeThreadHint_(h),
    gmailLabels: String(h['x-gmail-labels'] || '').split(',').map(function (x) { return mimeDecodeWords_(x.trim(), decodeCharset); }).filter(Boolean).join(','),
  };
}

/**
 * mbox 텍스트(바이너리 문자열)에서 완전한 메시지들의 [start, end) 오프셋을 찾는다.
 * 메시지 경계는 줄 첫머리의 "From " (mbox 표준). 마지막 메시지는 파일 끝(isEnd=true)일 때만 완전한 것으로 본다.
 * @returns {{messages:{start:number,end:number}[], nextOffset:number}} nextOffset = 다음 읽기 시작점(마지막 완전 메시지의 끝)
 */
function mboxScan(bin, isEnd) {
  var starts = [];
  if (bin.indexOf('From ') === 0) starts.push(0);
  var re = /\r?\nFrom /g, m;
  while ((m = re.exec(bin))) starts.push(m.index + m[0].length - 5);
  var messages = [];
  for (var i = 0; i < starts.length; i++) {
    var end = i + 1 < starts.length ? starts[i + 1] : (isEnd ? bin.length : -1);
    if (end < 0) break; // 마지막 조각은 다음 창에서
    messages.push({ start: starts[i], end: end });
  }
  var nextOffset = messages.length ? messages[messages.length - 1].end : (starts.length ? starts[starts.length - 1] : (isEnd ? bin.length : 0));
  return { messages: messages, nextOffset: nextOffset };
}
/** mbox 메시지 하나(“From …” 첫 줄 포함)에서 그 줄을 떼고 ">From " 이스케이프를 되돌린다. */
function mboxUnwrap(chunk) {
  var body = chunk.replace(/^From [^\n]*\r?\n/, '');
  return body.replace(/(^|\r?\n)>(>*From )/g, '$1$2');
}
/** 10진 문자열 → 16진 (2^53 넘는 X-GM-THRID도 정확히). Gmail API의 threadId는 X-GM-THRID의 16진 표기라 백업분과 같은 대화로 묶인다 */
function decToHex(dec) {
  var digits = String(dec || '').replace(/\D/g, '').split('').map(Number); if (!digits.length) return '';
  var hex = '';
  while (digits.length) {
    var rem = 0, next = [];
    for (var i = 0; i < digits.length; i++) { var v = rem * 10 + digits[i]; var q = Math.floor(v / 16); rem = v % 16; if (next.length || q) next.push(q); }
    hex = rem.toString(16) + hex; digits = next;
  }
  return hex;
}
/**
 * 대화 묶음 힌트: 'gm:<hex threadId>' (Takeout의 X-GM-THRID) → 'ref:<대화 첫 Message-ID>' (References/In-Reply-To, 없으면 자기 Message-ID) → ''.
 */
function mimeThreadHint_(h) {
  var thrid = String(h['x-gm-thrid'] || '').trim();
  if (/^\d+$/.test(thrid)) return 'gm:' + decToHex(thrid);
  var refs = String(h['references'] || '').match(/<[^>]+>/g);
  var root = refs && refs.length ? refs[0] : (String(h['in-reply-to'] || '').match(/<[^>]+>/) || [])[0];
  if (!root) root = (String(h['message-id'] || '').match(/<[^>]+>/) || [])[0];
  return root ? 'ref:' + root.replace(/^<|>$/g, '').trim() : '';
}
/**
 * Google Takeout의 X-Gmail-Labels 값 → categorize()에 넣을 labelIds/labelMap.
 * 시스템 라벨(Inbox/Sent/Draft/Category …, 한국어 표기 포함)은 Gmail ID로, 나머지는 사용자 라벨로.
 */
function gmailLabelsToIds(value) {
  var ids = [], map = {};
  var SYS = { 'inbox': 'INBOX', '받은편지함': 'INBOX', 'sent': 'SENT', '보낸편지함': 'SENT', 'draft': 'DRAFT', 'drafts': 'DRAFT', '임시보관함': 'DRAFT', 'spam': 'SPAM', '스팸함': 'SPAM', 'trash': 'TRASH', '휴지통': 'TRASH',
    'important': 'IMPORTANT', '중요': 'IMPORTANT', 'starred': 'STARRED', '별표편지함': 'STARRED', 'unread': 'UNREAD', '읽지않음': 'UNREAD', 'opened': null, '열림': null, 'archived': null, '보관처리됨': null, 'chat': 'CHAT',
    'category promotions': 'CATEGORY_PROMOTIONS', 'category social': 'CATEGORY_SOCIAL', 'category updates': 'CATEGORY_UPDATES', 'category forums': 'CATEGORY_FORUMS', 'category personal': 'CATEGORY_PERSONAL',
    '카테고리 프로모션': 'CATEGORY_PROMOTIONS', '카테고리 소셜': 'CATEGORY_SOCIAL', '카테고리 업데이트': 'CATEGORY_UPDATES', '카테고리 포럼': 'CATEGORY_FORUMS', '카테고리 개인': 'CATEGORY_PERSONAL',
    'category_promotions': 'CATEGORY_PROMOTIONS', 'category_social': 'CATEGORY_SOCIAL', 'category_updates': 'CATEGORY_UPDATES', 'category_forums': 'CATEGORY_FORUMS', 'category_personal': 'CATEGORY_PERSONAL',
    // 한국어 계정의 Takeout 표기 (Gmail 한국어 UI 이름)
    '중요편지함': 'IMPORTANT', '별표': 'STARRED', '읽지 않음': 'UNREAD', '읽음': null, '열어봄': null, '스팸': 'SPAM', '휴지통으로 이동': 'TRASH', '채팅': 'CHAT', '전체보관함': null, '보관메일함': null, '모든 메일': null, '보관됨': null, '보관': null,
    '프로모션 카테고리': 'CATEGORY_PROMOTIONS', '소셜 카테고리': 'CATEGORY_SOCIAL', '업데이트 카테고리': 'CATEGORY_UPDATES', '포럼 카테고리': 'CATEGORY_FORUMS', '개인 카테고리': 'CATEGORY_PERSONAL',
    '프로모션': 'CATEGORY_PROMOTIONS', '소셜': 'CATEGORY_SOCIAL', '업데이트': 'CATEGORY_UPDATES', '포럼': 'CATEGORY_FORUMS', '기본': 'CATEGORY_PERSONAL' };
  var SYS_NOSPACE = {}; Object.keys(SYS).forEach(function (k) { SYS_NOSPACE[k.replace(/\s+/g, '')] = SYS[k]; });
  String(value || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (name) {
    var key = name.toLowerCase(), key2 = key.replace(/\s+/g, '');
    if (key in SYS) { if (SYS[key]) ids.push(SYS[key]); return; }
    if (key2 in SYS_NOSPACE) { if (SYS_NOSPACE[key2]) ids.push(SYS_NOSPACE[key2]); return; }
    var id = 'user:' + name; ids.push(id); map[id] = name;
  });
  return { labelIds: ids, labelMap: map };
}

if (typeof module !== 'undefined') {
  module.exports = { parseEml: parseEml, mboxScan: mboxScan, mboxUnwrap: mboxUnwrap, gmailLabelsToIds: gmailLabelsToIds, decToHex: decToHex, mimeThreadHint_: mimeThreadHint_, mimeParseHeaders_: mimeParseHeaders_, mimeDecodeWords_: mimeDecodeWords_, mimeParseParams_: mimeParseParams_, mimeStripHtml_: mimeStripHtml_ };
}
