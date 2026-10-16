// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.test/login"}
import { beforeEach, describe, expect, it } from 'vitest';
import { CredentialObserver } from './credential-observer';
import type { CredentialRequest } from './credential-protocol';

beforeEach(() => {
  document.body.innerHTML = '<form><input id="u" autocomplete="username" value="alice"><input id="p" type="password" value="password"><button>Log in</button></form>';
  Object.defineProperty(HTMLElement.prototype, 'getClientRects', { configurable: true, value() { return [{}]; } });
});
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const event = (type: string, target: Element, isTrusted = true, key = '') => ({ type, target, isTrusted, key });
const setup = () => {
  const messages: CredentialRequest[] = [];
  let unlocked = true;
  const observer = new CredentialObserver(document, async request => {
    messages.push(request);
    return request.type === '1warden:credential-document' ? { unlocked, token: unlocked ? 'token' : null, notices: [] } : { ok: true };
  });
  return { observer, messages, lock: () => { unlocked = false; } };
};
describe('early credential observer', () => {
  it('does not treat a trusted submit event as proof of a user gesture', async () => {
    const { observer, messages } = setup(); await observer.refresh();
    // Chromium marks script-triggered requestSubmit() events trusted.
    await observer.handle(event('submit', document.querySelector('form')!, true));
    expect(messages).toHaveLength(1);
  });
  it('revokes previously described generation targets when the unlocked grant clears', async () => {
    const { observer } = setup(); await observer.refresh();
    const target = await observer.bridge.describe(1); expect(target).not.toBeNull();
    observer.clear();
    const result = await observer.bridge.fill(1, 'generated-secret', true, { formId: target!.formId, targetId: target!.targetId, token: 'token' });
    expect(result.ok).toBe(false); expect(field('p').value).toBe('password');
  });
  it('rejects a pre-lock generate click even if a new document grant arrives while describe is pending', async () => {
    const { observer, messages } = setup(); await observer.refresh();
    const original = observer.bridge.describe;
    const target = await original(1);
    let resolve!: (value: typeof target) => void;
    observer.bridge.describe = () => new Promise(done => { resolve = done; });
    const pending = observer.generate(1, { length: 20, digits: true, symbols: true }, true);
    observer.clear(); await observer.refresh(); resolve(target);
    expect((await pending).error).toBeTruthy();
    expect(messages.filter(message => message.type === '1warden:credential-generate')).toHaveLength(0);
  });
  it('requires handshake and real user provenance and never sends values per keystroke', async () => {
    const { observer, messages } = setup();
    await observer.handle(event('input', field('p')));
    expect(messages).toHaveLength(0);
    await observer.refresh();
    await observer.handle(event('input', field('p'), false));
    await observer.handle(event('change', field('p'), false));
    await observer.handle(event('submit', document.querySelector('form')!, false));
    expect(messages).toHaveLength(1);
    await observer.handle(event('input', field('p')));
    expect(messages).toHaveLength(1);
    await observer.handle(event('change', field('p')));
    expect(messages[1]).toMatchObject({ type: '1warden:credential-capture', token: 'token', input: { password: 'password', username: 'alice', submitted: false } });
  });
  it('snapshots trusted submit clicks and Enter before a site clears values, and confirms recent scripted submits', async () => {
    const { observer, messages } = setup(); await observer.refresh();
    await observer.handle(event('click', document.querySelector('button')!));
    field('p').value = '';
    await observer.handle(event('submit', document.querySelector('form')!, false));
    expect(messages.filter(m => m.type === '1warden:credential-capture')).toHaveLength(1);
    expect(messages[1]).toMatchObject({ input: { password: 'password', submitted: true } });
    field('p').value = 'new password';
    await observer.handle(event('keydown', field('p'), true, 'Enter'));
    expect(messages[2]).toMatchObject({ input: { password: 'new password', submitted: true } });
    await observer.handle(event('submit', document.querySelector('form')!, false));
    expect(messages[3]).toMatchObject({ input: { submitted: true } });
  });
  it('retains an explicit username-only step only after submit and clears grants when locked', async () => {
    const { observer, messages, lock } = setup(); await observer.refresh();
    field('p').remove();
    await observer.handle(event('input', field('u')));
    await observer.handle(event('change', field('u')));
    expect(messages).toHaveLength(1);
    await observer.handle(event('keydown', field('u'), true, 'Enter'));
    expect(messages[1]).toMatchObject({ type: '1warden:credential-username', username: 'alice' });
    lock(); await observer.refresh();
    expect(observer.status.token).toBeNull();
    await observer.handle(event('keydown', field('u'), true, 'Enter'));
    expect(messages).toHaveLength(3);
  });
  it('refuses mismatching confirmation, unrelated form events and expired interaction', async () => {
    const { observer, messages } = setup(); await observer.refresh();
    document.body.innerHTML = '<form><input id="p" autocomplete="new-password" type="password" value="one"><input type="password" name="confirm" value="two"><button>Sign up</button></form>';
    await observer.handle(event('click', document.querySelector('button')!));
    expect(messages).toHaveLength(1);
  });
  it('expires scripted-submit provenance and retries status after a grant is revoked mid-handshake', async () => {
    const messages: CredentialRequest[] = []; let now = 1;
    const observer = new CredentialObserver(document, async request => {
      messages.push(request); return { unlocked: true, token: 't', notices: [] };
    }, () => now);
    await observer.refresh(); await observer.handle(event('input', field('p')));
    now += 60_001;
    await observer.handle(event('submit', document.querySelector('form')!, false));
    expect(messages).toHaveLength(1);
    let resolve!: (value: unknown) => void; let calls = 0;
    const racing = new CredentialObserver(document, async () => {
      calls++;
      if (calls === 1) return new Promise(done => { resolve = done; });
      return { unlocked: false, token: null, notices: [] };
    });
    const first = racing.refresh(); racing.clear();
    const second = racing.refresh();
    resolve({ unlocked: true, token: 'stale', notices: [] });
    await Promise.all([first, second]);
    expect(calls).toBe(2); expect(racing.status.token).toBeNull();
  });
  it('creates random document and form identities on HTTP pages without crypto.randomUUID', async () => {
    const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    try {
      const first = setup().observer; const second = setup().observer;
      expect(first.nonce).not.toBe(second.nonce); expect(first.nonce.length).toBeGreaterThanOrEqual(32);
      expect(first.forms.group(field('p'))?.id.length).toBeGreaterThanOrEqual(32);
    } finally {
      if (original) Object.defineProperty(crypto, 'randomUUID', original); else delete (crypto as Partial<Crypto>).randomUUID;
    }
  });
});
