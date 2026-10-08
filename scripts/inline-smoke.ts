#!/usr/bin/env bun
/** Real extension/content/background integration, headless Edge or Zen only.
 * Uses a disposable browser profile and synthetic credentials served locally.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { deriveMasterKey, stretchMasterKey } from '../packages/crypto/src/index';
import { encryptCipher } from '../packages/vault/src/encrypt';
import type { VaultItem } from '../packages/vault/src/model';
import { createFakeServer } from '../packages/vault/src/testing/fake-server';

const product = process.argv[2];
if (product !== 'edge' && product !== 'zen') throw new Error('Usage: bun scripts/inline-smoke.ts edge|zen');
const engine = product === 'edge' ? 'chrome' : 'firefox';
const executable = process.env[`ONEWARDEN_${product.toUpperCase()}`] ?? (product === 'edge'
  ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '/Applications/Zen.app/Contents/MacOS/zen');
if (!existsSync(executable)) throw new Error(`Browser not found: ${executable}`);
const { default: puppeteer } = await import(process.env.ONEWARDEN_PUPPETEER
  ? pathToFileURL(resolve(process.env.ONEWARDEN_PUPPETEER)).href : 'puppeteer-core');
const source = resolve(process.env.ONEWARDEN_INLINE_DIST ?? join(import.meta.dir, '../apps/desktop', product === 'edge' ? 'dist-extension' : 'dist-firefox'));
const artifacts = resolve(process.env.ONEWARDEN_SMOKE_OUT ?? mkdtempSync(join(tmpdir(), 'onewarden-inline-artifacts-')));
mkdirSync(artifacts, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), `onewarden-inline-${product}-`));
const dist = join(profile, 'extension');
// Later builds in the shared workspace cannot mutate an extension under test.
cpSync(source, dist, { recursive: true });
function files(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(join(directory, entry.name), join(prefix, entry.name))
    : entry.isFile() && !entry.name.endsWith('.map') ? [join(prefix, entry.name)] : []);
}
const buildHashes = Object.fromEntries(files(dist).sort().map((file) => [file,
  createHash('sha256').update(readFileSync(join(dist, file))).digest('hex')]));
const uuid = '3ce22849-355d-42cf-bd2e-d0258e03d7c5';
let fakeServer: ReturnType<typeof createFakeServer>;
const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  if (/^\/(identity|api)\//.test(new URL(request.url).pathname)) return fakeServer.fetchImpl(request.url, { method: request.method });
  return new Response(`<!doctype html><meta charset="utf-8"><title>Inline extension smoke</title>
    <style>body{padding:60px;font:16px sans-serif}input{display:block;width:300px;padding:12px;margin:10px 0 22px}</style>
    <form><label>Email<input id="email" autocomplete="username"></label>
    <label>Password<input id="password" type="password" autocomplete="current-password"></label></form>
    <script>document.querySelector('form').onsubmit=e=>e.preventDefault()</script>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
} });
const url = `http://127.0.0.1:${site.port}/login`;
function item(id: string, uri = url): VaultItem {
  return { id, name: `${id === 'a' ? 'Personal' : id === 'b' ? 'Work' : 'Unrelated'} account`, type: 'login', rawType: 1,
    nameFailed: false, notes: 'Private synthetic notes', notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { username: `${id}@example.invalid`, password: `Synthetic-${id}-Password!42`, uris: [{ uri, match: 3 }],
      totp: null, passwordRevisionDate: null, fido2Credentials: [] },
    card: null, identity: null, secureNote: null, sshKey: null, customFields: [], passwordHistory: [], attachments: [] };
}
const account = { serverUrl: `http://127.0.0.1:${site.port}`, email: 'synthetic@example.invalid',
  userId: 'inline-smoke-user', kdf: { kdf: 0, iterations: 1000 } };
const seed = { account, userKey: { encKey: Buffer.alloc(32, 17).toString('base64'), macKey: Buffer.alloc(32, 23).toString('base64') },
  items: [item('a'), item('b'), item('unrelated', 'https://unrelated.invalid/')], folders: [], token: null,
  expiresAt: Date.now() + 900000 };
const masterPassword = 'Synthetic-Inline-Master-Password!42';
const userKey = { encKey: new Uint8Array(32).fill(17), macKey: new Uint8Array(32).fill(23) };
const ciphers = await Promise.all(seed.items.map(async (entry) => ({
  ...await encryptCipher(entry, userKey, {}), id: entry.id, creationDate: entry.createdAt, revisionDate: entry.updatedAt,
})));
fakeServer = createFakeServer({ userKey, stretchedMasterKey:
  await stretchMasterKey(await deriveMasterKey(masterPassword, account.email, account.kdf)),
  override: (path) => path === '/api/sync' ? Response.json({ profile: { id: account.userId, email: account.email },
    ciphers, folders: [], collections: [] }) : undefined,
});
let browser: any;
let control: any;
let login: any;
let failure = '';
let version = '';
const checks: string[] = [];
const errors: string[] = [];
let unlockOutcome: unknown;
let popupViews: unknown;
function check(label: string, ok: boolean, details = ''): void {
  if (!ok) throw new Error(`${label}${details ? `: ${details}` : ''}`);
  checks.push(label);
  console.log(`✓ ${label}`);
}
try {
  browser = await puppeteer.launch({ browser: engine, executablePath: executable, headless: true,
    userDataDir: profile, enableExtensions: true, ...(engine === 'chrome' ? { pipe: true } : {
      args: ['--remote-allow-system-access'],
      extraPrefsFirefox: { 'extensions.webextensions.uuids': JSON.stringify({ '1warden@1warden.app': uuid }) },
    }),
  });
  version = await browser.version();
  const extensionId = await browser.installExtension(dist);
  const origin = engine === 'chrome' ? `chrome-extension://${extensionId}` : `moz-extension://${uuid}`;
  login = await browser.newPage();
  login.setDefaultTimeout(10000);
  login.on('pageerror', (error: Error) => errors.push(error.message));
  await login.setViewport({ width: 780, height: 620 });
  await login.goto(url);
  control = await browser.newPage();
  control.setDefaultTimeout(10000);
  if (engine === 'firefox') await control.mainFrame().browsingContext.navigate(`${origin}/popup.html`, 'interactive');
  else await control.goto(`${origin}/popup.html`, { waitUntil: 'domcontentloaded' });
  await control.waitForSelector('input[type="email"]');
  const setSeed = () => control.evaluate(async (fixture: unknown) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    await api.storage.session.set({ '1warden.session': fixture, '1warden.account': (fixture as any).account });
  }, seed);
  const rpc = (method: string, args: unknown[] = []) => control.evaluate(async (m: string, a: unknown[]) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return api.runtime.sendMessage({ type: '1warden:application', method: m, args: a });
  }, method, args);
  await setSeed();
  check('trusted background restores synthetic session', (await rpc('snapshot')).result.status === 'unlocked');
  const tabId = await control.evaluate(async (targetUrl: string) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return (await api.tabs.query({})).find((tab: any) => tab.url === targetUrl)?.id;
  }, url);
  check('browser supplies the login tab identity', typeof tabId === 'number');
  const fromContent = (request: unknown) => control.evaluate(async (id: number, message: unknown) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    const [result] = await api.scripting.executeScript({ target: { tabId: id, frameIds: [0] },
      func: async (payload: unknown) => {
        const contentApi = (globalThis as any).browser ?? (globalThis as any).chrome;
        return contentApi.runtime.sendMessage(payload);
      }, args: [message] });
    return result.result;
  }, tabId, request);
  const accounts = await fromContent({ type: '1warden:inline-accounts', url: 'https://unrelated.invalid/', tabId: 999 });
  check('content receives only the two matching account labels', isDeepStrictEqual(accounts, {
    unlocked: true, accounts: [{ id: 'a', title: 'Personal account', username: 'a@example.invalid' },
      { id: 'b', title: 'Work account', username: 'b@example.invalid' }],
  }), JSON.stringify(accounts));
  const denied = await fromContent({ type: '1warden:inline-fill', itemId: 'unrelated' });
  check('known unrelated item IDs cannot be filled', typeof denied.error === 'string');
  const reveal = await fromContent({ type: '1warden:application', method: 'reveal', args: ['a', { kind: 'password' }] });
  check('content cannot reveal arbitrary vault secrets', reveal.ok === false);
  await login.bringToFront();
  await login.click('#email');
  await login.waitForSelector('[data-onewarden-inline][data-state="accounts"]', { visible: true });
  check('real content script creates closed shadow chooser', await login.$eval('[data-onewarden-inline]', (host: HTMLElement) => host.shadowRoot === null));
  await login.screenshot({ path: join(artifacts, `${product}-inline-accounts.png`) });
  // The closed shadow tree intentionally is not addressable by page selectors.
  // Click the center of the last visible row using the popup's outer geometry.
  const box = await login.$eval('[data-onewarden-inline]', (host: HTMLElement) => {
    const rect = host.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.bottom - 33 };
  });
  await login.mouse.click(box.x, box.y);
  await login.waitForFunction(() => (document.querySelector('#password') as HTMLInputElement).value === 'Synthetic-b-Password!42');
  check('clicking the second account fills its username and password through background injection',
    await login.$eval('#email', (input: HTMLInputElement) => input.value) === 'b@example.invalid');
  await login.waitForFunction(() => document.querySelector('[data-onewarden-inline]') === null);
  check('successful fill dismisses the chooser', true);

  await rpc('lock');
  check('locked content response has no accounts', isDeepStrictEqual(await fromContent({ type: '1warden:inline-accounts' }),
    { unlocked: false, accounts: [] }));
  await login.bringToFront();
  await login.click('#email');
  await login.waitForSelector('[data-onewarden-inline][data-state="locked"]', { visible: true });
  await login.screenshot({ path: join(artifacts, `${product}-inline-locked.png`) });
  // Observe the actual trusted button's message in the extension's isolated
  // world. Sending a second test request would lose the original gesture.
  await control.evaluate(async (id: number) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    await api.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: () => {
      const contentApi = (globalThis as any).browser ?? (globalThis as any).chrome;
      const original = contentApi.runtime.sendMessage.bind(contentApi.runtime);
      (globalThis as any).__inlineUnlock = { requests: 0, pending: true };
      contentApi.runtime.sendMessage = (...args: any[]) => {
        const response = original(...args);
        if (args[0]?.type === '1warden:inline-unlock') {
          (globalThis as any).__inlineUnlock.requests++;
          void response.then((reply: unknown) => {
            (globalThis as any).__inlineUnlock = { requests: 1, reply };
          }, (error: Error) => { (globalThis as any).__inlineUnlock = { requests: 1, error: error.message }; });
        }
        return response;
      };
    } });
  }, tabId);
  await login.keyboard.press('ArrowDown');
  await login.keyboard.press('Enter');
  await control.waitForFunction(async (id: number) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    const [result] = await api.scripting.executeScript({ target: { tabId: id, frameIds: [0] },
      func: () => (globalThis as any).__inlineUnlock });
    return result.result.requests === 1 && (!result.result.pending || api.extension.getViews({ type: 'popup' }).length > 0);
  }, { polling: 100 }, tabId);
  unlockOutcome = await control.evaluate(async (id: number) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    const [result] = await api.scripting.executeScript({ target: { tabId: id, frameIds: [0] },
      func: () => (globalThis as any).__inlineUnlock });
    return result.result;
  }, tabId);
  if ((unlockOutcome as any)?.reply?.ok === true) {
    await control.waitForFunction(() => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      return api.extension.getViews({ type: 'popup' })
        .some((view: Window) => view.document.querySelector('input[type="password"]') !== null);
    }, { polling: 100 });
    check('the actual unlock popup renders its password field', true);
  }
  popupViews = await control.evaluate(() => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    const views = api.extension.getViews({ type: 'popup' });
    const result = views.map((view: Window) => ({ url: view.location.href,
      passwordField: view.document.querySelector('input[type="password"]') !== null }));
    for (const view of views) view.close();
    return result;
  });
  check('unlock uses extension UI or reports the browser toolbar fallback',
    (unlockOutcome as any)?.requests === 1 && ((unlockOutcome as any)?.reply?.ok === true
      || (unlockOutcome as any)?.reply?.error?.includes('工具栏') || (popupViews as unknown[]).length > 0),
    JSON.stringify({ unlockOutcome, popupViews }));
  // Authenticate against the local synthetic server: real KDF, key unwrap,
  // encrypted sync and application unlock, without any personal account.
  const unlocked = await rpc('unlock', [masterPassword]);
  check('local synthetic authentication unlocks the background session', unlocked.ok === true
    && (await rpc('snapshot')).result.status === 'unlocked', JSON.stringify(unlocked));
  await login.bringToFront();
  await login.waitForSelector('[data-onewarden-inline][data-state="accounts"]', { visible: true });
  check('chooser resumes with accounts after unlocking', true);
  check('unlock does not automatically overwrite filled credentials',
    await login.$eval('#password', (input: HTMLInputElement) => input.value) === 'Synthetic-b-Password!42');
  await login.click('#email');
  await login.keyboard.press('ArrowDown');
  await login.keyboard.press('Enter');
  await login.waitForFunction(() => (document.querySelector('#password') as HTMLInputElement).value === 'Synthetic-a-Password!42');
  check('keyboard selection after unlock fills the selected account', true);
  check('no uncaught page errors', errors.length === 0, errors.join('\n'));
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(failure);
  if (control) console.error(await control.evaluate(async (targetUrl: string) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    const tab = (await api.tabs.query({})).find((candidate: any) => candidate.url === targetUrl);
    const result = tab ? await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => ({
      unlock: (globalThis as any).__inlineUnlock, focused: document.hasFocus(), active: document.activeElement?.tagName,
      chooser: document.querySelector('[data-onewarden-inline]')?.getAttribute('data-state'),
    }) }) : [];
    return { page: result[0]?.result, popups: api.extension.getViews({ type: 'popup' }).map((view: Window) => view.location.href) };
  }, url).catch(() => ({})));
  await login?.screenshot({ path: join(artifacts, `${product}-inline-failure.png`) }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  site.stop(true);
  rmSync(profile, { recursive: true, force: true });
  writeFileSync(join(artifacts, `${product}-inline-report.json`), JSON.stringify({ product, engine, version, executable,
    source, buildHashes, headless: true, disposableProfile: profile, passed: !failure, checks, errors,
    unlockOutcome, popupViews, failure, timestamp: new Date().toISOString(), synthetic: true }, null, 2));
  console.log(`Artifacts: ${artifacts}`);
}
if (failure) process.exitCode = 1;
