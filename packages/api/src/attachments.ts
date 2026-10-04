/**
 * 附件 —— 取回内容。
 *
 * ## 之前的状态
 *
 * `@coffer/api` 里**只有 DTO 类型、没有任何函数**。所以附件的元数据能同步下来，
 * 内容却一条都取不回来 —— 用户从别处导入一个带附件的库，
 * 那些附件在服务端躺着，在我们的界面上连「存在」都看不出来。
 *
 * ## 两处容易踩的
 *
 * 1. **存下来的 `url` 会过期。** 它由请求的 `Host` 头推导、每次 sync 重新生成。
 *    官方客户端的策略是：先调这里要一个新的，404 时回退到存下来的那个。
 * 2. **下载地址是绝对 URL、在 web 根路径下**（`{host}/attachments/…`），
 *    不在 `/api` 下。用拼 baseUrl 的请求会得到一个废地址。
 */
import type { HttpClient } from './http';
import type { CipherAttachmentDto } from './types';

/**
 * 要一个新的下载地址。
 *
 * 返回的 `url` 是**绝对 URL**，自带 token —— 下载时不需要 Authorization 头。
 */
export async function refreshAttachmentUrl(
  http: HttpClient, cipherId: string, attachmentId: string,
): Promise<CipherAttachmentDto> {
  return http.request<CipherAttachmentDto>(
    'GET', `/api/ciphers/${cipherId}/attachment/${attachmentId}`,
  );
}

/** 下载附件的**密文**字节。解密是 @coffer/vault 的事 */
export async function downloadAttachment(
  http: HttpClient, absoluteUrl: string,
): Promise<Uint8Array> {
  const res = await http.requestAbsoluteRaw(absoluteUrl);
  return new Uint8Array(await res.arrayBuffer());
}
