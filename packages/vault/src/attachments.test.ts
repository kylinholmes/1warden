import { describe, it, expect, beforeAll } from 'vitest';
import { makeUserKey, encryptBytes } from '@1warden/crypto';
import type { SymmetricKey } from '@1warden/crypto';
import { unwrapAttachmentKey, decryptAttachmentContent, attachmentBytes } from './attachments';

let key: SymmetricKey;
beforeAll(() => { key = makeUserKey(); });

/** 附件的独立密钥：64 字节（32 enc + 32 mac），布局与用户密钥一致 */
function makeAttachmentKey(): SymmetricKey {
  return makeUserKey();
}

/**
 * ⚠️ 附件的密钥**不是用户密钥**，而是每条附件自己的一把，
 * 被用户密钥（或条目密钥）包装后存在 `attachments[].key` 里。
 *
 * 用错的表现：解密出来是一堆乱码，而文件确实下载到了 ——
 * 用户看到的是「附件坏了」，我们会去查网络。
 */
describe('unwrapAttachmentKey', () => {
  it('unwraps a 64-byte key from its EncString', async () => {
    const attKey = makeAttachmentKey();
    // ⚠️ 按**字节**包装，和用户密钥一样 —— 不是把它转成 base64 再当字符串加密。
    // 后者解出来是那串 base64 的 UTF-8 文本（88 字节 ≠ 64），
    // 下面的长度检查会把它拦下来（这条测试最早就是那么红的）
    const wrapped = await encryptBytes(new Uint8Array([...attKey.encKey, ...attKey.macKey]), key);
    const got = await unwrapAttachmentKey(wrapped, key);
    expect(got).not.toBeNull();
    expect([...got!.encKey]).toEqual([...attKey.encKey]);
    expect([...got!.macKey]).toEqual([...attKey.macKey]);
  });

  /** 没有 key 字段的附件（老数据）不该让整条条目炸掉 */
  it('returns null when there is no key at all', async () => {
    expect(await unwrapAttachmentKey(null, key)).toBeNull();
  });

  it('returns null when the key cannot be decrypted', async () => {
    expect(await unwrapAttachmentKey('2.坏的|坏的|坏的', key)).toBeNull();
  });

  /** 长度不对说明数据被改过或版本不兼容 —— 拿它去解密只会得到乱码 */
  it('returns null for a key of the wrong length', async () => {
    const short = await encryptBytes(new Uint8Array(32), key);
    expect(await unwrapAttachmentKey(short, key)).toBeNull();
  });
});

describe('decryptAttachmentContent', () => {
  it('decrypts bytes encrypted with the attachment key', async () => {
    const attKey = makeAttachmentKey();
    const original = new TextEncoder().encode('附件的内容，可以是任意二进制');
    const encrypted = await encryptBytes(original, attKey);

    const got = await decryptAttachmentContent(encrypted, attKey);
    expect(new TextDecoder().decode(got)).toBe('附件的内容，可以是任意二进制');
  });

  /** 附件可以是任意二进制 —— 图片、压缩包，不能假定它是文本 */
  it('handles arbitrary binary, not just text', async () => {
    const attKey = makeAttachmentKey();
    const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x00]);
    const got = await decryptAttachmentContent(await encryptBytes(original, attKey), attKey);
    expect([...got]).toEqual([...original]);
  });

  it('handles an empty attachment', async () => {
    const attKey = makeAttachmentKey();
    const got = await decryptAttachmentContent(await encryptBytes(new Uint8Array(0), attKey), attKey);
    expect(got).toHaveLength(0);
  });

  /** 用错密钥要抛错，而不是返回一段看似成功的乱码 */
  it('throws when the wrong key is used', async () => {
    const encrypted = await encryptBytes(new TextEncoder().encode('secret'), makeAttachmentKey());
    await expect(decryptAttachmentContent(encrypted, makeAttachmentKey())).rejects.toThrow();
  });

  /** ⚠️ 被改过一个字节的内容必须被发现 —— MAC 就是干这个的 */
  it('rejects tampered content', async () => {
    const attKey = makeAttachmentKey();
    const encrypted = await encryptBytes(new TextEncoder().encode('secret'), attKey);
    const tampered = encrypted.slice(0, -1) + String.fromCharCode((encrypted.charCodeAt(encrypted.length - 1) ^ 0xff));
    await expect(decryptAttachmentContent(tampered, attKey)).rejects.toThrow();
  });
});

/**
 * ⚠️ `size` 是**字符串**，而且是**加密后**的大小，不是文件的真实大小。
 * 拿它当进度条的分母会算出大于 100% 的进度。
 */
describe('attachmentBytes', () => {
  it('parses the size string', () => {
    expect(attachmentBytes({ size: '12345' })).toBe(12345);
  });

  it('returns null for a size that is not a number', () => {
    expect(attachmentBytes({ size: 'unknown' })).toBeNull();
  });

  it('returns null for an empty size', () => {
    expect(attachmentBytes({ size: '' })).toBeNull();
  });
});
