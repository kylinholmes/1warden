import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http';
import { beginRegistration, finishRegistration, registrationServerUrl } from './registration';

const token = 'header.payload.signature';
const payload = { email: 'person@example.test', emailVerificationToken: token, masterPasswordHash: 'hash',
  key: 'encrypted-user-key', keys: { publicKey: 'public-key', encryptedPrivateKey: 'encrypted-private-key' },
  kdfType: 0 as const, kdfIterations: 600_000, kdfMemory: null, kdfParallelism: null, masterPasswordHint: null };
function http(response: Response) {
  const request = vi.fn().mockResolvedValue(response);
  return { request, client: new HttpClient({ baseUrl: 'https://vault.test/team', fetchImpl: request as typeof fetch }) };
}

describe('Vaultwarden registration', () => {
  it.each([JSON.stringify(token), token])('accepts a registration token without treating it as an account: %s', async body => {
    const { client, request } = http(new Response(body));
    await expect(beginRegistration(client, { email: ' Person@Example.test ', name: ' Person ' }))
      .resolves.toEqual({ kind: 'setPassword', token });
    expect(request.mock.calls[0]?.[0]).toBe('https://vault.test/team/identity/accounts/register/send-verification-email');
    expect(JSON.parse(request.mock.calls[0]?.[1].body)).toEqual({ email: 'person@example.test', name: 'Person' });
  });
  it('treats 204 as email verification, never as successful registration', async () => {
    const { client } = http(new Response(null, { status: 204 }));
    await expect(beginRegistration(client, { email: payload.email, name: '' })).resolves.toEqual({ kind: 'verifyEmail' });
  });
  it.each(['', '{}', '<html>web vault</html>'])('rejects malformed token responses: %s', async body => {
    const { client } = http(new Response(body));
    await expect(beginRegistration(client, { email: payload.email, name: '' })).rejects.toMatchObject({ kind: 'malformedResponse' });
  });
  it('preserves registration denial without turning it into a bad-password error', async () => {
    const { client, request } = http(Response.json({ message: 'Registration not allowed or user already exists' }, { status: 400 }));
    await expect(beginRegistration(client, { email: payload.email, name: '' })).rejects.toThrow('未开放注册或该邮箱已注册');
    expect(request).toHaveBeenCalledOnce();
  });
  it('explains unsupported servers without trying removed register endpoints', async () => {
    const { client, request } = http(new Response(null, { status: 404 }));
    await expect(beginRegistration(client, { email: payload.email, name: '' })).rejects.toThrow('服务器网页');
    expect(request).toHaveBeenCalledOnce();
  });
  it('finishes using the token and encrypted keys, and requires a valid finish response', async () => {
    const { client, request } = http(Response.json({ object: 'registerFinish' }));
    await finishRegistration(client, payload);
    expect(request.mock.calls[0]?.[0]).toBe('https://vault.test/team/identity/accounts/register/finish');
    expect(JSON.parse(request.mock.calls[0]?.[1].body)).toEqual(payload);
    await expect(finishRegistration(http(Response.json({})).client, payload)).rejects.toMatchObject({ kind: 'malformedResponse' });
  });
  it('accepts the official Vaultwarden 1.37.3 finish response', async () => {
    await expect(finishRegistration(http(Response.json({ object: 'register', captchaBypassToken: '' })).client, payload)).resolves.toBeUndefined();
  });
  it('canonicalizes the user-selected server including subpaths', () => {
    expect(registrationServerUrl(' https://VAULT.test/team/ ')).toBe('https://vault.test/team');
  });
  it.each(['https://user:secret@vault.test', 'javascript:alert(1)', 'https://vault.test?token=secret', 'https://vault.test/#/register'])
    ('rejects unsafe or ambiguous server URLs: %s', value => {
      expect(() => registrationServerUrl(value)).toThrow();
    });
});
