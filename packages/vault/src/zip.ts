/**
 * 最小的 ZIP 读取 —— 只做「按中央目录找到条目并解压」这一件事。
 *
 * ## 为什么自己写
 *
 * 1Password 现在的导出格式（1PUX）就是一个 ZIP。要支持它就得能解 ZIP，
 * 而为一个「读几个条目」的需求引一个通用压缩库，连带的是解码器、
 * 流式 API、加密、多卷……一大堆这里用不上、却都要跟着升级的东西。
 *
 * 而导入是**一次性且不可重来**的操作：读错了用户就得重新导出、重新导入。
 * 自己写能把每个字节钉住 —— 下面每一个分支都有对应的测试。
 *
 * ## 只认两种压缩方式
 *
 * 0 = 原样存储，8 = deflate。别的（bzip2、lzma、加密…）**明确报错**，
 * 而不是尽量猜 —— 猜错的产物是「导入成功但内容是乱码」，
 * 那比直接失败糟得多。
 *
 * ⚠️ 刻意**不校验 CRC32**：ZIP 的 CRC 是给传输纠错用的，
 * 我们读的是本地文件，而校验它会引入一张查表、一个循环和一处可能出错的判断。
 * deflate 本身有自己的校验和，真损坏会在解压时炸出来。
 */
import { concatBytes } from '@coffer/crypto';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** EOCD 最小 22 字节；后面还可能跟最多 65535 字节的注释 */
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

function findEocd(view: DataView): number {
  const len = view.byteLength;
  const from = Math.max(0, len - EOCD_MIN - MAX_COMMENT);
  // 从后往前找 —— 注释里可能也出现这个签名，取**最后**一个才是真的 EOCD
  for (let i = len - EOCD_MIN; i >= from; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  // ⚠️ TS 5.7 起 `Uint8Array` 带 buffer 类型参数，裸的是 `<ArrayBufferLike>`，
  // 而流 API 要 `<ArrayBuffer>`。仓库的约定是就地断言（见 @coffer/crypto 的 bytes.ts）
  void writer.write(data as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/**
 * 读出 ZIP 里的所有条目。
 *
 * @throws 当这不是一个 ZIP、或里面有本模块不认识的压缩方式时
 */
export async function readZip(input: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);

  // 太短的话连 EOCD 都放不下，先拦掉再谈别的
  if (input.byteLength < EOCD_MIN) throw new Error('这不是一个 ZIP 文件（太短）');

  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('这不是一个 ZIP 文件（找不到中央目录结尾标记）');

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset >= input.byteLength) throw new Error('这不是一个 ZIP 文件（中央目录位置无效）');

  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let at = cdOffset;

  for (let n = 0; n < count; n++) {
    if (at + 46 > input.byteLength) throw new Error('ZIP 的中央目录不完整（文件被截断了？）');
    if (view.getUint32(at, true) !== SIG_CENTRAL) throw new Error('ZIP 的中央目录项签名不对（文件损坏？）');

    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);

    const name = decoder.decode(input.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    // 目录项（以 / 结尾）
    if (name.endsWith('/')) continue;

    if (localOffset + 30 > input.byteLength) throw new Error('ZIP 的本地文件头越界（文件损坏？）');
    if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error('ZIP 的本地文件头签名不对（文件损坏？）');

    // ⚠️ 用**中央目录**里的长度，不用本地头里的。写了「数据描述符」的文件
    // （流式写出的 ZIP 常见）本地头里的这三个字段是 0，按它读会得到空内容。
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataAt = localOffset + 30 + localNameLen + localExtraLen;
    if (dataAt + compressedSize > input.byteLength) {
      throw new Error('ZIP 的条目数据越界（文件被截断了？）');
    }
    const raw = input.subarray(dataAt, dataAt + compressedSize);

    if (method === METHOD_STORE) {
      // 切一份出来 —— 不改动入参，调用方还能拿原字节做别的事
      out.set(name, new Uint8Array(raw));
    } else if (method === METHOD_DEFLATE) {
      out.set(name, await inflateRaw(raw));
    } else {
      throw new Error(`ZIP 里的「${name}」用了不支持的压缩方式（${method}）—— 请换一种导出方式`);
    }
  }

  return out;
}

/** 读出一个 ZIP 里的文本条目。找不到时返回 null */
export async function readZipText(zip: Uint8Array, name: string): Promise<string | null> {
  const files = await readZip(zip);
  const data = files.get(name);
  return data === undefined ? null : new TextDecoder().decode(data);
}

/** 保留：导出给需要自行拼接多个条目的调用方 */
export { concatBytes };
