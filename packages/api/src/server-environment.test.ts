import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http';
import { serverEnvironment } from './server-environment';
import { uploadAttachmentBytes } from './attachments';

describe('server environments', () => {
  it.each(['https://vault.bitwarden.com:443', 'https://VAULT.BITWARDEN.COM/', 'https://vault.bitwarden.com/team/..'])('classifies normalized cloud roots consistently: %s', serverUrl => {
    expect(serverEnvironment(serverUrl).cloudRegion).toBe('US');
  });
  it.each(['com', 'eu'])('routes Bitwarden %s API and identity requests to the official region', async region => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}));
    const http = new HttpClient({ baseUrl: `https://vault.bitwarden.${region}/`, fetchImpl });
    await http.request('GET', '/api/config');
    await http.request('GET', '/api/sync?excludeDomains=true');
    await http.request('POST', '/identity/connect/token');
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `https://api.bitwarden.${region}/config`, `https://api.bitwarden.${region}/sync?excludeDomains=true`,
      `https://identity.bitwarden.${region}/connect/token`,
    ]);
    expect(serverEnvironment(http.baseUrl).notifications).toBe(`https://notifications.bitwarden.${region}`);
  });

  it.each(['https://vault.example.com/team/', 'https://vault.vaultwarden.com',
    'https://vault.bitwarden.com.evil.test', 'https://vault.bitwarden.com/self-hosted',
    'http://vault.bitwarden.com', 'https://vault.bitwarden.com:8443',
    'https://person@vault.bitwarden.com', 'https://vault.bitwarden.com?redirect=1'])
  ('keeps a non-cloud server on its own configured paths: %s', async baseUrl => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}));
    const http = new HttpClient({ baseUrl, fetchImpl });
    await http.request('GET', '/api/config');
    await http.request('POST', '/identity/accounts/prelogin');
    const base = baseUrl.replace(/\/+$/, '');
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([`${base}/api/config`, `${base}/identity/accounts/prelogin`]);
    expect(serverEnvironment(baseUrl).cloudRegion).toBeNull();
  });

  it('allows direct attachment uploads only to the selected API origin and cipher route', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const http = new HttpClient({ baseUrl: 'https://vault.bitwarden.eu', fetchImpl, headers: () => ({ Authorization: 'Bearer fixture' }) });
    await uploadAttachmentBytes(http, '/ciphers/item/attachment/att', new Uint8Array([1]));
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://api.bitwarden.eu/ciphers/item/attachment/att');
    expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get('Authorization')).toBe('Bearer fixture');
    for (const url of ['https://api.bitwarden.com/ciphers/item/attachment/att',
      'https://api.bitwarden.eu.evil.test/ciphers/item/attachment/att', 'https://api.bitwarden.eu/other']) {
      await expect(uploadAttachmentBytes(http, url, new Uint8Array([1]))).rejects.toThrow('附件上传地址不属于当前服务器');
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
