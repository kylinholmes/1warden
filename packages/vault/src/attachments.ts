/**
 * 附件的取回 —— 密钥解包与内容解密。
 *
 * ## 之前的状态
 *
 * `attachments` 在模型里有、元数据（文件名、大小、URL）也会被解密，
 * 但**没有任何界面渲染它**，也**没有任何代码能把内容取回来**。
 * 用户从别处导入一个带附件的库，那些附件在服务端躺着、
 * 在我们的界面上连「存在」都看不出来。
 *
 * ## 两层密钥，别搞混
 *
 * 附件的密钥**不是用户密钥**，而是每条附件自己的一把 64 字节密钥
 * （32 enc + 32 mac，布局与用户密钥一致）。它被用户密钥（或条目密钥）
 * **包装**后存在 `attachments[].key` 里。
 *
 * ⚠️ 这里**没有**「解出来是乱码」那种失败模式：EncString 是
 * AES-CBC + HMAC，密钥不对时 MAC 校验不过、**直接抛错**。
 * 乱码才是更危险的情况（用户会把一个坏文件存下来并以为它是好的），
 * 我们不会走到那一步。
 *
 * 真正会静默出错的是**包装方式**：那把 64 字节的密钥必须按**字节**加密
 * （`encryptBytes`），不是转成 base64 再当字符串加密 —— 后者解出来是
 * 那串 base64 的 UTF-8 文本（88 字节），长度就不对。
 * 好在下面的长度检查会拦住它。
 */
import { decryptBytes, decryptString, DecryptError } from '@1warden/crypto';
import type { SymmetricKey } from '@1warden/crypto';

/** 附件密钥的长度：32 字节 enc + 32 字节 mac */
const ATTACHMENT_KEY_BYTES = 64;

/**
 * 把 `attachments[].key` 解成一把可用的对称密钥。
 *
 * 解不开时返回 null 而不是抛 —— 一条附件坏了不该让整条条目打不开。
 * 调用方据此提示「这个附件读不了」，其余的照常。
 */
export async function unwrapAttachmentKey(
  keyField: string | null | undefined, wrappingKey: SymmetricKey,
): Promise<SymmetricKey | null> {
  if (typeof keyField !== 'string' || keyField.length === 0) return null;

  let raw: Uint8Array;
  try {
    raw = await decryptBytes(keyField, wrappingKey);
  } catch (e) {
    if (e instanceof DecryptError) return null;
    throw e;
  }

  // 长度不对说明数据被改过或版本不兼容 —— 拿它去解密只会得到乱码，
  // 而乱码看起来像「文件损坏」
  if (raw.length !== ATTACHMENT_KEY_BYTES) return null;

  return { encKey: raw.slice(0, 32), macKey: raw.slice(32, 64) };
}

/**
 * 解密附件内容。
 *
 * ⚠️ 附件是**任意二进制**（图片、压缩包、PDF），不能按文本处理。
 * 解密失败（用错密钥、内容被改）时**抛错**，不返回一段看似成功的乱码 ——
 * 那会让用户把一个坏文件存下来，而且以为它是好的。
 */
export async function decryptAttachmentContent(
  encrypted: Uint8Array | string, key: SymmetricKey,
): Promise<Uint8Array> {
  const encString = typeof encrypted === 'string'
    ? encrypted
    : new TextDecoder().decode(encrypted);
  return decryptBytes(encString, key);
}

/**
 * `attachments[].size` 是**字符串**，而且是**加密后**的大小。
 *
 * ⚠️ 拿它当进度条的分母会算出大于 100% 的进度 —— 加密有填充，
 * 密文总比明文长。只能当个粗略的量级用。
 */
export function attachmentBytes(a: { size: string }): number | null {
  const n = Number.parseInt(a.size, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 供解密元数据时复用 */
export { decryptString };
