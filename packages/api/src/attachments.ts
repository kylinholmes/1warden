/**
 * 附件 —— 取回内容。
 *
 * ## 之前的状态
 *
 * `@1warden/api` 里**只有 DTO 类型、没有任何函数**。所以附件的元数据能同步下来，
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

/** 下载附件的**密文**字节。解密是 @1warden/vault 的事 */
export async function downloadAttachment(
  http: HttpClient, absoluteUrl: string,
): Promise<Uint8Array> {
  const res = await http.requestAbsoluteRaw(absoluteUrl);
  return new Uint8Array(await res.arrayBuffer());
}

/** Vaultwarden v2 creates metadata before accepting a multipart upload. */
export interface AttachmentUploadTicket {
  attachmentId: string;
  url: string;
  /** 0 = direct multipart upload; 1 = Azure (not supported here). */
  fileUploadType: number;
  cipherResponse: unknown;
}

export async function createAttachmentV2(
  http: HttpClient, cipherId: string,
  body: { key: string; fileName: string; fileSize: number; adminRequest?: boolean },
): Promise<AttachmentUploadTicket> {
  return http.request<AttachmentUploadTicket>('POST', `/api/ciphers/${encodeURIComponent(cipherId)}/attachment/v2`,
    { json: { ...body, adminRequest: body.adminRequest ?? false } });
}

export async function deleteAttachment(http: HttpClient, cipherId: string, attachmentId: string): Promise<void> {
  await http.request('DELETE', `/api/ciphers/${encodeURIComponent(cipherId)}/attachment/${encodeURIComponent(attachmentId)}`);
}

/** Explicit bytes work with both browser fetch and the native desktop transport. */
export async function uploadAttachmentBytes(http: HttpClient, uploadUrl: string, encrypted: Uint8Array): Promise<void> {
  const relative = uploadUrl.startsWith('/ciphers/') ? `/api${uploadUrl}` : uploadUrl;
  const url = /^https?:\/\//i.test(relative) ? relative : `${http.baseUrl}${relative}`;
  const target = new URL(url);
  const base = new URL(http.baseUrl);
  if (target.origin !== base.origin || target.username || target.password ||
      !target.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/api/ciphers/`)) {
    throw new Error('附件上传地址不属于当前服务器');
  }
  const boundary = `1warden-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="attachment"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.length + encrypted.length + suffix.length);
  body.set(prefix); body.set(encrypted, prefix.length); body.set(suffix, prefix.length + encrypted.length);
  await http.requestAbsolute('POST', url, { raw: body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
}
