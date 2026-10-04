/**
 * 字节 → base64。
 *
 * 单独一个文件而不是塞进 save.ts：这是「二进制过 JSON 边界」那一处的编码，
 * 而它错一位的症状是**文件存出来是坏的**，很难联想到编码。
 * 集中一处，测试也只需钉一处。
 */

/** 分块处理 —— `String.fromCharCode(...bytes)` 在大文件上会撑爆参数列表 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/**
 * base64 → 字节。上面那个的逆向。
 *
 * ⚠️ 别写成 `Uint8Array.from(atob(t), c => c.charCodeAt(0))` 那种「顺手」的写法 ——
 * 它是对的，但和上面分块的理由一样，一次处理几十 KB 的图标没问题、
 * 几百 MB 的附件会卡住主线程。这里保持一次 `atob`（它本身很快）+ 一次循环。
 *
 * 解码失败（不是合法 base64）时 `atob` 会抛 —— **让它抛**。
 * 静默返回空数组的后果是「下载了一个 0 字节的文件」，而用户看到保存成功。
 */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
