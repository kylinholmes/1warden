import { describe, it, expect } from 'vitest';
import { readZip } from './zip';

/**
 * 造一个最小的 ZIP。
 *
 * ⚠️ **刻意不引第三方库**：需要的只是「按中央目录找到条目、解压」这一件事，
 * 而导入是**一次性且不可重来**的操作 —— 读错了用户就得重新导出。
 * 自己写能把每个字节都钉住（下面这些用例就是这么来的）。
 */
async function makeZip(
  entries: { name: string; data: Uint8Array; deflate: boolean }[],
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = encoder.encode(e.name);
    const raw = e.data;

    let body = raw;
    let method = 0;
    if (e.deflate) {
      method = 8;
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      void writer.write(raw as BufferSource);
      void writer.close();
      body = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    }

    // 本地文件头
    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);         // version needed
    lv.setUint16(6, 0, true);          // flags
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);         // time
    lv.setUint16(12, 0, true);         // date
    lv.setUint32(14, 0, true);         // crc32 —— 我们不校验它，见 zip.ts 的说明
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(body, 30 + nameBytes.length);

    parts.push(local);

    // 中央目录项
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, 0, true);         // crc32
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);    // 本地头的偏移
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, eocd];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('readZip', () => {
  it('reads a stored (uncompressed) entry', async () => {
    const zip = await makeZip([{ name: 'export.data', data: bytes('{"hello":1}'), deflate: false }]);
    const files = await readZip(zip);
    expect(new TextDecoder().decode(files.get('export.data'))).toBe('{"hello":1}');
  });

  /** 1PUX 里的 export.data 是**压缩**的，不处理 deflate 就等于读不了 */
  it('reads a deflated entry', async () => {
    const big = 'x'.repeat(5000);
    const zip = await makeZip([{ name: 'export.data', data: bytes(big), deflate: true }]);
    const files = await readZip(zip);
    expect(new TextDecoder().decode(files.get('export.data'))).toBe(big);
  });

  it('reads several entries and keeps their names', async () => {
    const zip = await makeZip([
      { name: 'export.data', data: bytes('A'), deflate: true },
      { name: 'export.attributes', data: bytes('B'), deflate: false },
      { name: 'files/1.png', data: bytes('C'), deflate: true },
    ]);
    const files = await readZip(zip);
    expect([...files.keys()].sort()).toEqual(['export.attributes', 'export.data', 'files/1.png']);
    expect(new TextDecoder().decode(files.get('files/1.png'))).toBe('C');
  });

  it('handles an empty entry', async () => {
    const zip = await makeZip([{ name: 'empty', data: new Uint8Array(0), deflate: false }]);
    expect((await readZip(zip)).get('empty')).toEqual(new Uint8Array(0));
  });

  it('handles a non-ASCII entry name', async () => {
    const zip = await makeZip([{ name: 'files/中文名.txt', data: bytes('X'), deflate: false }]);
    expect(new TextDecoder().decode((await readZip(zip)).get('files/中文名.txt'))).toBe('X');
  });

  /** ⚠️ 报错要能看出「选错了文件」，而不是一句「解析失败」 */
  it('rejects something that is not a ZIP at all', async () => {
    await expect(readZip(bytes('这不是一个 ZIP 文件'))).rejects.toThrow(/ZIP/i);
  });

  it('rejects a truncated ZIP instead of returning half the entries', async () => {
    const zip = await makeZip([{ name: 'a', data: bytes('hello'), deflate: false }]);
    await expect(readZip(zip.slice(0, 20))).rejects.toThrow(/ZIP/i);
  });
});
