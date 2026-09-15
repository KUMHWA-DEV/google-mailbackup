import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import vm from 'node:vm';

// 전역 pako (Apps Script처럼 전역 스크립트로 로드) + mbox 스캔 함수들
beforeAll(() => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../src/vendor_pako.js', import.meta.url), 'utf8'), ctx);
  globalThis.pako = ctx.pako;
  const mime = require('../src/lib/mime.js');
  globalThis.mboxScan = mime.mboxScan;
});
const { streamMbox, listZipEntries, zipDataStart } = require('../src/lib/mboxstream.js');

const msg = (n) => 'From a@example.com Mon Jul  1 09:00:00 2024\nFrom: a@example.com\nSubject: m' + n + '\nMessage-ID: <m' + n + '@x>\n\nbody ' + n + ' ' + 'z'.repeat(300) + '\n';
const mboxText = Array.from({ length: 300 }, (_, i) => msg(i + 1)).join('');
const reader = (buf) => (s, e) => new Uint8Array(buf.subarray(s, e + 1));

describe('streamMbox', () => {
  it('splits a plain mbox read in small windows', () => {
    const buf = Buffer.from(mboxText, 'latin1');
    const seen = [];
    const r = streamMbox({ size: buf.length, readRange: reader(buf), chunkBytes: 1000, decode: 'none', startOffset: 0, onMessage: (m) => { seen.push(m); } });
    expect(r.done).toBe(true);
    expect(seen.length).toBe(300);
    expect(seen[0]).toBe(msg(1));
    expect(seen[299]).toBe(msg(300));
  });
  it('resumes from an offset after a stop, also through gzip', () => {
    const buf = Buffer.from(mboxText, 'latin1');
    const gz = zlib.gzipSync(buf);
    const first = [];
    const r1 = streamMbox({ size: gz.length, readRange: reader(gz), chunkBytes: 512, decode: 'gzip', startOffset: 0, onMessage: (m, off) => { first.push([m, off]); if (first.length === 120) return 'stop'; } });
    expect(r1.stopped).toBe(true);
    expect(first.length).toBe(120);
    expect(first[119][0]).toBe(msg(120));
    const second = [];
    const r2 = streamMbox({ size: gz.length, readRange: reader(gz), chunkBytes: 4096, decode: 'gzip', startOffset: r1.offset, onMessage: (m) => { second.push(m); } });
    expect(r2.done).toBe(true);
    expect(second.length).toBe(180);
    expect(second[0]).toBe(msg(121));
    expect(second[179]).toBe(msg(300));
  });
  it('reads deflated entries out of a zip', () => {
    // 최소 zip 작성: [local header + data] × 2, central directory, EOCD
    const entries = [{ name: 'a.mbox', data: Buffer.from(msg(1) + msg(2), 'latin1'), method: 8 }, { name: 'b.eml', data: Buffer.from('From: q@x\nSubject: single\n\nhi\n', 'latin1'), method: 0 }];
    const parts = [], cds = []; let off = 0;
    const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }, u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    for (const e of entries) {
      const comp = e.method === 8 ? zlib.deflateRawSync(e.data) : e.data; const name = Buffer.from(e.name);
      const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(e.method), u16(0), u16(0), u32(0), u32(comp.length), u32(e.data.length), u16(name.length), u16(0), name, comp]);
      cds.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(e.method), u16(0), u16(0), u32(0), u32(comp.length), u32(e.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), name]));
      parts.push(local); off += local.length;
    }
    const cd = Buffer.concat(cds);
    const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(off), u16(0)]);
    const zip = Buffer.concat([...parts, cd, eocd]);
    const rr = reader(zip);
    const list = listZipEntries(rr, zip.length);
    expect(list.map(e => e.name)).toEqual(['a.mbox', 'b.eml']);
    const ds = zipDataStart(rr, list[0]);
    const got = [];
    const r = streamMbox({ size: zip.length, readRange: rr, chunkBytes: 64, decode: 'deflate-raw', dataStart: ds, dataEnd: ds + list[0].compSize, startOffset: 0, onMessage: (m) => { got.push(m); } });
    expect(r.done).toBe(true);
    expect(got).toEqual([msg(1), msg(2)]);
    const ds2 = zipDataStart(rr, list[1]);
    expect(Buffer.from(zip.subarray(ds2, ds2 + list[1].compSize)).toString('latin1')).toBe(entries[1].data.toString('latin1'));
  });
});
