// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.test/register"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialObserver } from './credential-observer';
import { generatorSettings, noticeText, installInlineCredentials } from './inline-credentials';
import type { CredentialDocumentReply } from './credential-protocol';

beforeEach(() => {
  document.body.innerHTML = '<form><input id="u" autocomplete="username"><input id="p" type="password" autocomplete="new-password" value="never-display-this-secret"></form>';
  Object.defineProperty(HTMLElement.prototype, 'getClientRects', { configurable: true, value() { return [{}]; } });
});
describe('credential inline metadata', () => {
  it('clamps generation settings to the live form constraints', () => {
    expect(generatorSettings({ minLength: 24, maxLength: 30 })).toEqual({ length: 24, digits: true, symbols: true });
    expect(generatorSettings({ minLength: 8, maxLength: 12 }, { length: 60, digits: false, symbols: true })).toEqual({ length: 12, digits: false, symbols: true });
  });
  it('uses source and username with explicit save, update and review wording', () => {
    expect(noticeText({ url: 'https://example.test/register', username: 'alice', action: 'save' })).toMatchObject({ source: 'example.test', detail: 'alice', action: '检查并保存' });
    expect(noticeText({ url: 'https://example.test/change', username: null, action: 'update' }).action).toBe('检查并更新');
    expect(noticeText({ url: 'https://example.test/register', username: 'alice', action: 'review' }).description).toContain('注册');
  });
  it('reserves new-password fields for generation, keeps a single isolated overlay and tolerates document_start', async () => {
    const observer = new CredentialObserver(document, async () => ({ unlocked: true, token: 't', notices: [] }));
    await observer.refresh();
    const ui = installInlineCredentials(observer);
    const password = document.getElementById('p') as HTMLInputElement;
    const username = document.getElementById('u') as HTMLInputElement;
    expect(ui.prefersGenerator(password)).toBe(true);
    expect(ui.prefersGenerator(username)).toBe(false);
    await ui.openGenerator(password);
    expect(document.querySelectorAll('[data-onewarden-credentials="generator"]')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('never-display-this-secret');
    expect(document.querySelector('[data-onewarden-credentials="generator"]')!.shadowRoot).toBeNull();
    await ui.openGenerator(password);
    expect(document.querySelectorAll('[data-onewarden-credentials="generator"]')).toHaveLength(1);
    ui.closeGenerator();
    expect(document.querySelector('[data-onewarden-credentials="generator"]')).toBeNull();
    ui.dispose();
  });
  it('preserves the notice element across repeated metadata refreshes so keyboard focus remains stable', async () => {
    const observer = new CredentialObserver(document, async () => ({ unlocked: true, token: 't', notices: [{ id: 'notice', revision: 1, url: location.href, username: 'alice', action: 'save' }] }));
    await observer.refresh(); const ui = installInlineCredentials(observer);
    const first = document.querySelector('[data-onewarden-credentials="notice"]');
    expect(first).not.toBeNull();
    await observer.refresh();
    expect(document.querySelector('[data-onewarden-credentials="notice"]')).toBe(first);
    ui.dispose();
  });
  it.each(['save', 'update', 'review'] as const)('announces an arriving %s notice with its host/action without stealing input focus', async action => {
    const roots: ShadowRoot[] = [];
    const attach = Element.prototype.attachShadow;
    const spy = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, options) {
      const root = attach.call(this, options); roots.push(root); return root;
    });
    const observer = new CredentialObserver(document, async () => ({ unlocked: true, token: 't', notices: [{ id: 'arrival', revision: 1, url: location.href, username: 'synthetic', action }] }));
    await observer.refresh();
    const input = document.getElementById('u')!; input.focus();
    const ui = installInlineCredentials(observer);
    try {
      const status = roots[0]!.querySelector('[role="status"]')!;
      expect(status.textContent).toBe('');
      await new Promise(resolve => setTimeout(resolve, 1));
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect(status.textContent).toContain('1Warden：example.test');
      expect(status.textContent).toContain(action === 'update' ? '检查并更新' : '检查并保存');
      expect(document.activeElement).toBe(input);
      expect(roots[0]!.textContent).not.toContain('never-display-this-secret');
    } finally { ui.dispose(); spy.mockRestore(); }
  });
  it('never populates replaced, cross-origin, detached or disposed arrival regions', async () => {
    const roots: ShadowRoot[] = [];
    const attach = Element.prototype.attachShadow;
    const spy = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, options) {
      const root = attach.call(this, options); roots.push(root); return root;
    });
    let reply: CredentialDocumentReply = { unlocked: true, token: 't', notices: [{ id: 'arrival', revision: 1,
      url: location.href, username: 'synthetic', action: 'save' }] };
    const observer = new CredentialObserver(document, async () => reply);
    await observer.refresh(); vi.useFakeTimers();
    const ui = installInlineCredentials(observer);
    const arrival = (index: number) => roots[index]!.querySelector('.arrival')!;
    try {
      reply = { ...reply, notices: [{ ...reply.notices[0]!, revision: 2, action: 'update' }] };
      await observer.refresh(); await vi.runOnlyPendingTimersAsync();
      expect(arrival(0).textContent).toBe('');
      expect(arrival(1).textContent).toContain('检查并更新');
      reply = { ...reply, notices: [{ ...reply.notices[0]!, revision: 3, url: 'https://other.test/register' }] };
      await observer.refresh();
      expect(document.querySelector('[data-onewarden-credentials="notice"]')).toBeNull();
      expect(roots).toHaveLength(2);
      reply = { ...reply, notices: [{ ...reply.notices[0]!, revision: 4, url: location.href }] };
      await observer.refresh();
      document.querySelector('[data-onewarden-credentials="notice"]')!.remove();
      await vi.runOnlyPendingTimersAsync(); expect(arrival(2).textContent).toBe('');
      await observer.refresh(); ui.dispose();
      await vi.runOnlyPendingTimersAsync(); expect(arrival(3).textContent).toBe('');
    } finally { ui.dispose(); vi.useRealTimers(); spy.mockRestore(); }
  });
});
