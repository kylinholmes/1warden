/**
 * WebAuthn 的「线格式」翻译 —— MAIN world 与 background 之间那层。
 *
 * ## 为什么单独一个模块
 *
 * 这些函数原本长在 `webauthn-inject.ts` 里面。那份代码是 IIFE、只在页面里跑，
 * 于是它们**没法测** —— 只能靠跑一遍端到端、看症状来猜。而其中
 * `serializeAllow` 是 passkey 登录路径上唯一的一处 ID 翻译，
 * 页面又几乎总是会指定 `allowCredentials`：这里错一位，passkey 就等于不可用。
 *
 * 纯逻辑没有理由不可测。抽出来之后，往返、padding、byteOffset、
 * 各种输入类型都能在 node 里直接钉住。
 *
 * ⚠️ 这个模块会被打进 MAIN world 的 IIFE，所以**只能依赖标准 Web API**
 * （`atob` / `btoa` / `TextEncoder`），不能 import 任何包。
 */

/** 页面在 `allowCredentials` 里列出的一个凭据 */
export interface AllowDescriptor {
  id: string;
  type: string;
  transports?: string[];
}

/**
 * 字节 → base64url（**不带 padding**）。
 *
 * 不带 padding 是本项目内部的统一约定：`@coffer/crypto` 的 `toBase64Url`
 * 与存储里的 `credentialId` 都是这个形式。带了 padding 就对不上。
 */
export function b64urlFromBytes(v: ArrayBuffer | ArrayBufferView): string {
  const bytes = v instanceof Uint8Array
    ? v
    : ArrayBuffer.isView(v)
      ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
      : new Uint8Array(v);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url → 字节。
 *
 * ⚠️ **`atob` 要求长度是 4 的倍数**，而 32 字节编出来是 43 个字符
 * （43 % 4 = 3）—— 我们的 `credentialId` 正好是这个长度。
 * 不补 `=` 的话 `atob` 会抛 `InvalidCharacterError`，
 * 而那是在页面里抛的，看起来像「网站自己的脚本坏了」。
 */
export function bytesFromB64url(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = p.padEnd(Math.ceil(p.length / 4) * 4, '=');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 页面可能拿什么来当凭据 ID。
 *
 * 规范说是 `BufferSource`，实际见过三种：`ArrayBuffer`、`Uint8Array`、
 * 以及普通数字数组。全部收下 —— 拒绝一种的后果是那个站点**永远登不上**，
 * 而用户完全无从判断为什么。
 */
export function asBytes(v: unknown): Uint8Array | null {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  // ⚠️ 视图可能只是某个大 buffer 的一段，必须尊重 byteOffset
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v) && v.every((n) => typeof n === 'number')) return new Uint8Array(v as number[]);
  return null;
}

/**
 * `allowCredentials` → 可过 `postMessage` 的形状。
 *
 * 返回 `null` 表示**页面没有限定**（没有这个字段）；返回 `[]` 表示
 * 页面**显式地谁都不允许**。这两者在匹配层含义相反 —— 把空数组当成
 * 「没有限制」，页面用一个 `[]` 就能拿到我们全部的凭据。
 */
export function serializeAllow(list: unknown): AllowDescriptor[] | null {
  if (!Array.isArray(list)) return null;
  const out: AllowDescriptor[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; type?: unknown; transports?: unknown };
    const raw = asBytes(e.id);
    // 认不出来的条目跳过，而不是让它把整次调用带崩 ——
    // 登录不该因为一条坏数据全废
    if (raw === null) continue;
    const d: AllowDescriptor = {
      id: b64urlFromBytes(raw),
      type: typeof e.type === 'string' ? e.type : 'public-key',
    };
    if (Array.isArray(e.transports)) d.transports = e.transports.map(String);
    out.push(d);
  }
  return out;
}
