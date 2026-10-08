#!/usr/bin/env bun
/** Synthetic local server + disposable, headless Edge/Zen; never reads personal vaults. */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveMasterKey, stretchMasterKey, makeUserKey } from '../packages/crypto/src/index';
import { createFakeServer } from '../packages/vault/src/testing/fake-server';

const product = process.argv[2] ?? 'edge';
if (!['edge', 'zen'].includes(product)) throw Error('Usage: bun scripts/profile-smoke.ts edge|zen');
const firefox = product === 'zen';
const { default: puppeteer } = await import(pathToFileURL(resolve(process.env.ONEWARDEN_PUPPETEER
  ?? '/tmp/onewarden-browser-tools/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).href);
const directory = mkdtempSync(join(tmpdir(), `onewarden-profile-${product}-`));
const output = mkdtempSync(join(tmpdir(), `onewarden-profile-artifacts-${product}-`));
const dist = join(directory, 'extension');
cpSync(resolve('apps/desktop', firefox ? 'dist-firefox' : 'dist-extension'), dist, { recursive: true });
const uuid = '6c9c9b48-fb39-4c95-b193-227a60e6db85';
const realUpstream = process.env.ONEWARDEN_PROFILE_REAL_URL;
if (realUpstream && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(realUpstream).hostname)) throw Error('Real test server must be loopback');
const email = realUpstream ? 'onewarden-test@example.com' : 'profile@example.invalid';
const masterPassword = realUpstream ? 'Test-Master-Password-123!' : 'Synthetic-Profile-Test!42';
let cleanupId: string | undefined;
let cleanupHeaders: Headers | undefined;
const userKey = makeUserKey();
let ciphers: any[] = [];
const writes: any[] = [];
let rejectWrite = false;
let rejectAuthentication = false;
let authenticationRequests = 0;
let fake: ReturnType<typeof createFakeServer>;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/identity/connect/token') authenticationRequests++;
  if (rejectAuthentication && path === '/identity/accounts/prelogin') return Response.json({ message: 'Synthetic connection failure' }, { status: 503 });
  if (realUpstream) {
    const mutating = path.startsWith('/api/ciphers') && ['POST', 'PUT'].includes(request.method);
    if (mutating && rejectWrite) return Response.json({ message: 'Synthetic save failure' }, { status: 503 });
    const headers = new Headers(request.headers); headers.delete('host'); headers.delete('connection');
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();
    const response = await fetch(`${realUpstream}${path}`, { method: request.method, headers, body });
    if (mutating && response.ok) {
      writes.push({ method: request.method, body: JSON.parse(body!) });
      const cipher = await response.clone().json(); ciphers = [cipher];
      if (request.method === 'POST') { cleanupId = cipher.id; cleanupHeaders = headers; }
    }
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' } });
  }
  if (path.startsWith('/api/ciphers') && ['POST', 'PUT'].includes(request.method)) {
    if (rejectWrite) return Response.json({ message: 'Synthetic save failure' }, { status: 503 });
    const body = await request.json();
    if (body.notes.length > 10000) return Response.json({ message: 'Note too large' }, { status: 400 });
    const old = ciphers[0];
    if (old && body.lastKnownRevisionDate !== old.revisionDate) return Response.json({ message: 'Stale revision' }, { status: 409 });
    writes.push({ method: request.method, body });
    const cipher = { ...body, id: old?.id ?? 'profile-record', creationDate: old?.creationDate ?? new Date().toISOString(), revisionDate: new Date().toISOString() };
    ciphers = [cipher]; return Response.json(cipher);
  }
  return fake.fetchImpl(request.url, { method: request.method });
} });
const serverUrl = `http://127.0.0.1:${server.port}`;
fake = createFakeServer({ userKey, stretchedMasterKey: await stretchMasterKey(await deriveMasterKey(masterPassword, email, { kdf: 0, iterations: 1000 })),
  override: (path) => path === '/api/sync' ? Response.json({ profile: { id: 'profile-user', email }, ciphers, folders: [], collections: [] })
    : path === '/api/accounts/revision-date' ? new Response(String(Date.now())) : undefined,
});
let browser: any;
let page: any;
let checks = 0;
function check(ok: unknown, name: string) { if (!ok) throw Error(name); checks++; console.log(`PASS ${product}: ${name}`); }
try {
  browser = await puppeteer.launch({ browser: firefox ? 'firefox' : 'chrome', headless: true, userDataDir: directory,
    executablePath: firefox ? process.env.ONEWARDEN_ZEN ?? '/Applications/Zen.app/Contents/MacOS/zen'
      : process.env.ONEWARDEN_EDGE ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    enableExtensions: true, ...(firefox ? { args: ['--remote-allow-system-access'], extraPrefsFirefox: {
      'extensions.webextensions.uuids': JSON.stringify({ '1warden@1warden.app': uuid }),
    } } : { pipe: process.platform !== 'win32' }),
  });
  const id = await browser.installExtension(dist);
  const url = `${firefox ? `moz-extension://${uuid}` : `chrome-extension://${id}`}/popup.html`;
  async function open(selector: string) {
    page = await browser.newPage(); await page.setViewport({ width: 440, height: 600 });
    if (firefox) await page.mainFrame().browsingContext.navigate(url, 'interactive'); else await page.goto(url);
    await page.waitForFunction(() => !!document.querySelector('main button, input[type="email"], .nav-trigger'));
    if (await page.$('main')) {
      if (selector === 'input[type="email"]') await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-add-server]')?.click());
      else if (selector !== 'main li button') await pickHome();
    }
    await page.waitForSelector(selector);
  }
  async function pickHome() {
    const s = (await rpc('snapshot')).result;
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('main li button')].some(b => !b.disabled));
    await page.evaluate((target: any) => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('main li button')];
      const found = buttons.find(b => b.textContent?.includes(target?.email ?? '') && b.textContent?.includes(target ? new URL(target.serverUrl).host : '')) ?? buttons[0];
      found?.click();
    }, s.account);
  }
  async function homeProfile(displayName: string, avatarDataUrl: string, stage: string) {
    await page.waitForSelector('main li button');
    await page.waitForFunction((expected: { email: string; host: string; displayName: string; avatarDataUrl: string }) => {
      const row = [...document.querySelectorAll<HTMLButtonElement>('main li button')]
        .find(button => button.textContent?.includes(expected.email) && button.textContent?.includes(expected.host));
      const img = row?.querySelector('img');
      return row?.textContent?.includes(expected.displayName) && img?.complete && img.naturalWidth > 0 && img.src === expected.avatarDataUrl;
    }, { timeout: 5000 }, { email, host: new URL(serverUrl).host, displayName, avatarDataUrl });
    check(true, `${stage}: home shows decoded saved avatar, display name, email and server together`);
  }
  const rpc = (method: string, args: unknown[] = []) => page.evaluate(async (m: string, a: unknown[]) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return api.runtime.sendMessage({ type: '1warden:application', method: m, args: a });
  }, method, args);
  async function settings() {
    // Zen's BiDi cannot synthesize pointer input on privileged extension pages.
    if (firefox) {
      await page.$eval('[aria-label="账户菜单"]', (button: HTMLButtonElement) => button.click());
      await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('#profile-account-menu button')].find(button => button.textContent?.trim() === '用户详情')!.click());
      await page.waitForSelector('#profile-link-edit'); await page.$eval('#profile-link-edit', (button: HTMLButtonElement) => button.click());
      await page.waitForSelector('#profile-name'); return;
    }
    if (firefox) await page.$eval('.nav-trigger', (b: HTMLButtonElement) => { b.focus(); b.click(); });
    else await page.click('.nav-trigger');
    await page.waitForFunction(() => { const r = document.querySelector('.nav-drawer-panel')!.getBoundingClientRect(); return r.x >= -0.5 && r.width > 0; });
    if (firefox) await page.$eval('[aria-label="账户菜单"]', (b: HTMLButtonElement) => { b.focus(); b.click(); });
    else await page.click('[aria-label="账户菜单"]');
    const setting = await page.evaluateHandle(() => Array.from(document.querySelectorAll('#profile-account-menu button')).find((b) => b.textContent?.trim() === '用户详情'));
    if (firefox) await setting.evaluate((b: HTMLButtonElement) => { b.focus(); b.click(); }); else await setting.asElement().click();
    await setting.dispose(); await page.waitForSelector('#profile-link-edit'); await page.click('#profile-link-edit'); await page.waitForSelector('#profile-name');
  }
  async function text(selector: string, value: string) {
    await page.$eval(selector, (input: HTMLInputElement, next: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }
  async function save() {
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="status"]')).some((s) => s.textContent === '已同步'));
  }
  async function menuAction(label: string) {
    await page.waitForSelector('.nav-trigger');
    // Zen cannot generate hover/pointer input in privileged extension documents.
    // Exercise the real menu handler without waiting for the drawer's hover geometry.
    if (firefox) await page.$eval('[aria-label="账户菜单"]', (button: HTMLButtonElement) => button.click());
    else {
      await page.click('.nav-trigger');
      await page.waitForFunction(() => document.querySelector('.nav-drawer-panel')!.getBoundingClientRect().x >= -0.5);
      await page.click('[aria-label="账户菜单"]');
    }
    const handle = await page.evaluateHandle((text: string) => Array.from(document.querySelectorAll('#profile-account-menu button'))
      .find((button) => button.textContent?.trim() === text), label);
    if (!handle.asElement()) throw Error(`Missing menu action: ${label}`);
    if (firefox) await handle.evaluate((button: HTMLButtonElement) => button.click()); else await handle.asElement().click();
    await handle.dispose();
  }
  async function back() {
    await page.waitForSelector('[aria-label="返回上一级"]');
    if (firefox) await page.$eval('[aria-label="返回上一级"]', (button: HTMLButtonElement) => button.click());
    else await page.click('[aria-label="返回上一级"]');
  }
  await open('input[type="email"]');
  check((await rpc('connect', [{ serverUrl, email, masterPassword }])).ok, 'connects through real extension background');
  // This suite connects through RPC, bypassing the form's remember-account callback.
  await page.evaluate(async (account: { serverUrl: string; email: string }) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    await api.storage.local.set({ '1warden.accounts': JSON.stringify([account]) });
  }, { serverUrl, email });
  await page.waitForFunction(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return (await api.runtime.sendMessage({ type: '1warden:application', method: 'snapshot', args: [] })).result.profileSettings?.devices.length === 1;
  });
  const initial = (await rpc('snapshot')).result;
  if (initial.profile?.displayName || initial.profile?.avatarDataUrl) throw Error('Test account already has a personal Profile; refusing to overwrite it');
  await page.close(); await open('.nav-trigger'); await settings();
  check(writes.length === 1, 'only automatic device registration creates the record, not opening settings');
  await text('#profile-name', '彩色测试用户');
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 400; const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#0969ed'; ctx.fillRect(0, 0, 600, 400); ctx.fillStyle = '#ffbb33'; ctx.fillRect(200, 100, 200, 200);
    return c.toDataURL('image/png').split(',')[1];
  });
  const imagePath = join(output, 'synthetic-avatar.png'); writeFileSync(imagePath, Buffer.from(png, 'base64'));
  if (firefox) await page.evaluate((base64: string) => {
    const file = new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'synthetic-avatar.png', { type: 'image/png' });
    const transfer = new DataTransfer(); transfer.items.add(file);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, png); else await (await page.$('input[type="file"]')).uploadFile(imagePath);
  await page.waitForFunction(() => !!document.querySelector('#profile-heading')?.parentElement?.querySelector('img'));
  await page.evaluate(() => (Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '使用此头像') as HTMLButtonElement).click());
  await save();
  const saved = (await rpc('snapshot')).result;
  check(saved.profile.displayName === '彩色测试用户' && saved.profile.avatarDataUrl.startsWith('data:image/jpeg;base64,'), 'saves compressed avatar and display name');
  check(saved.profile.avatarDataUrl.length <= 3600, 'avatar fits note budget');
  check(writes.length >= 2 && writes[0].method === 'POST' && writes.slice(1).every(w => w.method === 'PUT') && ciphers.length === 1, 'automatic profile saves update the device profile record');
  check(writes[0].body.notes.startsWith('2.') && !JSON.stringify(writes[0]).includes('彩色测试用户') && !JSON.stringify(writes[0]).includes('data:image'), 'server receives encrypted profile only');
  check(saved.items.length === initial.items.length && (await rpc('search', ['1Warden'])).result.length === 0, 'profile is hidden from normal browse and search');
  if (!firefox) { await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})))); await page.screenshot({ path: join(output, 'profile-light.png') }); }
  await menuAction('添加账户'); await back();
  await homeProfile('彩色测试用户', saved.profile.avatarDataUrl, 'after profile save and return');
  await page.close(); await open('main li button');
  await homeProfile('彩色测试用户', saved.profile.avatarDataUrl, 'after popup reopen');
  if (!firefox) {
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
    await page.screenshot({ path: join(output, 'home-saved-profile.png') });
  }
  await pickHome(); await page.waitForSelector('.nav-trigger'); await settings();
  const beforeUpdate = writes.length;
  await text('#profile-name', '更新后的用户'); await save();
  check(writes.length === beforeUpdate + 1 && writes.at(-1).method === 'PUT' && ciphers.length === 1, 'second save updates the same record');
  rejectWrite = true; await text('#profile-name', '不能保存的修改');
  await page.waitForSelector('[role="alert"]');
  check((await rpc('snapshot')).result.profile.displayName === '更新后的用户', 'failed server write preserves last saved profile'); rejectWrite = false;
  await page.close(); await open('.nav-trigger'); await settings();
  check(await page.$eval('#profile-name', (i: HTMLInputElement) => i.value) === '更新后的用户', 'popup reopen restores saved profile');
  await rpc('lock'); await page.close(); await open('input[type="password"]');
  check(await page.evaluate(() => document.body.textContent?.includes('更新后的用户') && !!document.querySelector('img')), 'locked screen shows cached name and avatar');
  if (!firefox) await page.screenshot({ path: join(output, 'profile-locked.png') });
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '返回首页')!.click());
  await homeProfile('更新后的用户', saved.profile.avatarDataUrl, 'after locking and returning home');
  await pickHome(); await page.waitForSelector('input[type="password"]');
  await page.evaluate(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    const keys = Object.keys(await api.storage.local.get(null)).filter((k) => k.includes('profile.v1.') || k.includes('synccache.'));
    await api.storage.local.remove(keys);
  });
  check((await rpc('unlock', [masterPassword])).ok, 'unlocks and synchronizes again');
  check((await rpc('snapshot')).result.profile.displayName === '更新后的用户', 'fresh sync decrypts profile from server without local cache');
  await page.close(); await open('.nav-trigger');
  const other = { serverUrl, email: 'other-account@example.invalid' };
  const remote = { serverUrl: 'https://different-backend.example.invalid', email };
  const remoteProfile = { displayName: '另一个服务器的用户', avatarDataUrl: await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#2cba68'; ctx.fillRect(0, 0, 24, 24);
    return canvas.toDataURL('image/jpeg', 0.7);
  }) };
  const authenticationsBeforeSwitch = authenticationRequests;
  await page.evaluate(async (identities: any[], remoteProfile: { displayName: string; avatarDataUrl: string }) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    const remote = identities[2];
    await api.storage.local.set({ '1warden.accounts': JSON.stringify(identities),
      [`profile.v1.${JSON.stringify([remote.serverUrl, remote.email])}`]: JSON.stringify(remoteProfile) });
  }, [{ serverUrl, email }, other, remote], remoteProfile);
  await page.close(); await open('main li button');
  await homeProfile('更新后的用户', saved.profile.avatarDataUrl, 'multiple saved accounts');
  check(await page.evaluate((targets: { serverUrl: string; email: string }[]) => targets.every(target => {
    const row = [...document.querySelectorAll<HTMLButtonElement>('main li button')].find(button =>
      button.textContent?.includes(target.email) && button.textContent?.includes(new URL(target.serverUrl).host));
    return !!row && !row.querySelector('img') && !row.textContent?.includes('更新后的用户')
      && row.querySelector('span')?.textContent?.trim() === target.email[0]?.toUpperCase();
  }), [other]), 'home fallback does not borrow another account avatar or name across email identities');
  await page.waitForFunction((expected: { email: string; host: string; name: string; avatar: string }) => {
    const row = [...document.querySelectorAll<HTMLButtonElement>('main li button')].find(button =>
      button.textContent?.includes(expected.email) && button.textContent?.includes(expected.host));
    const image = row?.querySelector('img');
    return row?.textContent?.includes(expected.name) && !row.textContent?.includes('更新后的用户')
      && image?.complete && image.naturalWidth > 0 && image.src === expected.avatar;
  }, { timeout: 5000 }, { email, host: new URL(remote.serverUrl).host, name: remoteProfile.displayName, avatar: remoteProfile.avatarDataUrl });
  check(true, 'same email on a different server shows its own cached avatar and display name');
  await pickHome(); await page.waitForSelector('.nav-trigger');
  if (!firefox) {
    await page.click('.nav-trigger');
    await page.waitForFunction(() => document.querySelector('.nav-drawer-panel')!.getBoundingClientRect().x >= -0.5);
    await page.click('[aria-label="账户菜单"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-switch-account]').length === 2);
    await page.screenshot({ path: join(output, 'account-menu.png') });
    const target = await page.evaluateHandle((targetEmail: string) => Array.from(document.querySelectorAll('[data-switch-account]'))
      .find((b) => JSON.parse(b.getAttribute('data-switch-account')!)[1] === targetEmail), other.email);
    await target.asElement().click(); await target.dispose();
    await page.waitForSelector('input[type="password"]');
  } else check((await rpc('switchAccount', [other])).ok, 'Zen trusted bridge selects another account');
  let switched = (await rpc('snapshot')).result;
  check(switched.status === 'locked' && switched.account.email === other.email && switched.items.length === 0 && switched.profile === null,
    'same-server account switch locks and isolates prior data');
  check(await page.evaluate(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return !(await api.storage.session.get('1warden.connectionDraft'))['1warden.connectionDraft'];
  }), 'switching accounts never creates a transient login draft');
  await page.close(); await open('input[type="password"]');
  check((await rpc('snapshot')).result.account.email === other.email, 'selected locked account survives popup reopen');
  check((await rpc('switchAccount', [remote])).ok, 'selects same email on a different backend');
  switched = (await rpc('snapshot')).result;
  check(switched.account.serverUrl === remote.serverUrl && switched.profile?.displayName === remoteProfile.displayName
    && switched.profile?.avatarDataUrl === remoteProfile.avatarDataUrl && switched.status === 'locked' && switched.items.length === 0,
    'different backend uses a distinct locked identity with only its own cached profile');
  check((await rpc('switchAccount', [{ serverUrl, email }])).ok, 'switches back to original identity');
  check((await rpc('snapshot')).result.status === 'unlocked' && (await rpc('snapshot')).result.profile.displayName === '更新后的用户', 'switching restores the original unlocked profile');
  check(authenticationRequests === authenticationsBeforeSwitch, 'switching back does not authenticate or ask for a password');
  await menuAction('添加账户');
  await page.waitForSelector('input[type="email"]');
  check(await page.$eval('input[type="email"]', (input: HTMLInputElement) => input.value) === '', 'menu Add Account opens an empty connection form');
  await text('input[type="email"]', 'unsubmitted@example.invalid');
  await text('input[type="password"]', 'never-save-this-password');
  if (!firefox) await page.screenshot({ path: join(output, 'add-account-with-back.png') });
  await back(); await pickHome(); await page.waitForSelector('.nav-trigger');
  check((await rpc('snapshot')).result.status === 'unlocked' && (await rpc('snapshot')).result.account.email === email,
    'cancel Add Account returns home and can reenter the original unlocked vault');
  check(authenticationRequests === authenticationsBeforeSwitch, 'cancelling does not authenticate the old account');
  await menuAction('添加账户');
  await page.waitForSelector('input[type="email"]');
  check(await page.$eval('input[type="password"]', (input: HTMLInputElement) => input.value) === '', 'abandoned master password is cleared');
  rejectAuthentication = true;
  await text('input[type="url"]', serverUrl);
  await text('input[type="email"]', 'failed-add@example.invalid');
  await text('input[type="password"]', 'synthetic-failure-password');
  await page.evaluate(() => (document.querySelector('button[type="submit"]') as HTMLButtonElement).click());
  await page.waitForSelector('[role="alert"]');
  await page.close(); await open('input[type="email"]');
  check(await page.$eval('input[type="email"]', (input: HTMLInputElement) => input.value) === 'failed-add@example.invalid', 'failed Add Account fields survive popup reopen');
  rejectAuthentication = false;
  await back(); await pickHome(); await page.waitForSelector('.nav-trigger');
  check((await rpc('snapshot')).result.status === 'unlocked' && authenticationRequests === authenticationsBeforeSwitch,
    'Back after failed login and popup reopen restores the original session');
  await menuAction('添加账户');
  await page.close(); await open('input[type="email"]');
  check(await page.$eval('input[type="email"]', (i: HTMLInputElement) => i.value) === '', 'add-account opens an empty connection form');
  await rpc('switchAccount', [{ serverUrl, email }]);
  check((await rpc('logout')).ok, 'logout completes');
  check(await page.evaluate(async (account: { serverUrl: string; email: string }, remote: { serverUrl: string; email: string }) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    const values = await api.storage.local.get(null);
    return !values[`profile.v1.${JSON.stringify([account.serverUrl, account.email])}`]
      && !!values[`profile.v1.${JSON.stringify([remote.serverUrl, remote.email])}`];
  }, { serverUrl, email }, remote), 'logout removes only this account presentation cache and preserves another server identity');
  console.log(`${checks} checks passed. Artifacts: ${output}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    console.error('Synthetic fixture failure:', await page.evaluate(() => document.body.innerText).catch(() => 'page unavailable'));
  }
  console.error(`Artifacts: ${output}`);
  throw error;
} finally {
  if (realUpstream && cleanupId && cleanupHeaders) {
    const removed = await fetch(`${realUpstream}/api/ciphers/${cleanupId}`, { method: 'DELETE', headers: cleanupHeaders });
    if (!removed.ok) throw Error(`Could not clean temporary Profile: ${removed.status}`);
    console.log('Removed temporary real-server Profile');
  }
  await browser?.close(); server.stop(true); rmSync(directory, { recursive: true, force: true });
}
