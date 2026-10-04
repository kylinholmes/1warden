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
