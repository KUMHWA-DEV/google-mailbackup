/**
 * 큰 mbox / 압축 mbox(.gz) / zip 안의 mbox·eml 을 스트리밍으로 읽는 순수 로직. Apps Script와 Node 공용.
 *
 * 입력은 "바이트 구간 읽기" 함수 readRange(start, endInclusive) → Uint8Array 이고, 압축 해제는 전역 pako(Inflate)를 쓴다.
 * 출력은 메시지 단위 콜백. 실행 시간 제한이 있으므로 콜백이 'stop'을 돌려주면 그 자리(압축 해제 출력 기준 오프셋)를 반환해
 * 다음 구간이 그 오프셋부터 이어간다 (압축 파일은 처음부터 다시 풀되 그 오프셋 전까지는 건너뜀).
 */

/** 바이너리 문자열 ↔ Uint8Array */
function u8ToBin(u8) {
  var out = '', CH = 8192;
  for (var i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
  return out;
}

/**
 * mbox 스트림에서 메시지를 잘라 콜백으로 넘긴다.
 * @param {{
 *   size:number, readRange:function(number,number):Uint8Array, chunkBytes?:number,
 *   decode:'none'|'gzip'|'deflate-raw', dataStart?:number, dataEnd?:number,   // zip 엔트리면 dataStart/dataEnd(exclusive) 구간만 읽음
 *   startOffset:number,                        // 압축 해제 출력 기준으로 이 오프셋 이전 메시지는 건너뜀 (이어서 실행)
 *   onMessage:function(string, number):(string|void), // (메시지 원문, 출력 오프셋) → 'stop' 이면 중단
 *   maxMessageBytes?:number, log?:function
 * }} o
 * @returns {{offset:number, done:boolean, stopped:boolean}} offset = 다음에 이어갈 출력 오프셋
 */
function streamMbox(o) {
  var CH = o.chunkBytes || 4 * 1024 * 1024, MAXM = o.maxMessageBytes || 40 * 1024 * 1024;
  var start = o.dataStart || 0, end = o.dataEnd != null ? o.dataEnd : o.size;
  var pos = start;                 // 압축 파일 내 다음 읽기 위치
  var outPos = 0;                  // 압축 해제 출력의 절대 오프셋 (buf[0]에 해당)
  var buf = '';                    // 아직 경계를 못 찾은 출력 (바이너리 문자열)
  var stopped = false, finished = false;
  var inflate = null, inflOpts = o.decode === 'deflate-raw' ? { raw: true } : {};
  var skipTo = o.startOffset || 0;
  // 이어서 실행: 스냅샷이 있으면 압축 입력 위치·출력 오프셋·미완성 버퍼·압축 해제기 상태를 그대로 복원 (처음부터 다시 풀지 않음)
  var snap = o.resume && o.resume.inputPos != null ? o.resume : null;
  if (snap) { pos = snap.inputPos; outPos = snap.outPos || 0; buf = snap.buf || ''; skipTo = 0; }
  if (o.decode === 'gzip' || o.decode === 'deflate-raw') {
    inflate = snap && snap.inflate && o.codec ? restoreInflate(snap.inflate, inflOpts, o.codec) : new pako.Inflate(inflOpts);
    inflate.onData = function (chunk) { feed(u8ToBin(chunk)); };
  }

  function feed(bin) {
    if (stopped) { buf += bin; return; } // 중단 뒤에 압축 해제기가 마저 뱉는 출력은 버리지 말고 스냅샷 버퍼에 남긴다
    // 이어서 실행: 이미 처리한 출력은 버린다
    if (outPos + bin.length <= skipTo) { outPos += bin.length; return; }
    if (outPos < skipTo) { bin = bin.slice(skipTo - outPos); outPos = skipTo; }
    buf += bin;
    drain(false);
  }
  function drain(isEnd) {
    if (stopped) return;
    var r = mboxScan(buf, isEnd);
    for (var i = 0; i < r.messages.length; i++) {
      var m = r.messages[i];
      var res = o.onMessage(buf.slice(m.start, m.end), outPos + m.start);
      if (res === 'stop') { stopped = true; buf = buf.slice(m.end); outPos += m.end; return; }
    }
    if (r.messages.length) { buf = buf.slice(r.nextOffset); outPos += r.nextOffset; }
    if (buf.length > MAXM) { // 한 통이 너무 큼: 다음 "From " 경계까지 버린다
      if (o.log) o.log('메일 한 통이 ' + Math.round(MAXM / 1048576) + 'MB를 넘어 건너뜁니다');
      var nx = buf.indexOf('\nFrom ', 5);
      if (nx > 0) { buf = buf.slice(nx + 1); outPos += nx + 1; } else { outPos += buf.length; buf = ''; }
    }
  }

  while (pos < end && !stopped) {
    var e = Math.min(end, pos + CH) - 1;
    var bytes = o.readRange(pos, e);
    pos = e + 1;
    var last = pos >= end;
    if (inflate) {
      inflate.push(bytes, last);
      if (inflate.err) throw new Error('압축 해제 실패: ' + (inflate.msg || inflate.err));
    } else feed(u8ToBin(bytes));
  }
  if (!stopped) { finished = true; drain(true); }
  var out = { offset: outPos + (stopped ? 0 : buf.length), done: finished && !stopped, stopped: stopped };
  if (stopped && o.codec) out.snapshot = { inputPos: pos, outPos: outPos, buf: buf, inflate: inflate ? snapshotInflate(inflate, o.codec) : null };
  return out;
}

// ---------- 압축 해제기 상태 저장/복원 (GB급 파일을 구간마다 처음부터 다시 풀지 않기 위해) ----------
/** pako Inflate의 내부 상태(zlib inflate state)를 JSON 가능한 객체로. 형식화 배열은 codec.enc로 base64. */
function snapshotInflate(inflate, codec) {
  var TYPES = { Uint8Array: 'u8', Uint16Array: 'u16', Int32Array: 'i32', Uint32Array: 'u32', Int16Array: 'i16' };
  function walk(v, depth) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'function') return undefined;
    var tn = v.constructor && v.constructor.name;
    if (TYPES[tn]) return { __t: TYPES[tn], b: codec.enc(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (Array.isArray(v)) return v.map(function (x) { return walk(x, depth + 1); });
    if (depth > 6) return undefined;
    var o = {}; Object.keys(v).forEach(function (k) { var w = walk(v[k], depth + 1); if (w !== undefined) o[k] = w; }); return o;
  }
  var st = inflate.strm;
  return { state: walk(st.state, 0), strm: { total_in: st.total_in, total_out: st.total_out, adler: st.adler, data_type: st.data_type, msg: st.msg } };
}
/** snapshot → 새 Inflate 인스턴스에 상태를 되살린다 */
function restoreInflate(snapshot, opts, codec) {
  var CTOR = { u8: Uint8Array, u16: Uint16Array, i32: Int32Array, u32: Uint32Array, i16: Int16Array };
  function revive(v, target) {
    if (v && typeof v === 'object' && v.__t) { var u8 = codec.dec(v.b); return new CTOR[v.__t](u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)); }
    if (Array.isArray(v)) return v.map(function (x) { return revive(x); });
    if (v && typeof v === 'object') { var o = target && typeof target === 'object' && !Array.isArray(target) ? target : {}; Object.keys(v).forEach(function (k) { o[k] = revive(v[k], o[k]); }); return o; }
    return v;
  }
  var inflate = new pako.Inflate(opts || {});
  revive(snapshot.state, inflate.strm.state);
  var st = inflate.strm; st.total_in = snapshot.strm.total_in; st.total_out = snapshot.strm.total_out; st.adler = snapshot.strm.adler; st.data_type = snapshot.strm.data_type; st.msg = snapshot.strm.msg;
  // 코드 테이블 별칭 복원: 동적 블록에서는 lencode/distcode가 lendyn/distdyn을 가리킨다
  var s = inflate.strm.state;
  if (s.lendyn && s.lencode && s.lencode.length === s.lendyn.length && s.lencode !== s.lendyn) { var same = true; for (var i = 0; i < 64 && i < s.lencode.length; i++) if (s.lencode[i] !== s.lendyn[i]) { same = false; break; } if (same) s.lencode = s.lendyn; }
  if (s.distdyn && s.distcode && s.distcode.length === s.distdyn.length && s.distcode !== s.distdyn) { var same2 = true; for (var j = 0; j < 64 && j < s.distcode.length; j++) if (s.distcode[j] !== s.distdyn[j]) { same2 = false; break; } if (same2) s.distcode = s.distdyn; }
  return inflate;
}

// ---------- zip ----------
function le32_(u, i) { return (u[i] | (u[i + 1] << 8) | (u[i + 2] << 16)) + u[i + 3] * 16777216; }
function le16_(u, i) { return u[i] | (u[i + 1] << 8); }
/**
 * zip의 중앙 디렉터리를 읽어 엔트리 목록을 돌려준다 (zip64 미지원 → 4GB 이하).
 * @returns {{name:string, method:number, compSize:number, size:number, localOffset:number}[]}
 */
function listZipEntries(readRange, size) {
  var tailLen = Math.min(size, 66000);
  var tail = readRange(size - tailLen, size - 1);
  var eocd = -1;
  for (var i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip 형식이 아니거나 손상됐습니다 (EOCD 없음)');
  var count = le16_(tail, eocd + 10), cdSize = le32_(tail, eocd + 12), cdOffset = le32_(tail, eocd + 16);
  if (cdOffset === 0xFFFFFFFF || count === 0xFFFF) throw new Error('4GB가 넘는 zip(zip64)은 지원하지 않습니다. 나눠서 압축하거나 풀어서 넣어 주세요');
  var cd = readRange(cdOffset, cdOffset + cdSize - 1);
  var entries = [], p = 0;
  while (p + 46 <= cd.length && le32_(cd, p) === 0x02014b50) {
    var method = le16_(cd, p + 10), compSize = le32_(cd, p + 20), usize = le32_(cd, p + 24);
    var nLen = le16_(cd, p + 28), xLen = le16_(cd, p + 30), cLen = le16_(cd, p + 32), local = le32_(cd, p + 42);
    var name = u8ToBin(cd.subarray(p + 46, p + 46 + nLen));
    try { name = decodeURIComponent(escape(name)); } catch (e) { /* 원문 유지 */ }
    entries.push({ name: name, method: method, compSize: compSize, size: usize, localOffset: local });
    p += 46 + nLen + xLen + cLen;
  }
  return entries;
}
/** 로컬 헤더를 읽어 실제 데이터 시작 오프셋을 구한다 */
function zipDataStart(readRange, entry) {
  var h = readRange(entry.localOffset, entry.localOffset + 29);
  if (le32_(h, 0) !== 0x04034b50) throw new Error('zip 로컬 헤더 오류: ' + entry.name);
  return entry.localOffset + 30 + le16_(h, 26) + le16_(h, 28);
}

if (typeof module !== 'undefined') {
  module.exports = { streamMbox: streamMbox, listZipEntries: listZipEntries, zipDataStart: zipDataStart, u8ToBin: u8ToBin, snapshotInflate: snapshotInflate, restoreInflate: restoreInflate };
}
