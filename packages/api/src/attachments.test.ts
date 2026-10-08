import { describe, it, expect } from 'vitest';
import { HttpClient } from './http';
import { uploadAttachmentBytes, downloadAttachment } from './attachments';
describe('attachment transport', () => {
  it('sends Vaultwarden direct uploads as binary multipart at the API route', async () => {
    let body!: Uint8Array; let headers!: Headers;
    const http = new HttpClient({ baseUrl: 'https://vault.test', headers: () => ({ Authorization: 'Bearer secret' }), fetchImpl: async (url, init) => {
      expect(String(url)).toBe('https://vault.test/api/ciphers/item/attachment/att');
      headers = new Headers(init?.headers); body = init?.body as Uint8Array;
      return new Response(null, { status: 204 });
    } });
    await uploadAttachmentBytes(http, '/ciphers/item/attachment/att', new Uint8Array([0, 255, 128]));
    expect(headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
    const form = await new Response(body as unknown as BodyInit, { headers }).formData();
    expect(new Uint8Array(await (form.get('data') as File).arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
  });
  it('rejects direct upload URLs outside the vault origin before sending auth', async () => {
    const http = new HttpClient({ baseUrl: 'https://vault.test', fetchImpl: async () => { throw new Error('should never request'); } });
    await expect(uploadAttachmentBytes(http, 'https://evil.test/upload', new Uint8Array([1]))).rejects.toThrow(/地址|origin|服务器/);
  });
  it('downloads signed URLs without leaking vault Authorization', async () => {
    const http = new HttpClient({ baseUrl: 'https://vault.test', headers: () => ({ Authorization: 'Bearer secret' }), fetchImpl: async (_url, init) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return new Response(new Uint8Array([1]));
    } });
    expect(await downloadAttachment(http, 'https://storage.test/signed')).toEqual(new Uint8Array([1]));
  });
});
