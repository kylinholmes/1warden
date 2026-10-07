#!/usr/bin/env bun
/** Actual extension background, two encrypted loopback vaults, disposable headless browsers. */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { concatBytes, deriveMasterKey, encryptBytes, hashMasterPassword, makeUserKey, stretchMasterKey } from '../packages/crypto/src/index';
import { buildProfileItem, encryptCipher } from '../packages/vault/src/index';
import { createFakeServer, fakeJwt } from '../packages/vault/src/testing/fake-server';

const product = process.argv[2] ?? 'edge';
if (!['edge', 'zen'].includes(product)) throw Error('Usage: bun scripts/account-sessions-browser-smoke.ts edge|zen');
const firefox = product === 'zen';
const { default: puppeteer } = await import(pathToFileURL(resolve(process.env.COFFER_PUPPETEER
  ?? '/tmp/coffer-browser-tools/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).href);
const directory = mkdtempSync(join(tmpdir(), `coffer-account-sessions-${product}-`));
const dist = join(directory, 'extension');
cpSync(resolve('apps/desktop', firefox ? 'dist-firefox' : 'dist-extension'), dist, { recursive: true });
const uuid = 'dcb51578-69ac-45f2-8305-27ef44a3b3f7';
const email = 'shared-email@example.invalid';

async function backend(label: string, password: string) {
  const userKey = makeUserKey();
  const masterKey = await deriveMasterKey(password, email, { kdf: 0, iterations: 1000 });
  const stretchedMasterKey = await stretchMasterKey(masterKey);
  const passwordHash = await hashMasterPassword(masterKey, password);
  const wrappedKey = await encryptBytes(concatBytes(userKey.encKey, userKey.macKey), stretchedMasterKey);
  const userId = `synthetic-user-${label}`;
  const token = fakeJwt(userId);
  const noteId = `synthetic-note-${label}`;
  const noteName = `Backend ${label} note`;
  const noteText = `Private synthetic note from backend ${label}`;
  const profile = { displayName: `Backend ${label} owner`, avatarDataUrl: null };
  const empty = buildProfileItem({ displayName: '', avatarDataUrl: null });
  const metadata = { key: null, creationDate: '2026-10-01T00:00:00.000Z', revisionDate: '2026-10-01T00:00:00.000Z',
    deletedDate: null, archivedDate: null, attachments: null, collectionIds: [] };
  const ciphers = [
    { ...await encryptCipher({ ...empty, name: noteName, notes: noteText, customFields: [] }, userKey, {}), ...metadata, id: noteId },
    { ...await encryptCipher(buildProfileItem(profile), userKey, {}), ...metadata, id: `synthetic-profile-${label}` },
  ];
  let authenticationRequests = 0;
  const fake = createFakeServer({ userKey, stretchedMasterKey, override(path) {
    if (path === '/identity/connect/token') return Response.json({
      access_token: token, refresh_token: `synthetic-refresh-${label}`, expires_in: 3600,
      token_type: 'Bearer', Key: wrappedKey, PrivateKey: null, Kdf: 0, TwoFactorToken: null,
    });
    if (path === '/api/sync') return Response.json({ profile: { id: userId, email }, ciphers, folders: [], collections: [] });
    if (path === '/api/accounts/revision-date') return new Response(String(Date.now()));
    return undefined;
  } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = request.method === 'GET' ? undefined : await request.text();
    if (path === '/identity/connect/token') {
      authenticationRequests++;
      const form = new URLSearchParams(body);
      if (form.get('username') !== email || form.get('password') !== passwordHash) {
        return Response.json({ message: 'Synthetic account password is incorrect' }, { status: 400 });
      }
    }
    if (path.startsWith('/api/') && request.headers.get('authorization') !== `Bearer ${token}`) {
      return Response.json({ message: 'Synthetic backend token is incorrect' }, { status: 401 });
    }
    return fake.fetchImpl(request.url, { method: request.method, ...(body === undefined ? {} : { body }) });
  } });
  return { target: { serverUrl: `http://127.0.0.1:${server.port}`, email }, server, password,
    noteId, noteName, noteText, profile, key: JSON.stringify([`http://127.0.0.1:${server.port}`, email]),
    get authenticationRequests() { return authenticationRequests; } };
}

const a = await backend('A', 'Synthetic-Backend-A!42');
const b = await backend('B', 'Synthetic-Backend-B!84');
const totalAuthentications = () => a.authenticationRequests + b.authenticationRequests;
const errors: string[] = [];
let checks = 0;
let browser: any;
let page: any;
function check(ok: unknown, name: string) {
  if (!ok) throw Error(name);
  checks++; console.log(`PASS ${product}: ${name}`);
}
try {
  browser = await puppeteer.launch({ browser: firefox ? 'firefox' : 'chrome', headless: true, userDataDir: directory,
    executablePath: process.env[`COFFER_${product.toUpperCase()}`] ?? (firefox
      ? '/Applications/Zen.app/Contents/MacOS/zen' : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    enableExtensions: true, protocolTimeout: 30_000,
    ...(firefox ? { args: ['--remote-allow-system-access'], extraPrefsFirefox: {
      'extensions.webextensions.uuids': JSON.stringify({ 'coffer@coffer.app': uuid }),
    } } : { pipe: true }),
  });
  const id = await browser.installExtension(dist);
  const url = `${firefox ? `moz-extension://${uuid}` : `chrome-extension://${id}`}/popup.html`;
  async function open(selector: string) {
    page = await browser.newPage(); await page.setViewport({ width: 440, height: 600 });
    page.setDefaultTimeout(10_000);
    page.on('pageerror', (error: Error) => errors.push(error.message));
    if (firefox) await page.mainFrame().browsingContext.navigate(url, 'interactive'); else await page.goto(url);
    await page.waitForSelector(selector);
  }
  async function rpc(method: string, args: unknown[] = []) {
    return page.evaluate(async (m: string, values: unknown[]) => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      return api.runtime.sendMessage({ type: 'coffer:application', method: m, args: values });
    }, method, args);
  }
  async function snapshot() {
    const reply = await rpc('snapshot');
    if (!reply.ok) throw Error(`Snapshot failed: ${reply.error?.message}`);
    return reply.result;
  }
  async function text(selector: string, value: string) {
    await page.$eval(selector, (input: HTMLInputElement, next: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }
  async function connect(account: typeof a) {
    await page.waitForSelector('input[type="url"]');
    await text('input[type="url"]', account.target.serverUrl);
    await text('input[type="email"]', account.target.email);
    await text('input[type="password"]', account.password);
    await page.$eval('button[type="submit"]', (button: HTMLButtonElement) => button.click());
    await page.waitForSelector('.nav-trigger');
    await page.waitForFunction(async (target: { serverUrl: string; email: string }) => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      const accounts = JSON.parse((await api.storage.local.get('coffer.accounts'))['coffer.accounts'] ?? '[]');
      return accounts.some((saved: { serverUrl: string; email: string }) => saved.serverUrl === target.serverUrl && saved.email === target.email);
    }, {}, account.target);
  }
  async function openMenu() {
    await page.waitForSelector('.nav-trigger');
    if (firefox) await page.$eval('[aria-label="账户菜单"]', (button: HTMLButtonElement) => button.click());
    else {
      await page.click('.nav-trigger');
      await page.waitForFunction(() => document.querySelector('.nav-drawer-panel')!.getBoundingClientRect().x >= -0.5);
      await page.click('[aria-label="账户菜单"]');
    }
    await page.waitForSelector('#profile-account-menu');
  }
  async function clickHandle(handle: any) {
    if (!handle.asElement()) throw Error('Missing account action');
    if (firefox) await handle.evaluate((button: HTMLButtonElement) => button.click());
    else await handle.asElement().click();
    await handle.dispose();
  }
  async function menuAction(label: string) {
    await openMenu();
    await clickHandle(await page.evaluateHandle((name: string) => Array.from(document.querySelectorAll('#profile-account-menu button'))
      .find((button) => button.textContent?.trim() === name), label));
  }
  async function menuSwitch(account: typeof a, unlocked: boolean) {
    await openMenu();
    await page.waitForFunction((key: string) => Array.from(document.querySelectorAll('[data-switch-account]'))
      .some((button) => button.getAttribute('data-switch-account') === key), {}, account.key);
    const handle = await page.evaluateHandle((key: string) => Array.from(document.querySelectorAll('[data-switch-account]'))
      .find((button) => button.getAttribute('data-switch-account') === key), account.key);
    check(await handle.evaluate((button: HTMLButtonElement, expected: string) => button.textContent?.includes(expected), unlocked ? '已解锁' : '需要验证'),
      `menu reports backend ${account === a ? 'A' : 'B'} as ${unlocked ? 'unlocked' : 'requiring authentication'}`);
    await clickHandle(handle);
    await page.waitForSelector(unlocked ? '.nav-trigger' : '#unlock-password');
    await page.waitForFunction(async (target: { serverUrl: string; email: string }) => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      const current = (await api.runtime.sendMessage({ type: 'coffer:application', method: 'snapshot', args: [] })).result;
      return current.account?.serverUrl === target.serverUrl && current.account?.email === target.email;
    }, {}, account.target);
  }
  async function checkVault(account: typeof a, label: string) {
    const current = await snapshot();
    check(current.status === 'unlocked' && current.account.serverUrl === account.target.serverUrl && current.account.email === email
      && current.account.userId === `synthetic-user-${account === a ? 'A' : 'B'}` && current.items.length === 1
      && current.items[0].id === account.noteId && current.items[0].name === account.noteName
      && current.profile?.displayName === account.profile.displayName, `${label}: only the selected backend's record and profile are visible`);
    const detail = await rpc('getItem', [account.noteId]);
    check(detail.ok && detail.result.notes === account.noteText, `${label}: the selected account's own user key decrypts its note`);
    const foreign = await rpc('getItem', [(account === a ? b : a).noteId]);
    check(!foreign.ok, `${label}: the other account's record is inaccessible`);
  }
  async function unlock(account: typeof a) {
    await page.waitForSelector('#unlock-password');
    await text('#unlock-password', account.password);
    await page.$eval('button[type="submit"]', (button: HTMLButtonElement) => button.click());
    await page.waitForSelector('.nav-trigger');
  }

  await open('input[type="email"]');
  await connect(a); await checkVault(a, 'First login A');
  await menuAction('添加账户');
  await connect(b); await checkVault(b, 'Second login B');
  check(a.authenticationRequests === 1 && b.authenticationRequests === 1, 'both backends authenticate once with independent passwords');
  check((await snapshot()).unlockedAccounts?.length === 2, 'background reports both accounts as unlocked');

  for (const account of [a, b, a, b]) {
    await menuSwitch(account, true);
    await checkVault(account, `Direct return to ${account === a ? 'A' : 'B'}`);
    check(totalAuthentications() === 2 && await page.$('#unlock-password') === null, 'switching an unlocked account sends no authentication and shows no password form');
  }
  await page.close(); await open('.nav-trigger');
  await checkVault(b, 'Popup reopen B');
  check(totalAuthentications() === 2, 'closing and reopening the popup preserves both unlocked sessions');

  check((await rpc('lock')).ok, 'locks selected account B through the real background');
  const lockedB = await snapshot();
  check(lockedB.status === 'locked' && lockedB.items.length === 0
    && lockedB.unlockedAccounts?.includes(a.key) && !lockedB.unlockedAccounts?.includes(b.key), 'locking B removes only B from unlocked accounts');
  check((await rpc('switchAccount', [a.target])).ok, 'selects A after B locks');
  await page.waitForSelector('.nav-trigger'); await checkVault(a, 'A after B locks');
  check(totalAuthentications() === 2, 'A remains available without authentication after B locks');
  await menuSwitch(b, false);
  await text('#unlock-password', a.password);
  await page.$eval('button[type="submit"]', (button: HTMLButtonElement) => button.click());
  await page.waitForSelector('[role="alert"]');
  check((await snapshot()).status === 'locked' && (await snapshot()).items.length === 0, 'locked B rejects the password belonging to backend A');
  check(a.authenticationRequests === 1 && b.authenticationRequests === 2, 'wrong password is checked only by selected backend B');
  await unlock(b); await checkVault(b, 'B after reauthentication');
  check(a.authenticationRequests === 1 && b.authenticationRequests === 3, 'locked B requires fresh authentication with its own password');

  await menuAction('登出');
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === '选择要连接的账户');
  const loggedOutB = await snapshot();
  check(loggedOutB.status === 'loggedOut' && loggedOutB.unlockedAccounts?.includes(a.key)
    && !loggedOutB.unlockedAccounts?.includes(b.key), 'logging out B preserves the unlocked A session');
  const beforePicker = totalAuthentications();
  await clickHandle(await page.evaluateHandle((serverUrl: string) => Array.from(document.querySelectorAll('li button'))
    .find((button) => button.textContent?.includes(new URL(serverUrl).host)), a.target.serverUrl));
  await page.waitForSelector('.nav-trigger'); await checkVault(a, 'Remembered picker A');
  check(totalAuthentications() === beforePicker && await page.$('#unlock-password') === null, 'remembered account picker restores unlocked A without a password');
  await menuSwitch(b, false);
  check(totalAuthentications() === beforePicker && (await snapshot()).status === 'locked', 'logged-out B requires authentication when selected again');
  await unlock(b); await checkVault(b, 'B after logout and reauthentication');
  check(a.authenticationRequests === 1 && b.authenticationRequests === 4, 'logged-out B authenticates afresh while A has still authenticated only once');

  await menuSwitch(a, true);
  check((await rpc('lock')).ok, 'locks selected account A independently');
  const lockedA = await snapshot();
  check(!lockedA.unlockedAccounts?.includes(a.key) && lockedA.unlockedAccounts?.includes(b.key), 'locking A preserves unlocked B');
  check((await rpc('switchAccount', [b.target])).ok, 'selects B after A locks');
  await page.waitForSelector('.nav-trigger'); await checkVault(b, 'B after A locks');
  check(totalAuthentications() === 5, 'B returns without authentication after A locks');
  check(errors.length === 0, 'no browser runtime errors');
  console.log(`${checks} account-session checks passed across two encrypted loopback backends; ${totalAuthentications()} authentication requests`);
} finally {
  await browser?.close(); a.server.stop(true); b.server.stop(true);
  rmSync(directory, { recursive: true, force: true });
}
