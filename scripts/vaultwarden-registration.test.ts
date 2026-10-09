import { describe, expect, it, vi } from 'vitest';
import { localVaultwardenUrl, RegistrationRejected, submitLocalRegistration, type RegistrationPayload } from './vaultwarden-registration';

const payload: RegistrationPayload = {
  email: 'synthetic@example.invalid', name: 'Synthetic fixture', masterPasswordHash: 'opaque-hash',
  key: 'opaque-key', keys: { publicKey: 'public-key', encryptedPrivateKey: 'opaque-private-key' },
  kdfType: 0, kdfIterations: 600_000, kdfMemory: null, kdfParallelism: null,
};
const token = 'header.payload.signature';

describe('local Vaultwarden registration contract', () => {
  it.each(['http://127.0.0.1:18083/', 'https://localhost:8443/', 'http://[::1]:8080/'])('allows explicit loopback targets: %s', value => {
    expect(localVaultwardenUrl(value)).toBe(value.slice(0, -1));
  });
  it.each(['https://vault.example.com', 'http://localhost.example.com', 'file:///tmp/vault',
    'http://name:password@localhost', 'http://localhost?target=remote', 'http://localhost#token'])('rejects unsafe targets before a request: %s', async value => {
    const request = vi.fn();
    await expect(submitLocalRegistration(value, payload, request as typeof fetch)).rejects.toThrow(/loopback URL/);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([JSON.stringify(token), token])('finishes registration with a validated token representation: %s', async response => {
    const request = vi.fn().mockResolvedValueOnce(new Response(response)).mockResolvedValueOnce(Response.json({ object: 'registerFinish' }));
    await submitLocalRegistration('http://127.0.0.1:18083', payload, request as typeof fetch);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe('http://127.0.0.1:18083/identity/accounts/register/send-verification-email');
    expect(JSON.parse(request.mock.calls[0]?.[1].body)).toEqual({ email: payload.email, name: payload.name });
    expect(request.mock.calls[1]?.[0]).toBe('http://127.0.0.1:18083/identity/accounts/register/finish');
    expect(JSON.parse(request.mock.calls[1]?.[1].body)).toMatchObject({ ...payload, emailVerificationToken: token });
    expect(request.mock.calls.every(([, init]) => init.redirect === 'error' && init.signal instanceof AbortSignal)).toBe(true);
  });
  it('reports verification mail instead of treating an empty success as registration', async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(submitLocalRegistration('http://localhost', payload, request as typeof fetch)).rejects.toThrow(/SIGNUPS_VERIFY=false/);
    expect(request).toHaveBeenCalledOnce();
  });
  it.each(['', '{}', 'null', JSON.stringify({ token }), '<html>not the API</html>'])('rejects malformed successful responses: %s', async response => {
    const request = vi.fn().mockResolvedValue(new Response(response));
    await expect(submitLocalRegistration('http://localhost', payload, request as typeof fetch)).rejects.toThrow(/no usable registration token/);
    expect(request).toHaveBeenCalledOnce();
  });
  it('does not fall back to a removed endpoint or log an error body', async () => {
    const request = vi.fn().mockResolvedValue(new Response('secret-response', { status: 404 }));
    const result = submitLocalRegistration('http://localhost', payload, request as typeof fetch);
    await expect(result).rejects.toMatchObject({ phase: 'verification', status: 404 });
    await expect(result).rejects.not.toThrow('secret-response');
    expect(request).toHaveBeenCalledOnce();
  });
  it('does not quietly accept duplicate, forbidden, or other finish errors', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json(token)).mockResolvedValueOnce(new Response('private server detail', { status: 400 }));
    const result = submitLocalRegistration('http://localhost', payload, request as typeof fetch);
    await expect(result).rejects.toBeInstanceOf(RegistrationRejected);
    await expect(result).rejects.toMatchObject({ phase: 'finish', status: 400 });
  });
});
