// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.test/register"}
import { beforeEach, describe, expect, it } from 'vitest';
import { CredentialObserver } from './credential-observer';
import { generatorSettings, noticeText, installInlineCredentials } from './inline-credentials';

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
});
