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

/**
 * 建一条附件并拿到上传地址（v2 流程）。
 *
 * ## 为什么用 v2 而不是老的 `/attachment`
 *
 * 老端点要求 **multipart/form-data** —— 我们要自己拼 boundary、处理转义，
 * 而轮子底下还得让传输层支持二进制体。v2 是「先登记、拿一个地址、
 * 再把加密后的字节直接 POST 上去」，全程没有 multipart。
 *
 * ## 字段都是密文
 *
 * `fileName` 与 `key` 都是 EncString（`key` 是把附件自己的密钥包装后的密文）。
 * `fileSize` 给的是**加密后**的字节数。
 */
export interface AttachmentUploadTicket {
  attachmentId: string;
  /** 往这里 POST 加密后的字节 */
  url: string;
  /** 0 = 直传到 url；其它值是云存储的分支，Vaultwarden 只用 0 */
  fileUploadType: number;
  cipherResponse: unknown;
}

export async function createAttachmentV2(
  http: HttpClient, cipherId: string,
  body: { key: string; fileName: string; fileSize: number; adminRequest?: boolean },
): Promise<AttachmentUploadTicket> {
  return http.request<AttachmentUploadTicket>(
    'POST', `/api/ciphers/${cipherId}/attachment/v2`,
    { json: { ...body, adminRequest: body.adminRequest ?? false } },
  );
}

/**
 * 把**加密后的**字节 POST 到登记时给的地址。
 *
 * ⚠️ 这里发的必须是原始字节。走 `HttpClient` 的常规路径会把它拼成
 * `{baseUrl}{绝对网址}` 的废地址，而且请求体是二进制 ——
 * 那条路会经 UTF-8 解码把字节改掉（见 transport.ts 的 `bodyPartsOf`）。
 */
export async function uploadAttachmentBytes(
  http: HttpClient, absoluteUrl: string, encrypted: Uint8Array,
): Promise<void> {
  await http.requestAbsolute('POST', absoluteUrl, { raw: encrypted });
}
