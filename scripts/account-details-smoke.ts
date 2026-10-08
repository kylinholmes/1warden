#!/usr/bin/env bun
/** Isolated Edge/native WebView + synthetic loopback vault. Never opens personal vault data. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { deriveMasterKey, stretchMasterKey, makeUserKey } from '../packages/crypto/src/index';
import { decryptCipher, parseProfile, parseProfileSettings } from '../packages/vault/src/index';
import { createFakeServer } from '../packages/vault/src/testing/fake-server';
import { connectNativeBrowser } from './native-smoke-startup.mjs';

const native = process.argv.includes('--native');
const { default: puppeteer } = await import(pathToFileURL(process.env.ONEWARDEN_PUPPETEER!).href);
const output = mkdtempSync(join(tmpdir(), '1warden-account-details-'));
const userKey = makeUserKey();
const email = 'account-details@example.invalid'; const masterPassword = 'Synthetic-Account-Details!42';
let ciphers: any[] = []; const writes: any[] = []; let sequence = 0; let rejectWrite = false;
let fake: ReturnType<typeof createFakeServer>;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/ciphers') && ['POST', 'PUT'].includes(request.method)) {
    if (rejectWrite) return Response.json({ message: 'Synthetic write failure' }, { status: 503 });
    const body = await request.json(); const old = ciphers[0];
    if (old && body.lastKnownRevisionDate !== old.revisionDate) return Response.json({ message: 'Stale revision: refresh required' }, { status: 409 });
    if (body.notes.length > 10000) return Response.json({ message: 'Note too large' }, { status: 400 });
    const now = new Date(Date.now() + ++sequence).toISOString();
    ciphers = [{ ...body, id: old?.id ?? 'account-record', creationDate: old?.creationDate ?? now, revisionDate: now }];
    writes.push({ method: request.method, body }); return Response.json(ciphers[0]);
  }
  return fake.fetchImpl(request.url, { method: request.method });
} });
const serverUrl = `http://127.0.0.1:${server.port}`;
fake = createFakeServer({ userKey, stretchedMasterKey: await stretchMasterKey(await deriveMasterKey(masterPassword, email, { kdf: 0, iterations: 1000 })),
  override: path => path === '/api/sync' ? Response.json({ profile: { id: 'qa-user', email }, ciphers, folders: [], collections: [] })
    : path === '/api/accounts/revision-date' ? new Response(String(Date.now())) : undefined });
const browsers: any[] = []; let ownApp: ReturnType<typeof spawn> | undefined;
const checks: string[] = []; const errors: string[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function check(name: string, pass: unknown) { if (!pass) throw Error(name); checks.push(name); console.log(`PASS ${name}`); }
async function until(fn: () => Promise<unknown> | unknown, name: string) { for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(100); } throw Error(name); }
async function read() { return decryptCipher(ciphers[0], userKey); }
async function text(page: any, selector: string, value: string) {
  await page.$eval(selector, (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function button(page: any, label: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
  const handle = await page.evaluateHandle((label: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label && b.getClientRects().length), label);
  if (!handle.asElement()) throw Error(`Missing button: ${label}`);
  await handle.asElement().click(); await handle.dispose();
}
async function closeSettings(page: any) {
  const active = '.floating-layer[data-open="true"] [aria-labelledby="settings-title"]';
  for (let depth = 0; depth < 2 && await page.$(active); depth++) {
    await page.click(`${active} .page-header [data-page-back]`);
  }
  await page.waitForSelector('[aria-labelledby="settings-title"]', { hidden: true });
}
async function login(page: any) {
  await page.waitForSelector('[data-add-server]');
  check('fresh installation has a first-server empty state', await page.$eval('h1', (node: Element) => node.textContent === '添加服务器，开始使用')
    && await page.$eval('[data-add-server]', (node: Element) => node.textContent?.trim() === '添加第一个服务器'));
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-brand-mark]')].some(img => img.complete && img.naturalWidth > 0));
  check('home production logo decodes under the real platform CSP', true);
  await button(page, '添加第一个服务器');
  await page.waitForSelector('input[type="email"]');
  await text(page, 'input[type="url"]', serverUrl); await text(page, 'input[type="email"]', email);
  await text(page, 'input[type="password"]', masterPassword); await page.click('button[type="submit"]');
  await page.waitForSelector('[aria-label="账户菜单"]');
  await until(async () => ciphers.length && parseProfileSettings(await read()).devices.length > 0, 'automatic device registration');
}
async function openDetails(page: any) {
  console.log('Opening user details');
  if (await page.$('[aria-labelledby="settings-title"]')) await closeSettings(page);
  const trigger = await page.$('.nav-trigger'); if (trigger && await trigger.isVisible()) await trigger.click();
  if (trigger && await trigger.isVisible()) await page.waitForFunction(() => document.querySelector('.nav-drawer-panel')!.getBoundingClientRect().left >= 0);
  await page.click('[aria-label="账户菜单"]'); await button(page, '用户详情');
  await page.waitForSelector('#profile-link-edit').catch(async (error: unknown) => {
    await page.screenshot({ path: join(output, 'details-open-failure.png') });
    console.log('Details state:', await page.evaluate(() => ({ text: document.body.innerText, errors: [...document.querySelectorAll('[role="alert"]')].map(n => n.textContent) })));
    throw error;
  });
}
async function section(page: any, id: string) {
  console.log(`Opening section: ${id}`);
  if (id === 'preferences') {
    const trigger = await page.$('.nav-trigger');
    if (trigger && await trigger.isVisible()) { await trigger.click(); await page.waitForFunction(() => document.querySelector('.nav-drawer-panel')!.getBoundingClientRect().left >= 0); }
    await page.click('[aria-label="账户菜单"]'); await button(page, '设置');
    await page.waitForSelector('.floating-layer[data-open="true"] [aria-labelledby="settings-title"]');
    if (await page.$('#settings-link-appearance')) await page.click('#settings-link-appearance');
    else await page.click('#settings-tab-appearance');
    await page.waitForSelector('.palette-trigger'); return;
  }
  if (await page.$('[aria-labelledby="settings-title"]')) await closeSettings(page);
  if (!(await page.$('[aria-label="用户详情"]'))) await openDetails(page);
  if (!(await page.$(`#profile-link-${id}`))) await page.click('[aria-label="返回用户详情"]');
  await page.click(`#profile-link-${id}`);
}
async function home(page: any) {
  const trigger = await page.$('.nav-trigger'); if (trigger && await trigger.isVisible()) { await trigger.click(); await page.waitForFunction(() => document.querySelector('.nav-drawer-panel')!.getBoundingClientRect().left >= 0); }
  await page.click('[aria-label="账户菜单"]');
  check('account menu has no redundant account-home action', await page.$eval('#profile-account-menu', (node: Element) => !node.textContent?.includes('返回账户首页')));
  await button(page, '添加账户');
  await page.waitForSelector('input[type="email"]'); await page.click('[aria-label="返回上一级"]');
  await page.waitForFunction(() => document.body.textContent?.includes('选择要连接的账户'));
  check('saved-account home offers connecting another server', await page.$eval('[data-add-server]', (node: Element) => node.textContent?.trim() === '连接其他服务器'));
}
async function pickAccount(page: any) {
  await page.waitForFunction((email: string) => [...document.querySelectorAll<HTMLButtonElement>('main button')].some(b => b.textContent?.includes(email) && !b.disabled), {}, email);
  const handle = await page.evaluateHandle((email: string) => [...document.querySelectorAll('main button')].find(b => b.textContent?.includes(email)), email);
  await handle.asElement().click(); await handle.dispose();
}
async function homeProfile(page: any, profile: { displayName: string | null; avatarDataUrl: string | null }, stage: string) {
  await page.waitForSelector('main li button');
  await page.waitForFunction((expected: { email: string; host: string; displayName: string; avatarDataUrl: string }) => {
    const row = [...document.querySelectorAll<HTMLButtonElement>('main li button')]
      .find(button => button.textContent?.includes(expected.email) && button.textContent?.includes(expected.host));
    const image = row?.querySelector('img');
    return row?.textContent?.includes(expected.displayName) && image?.complete && image.naturalWidth > 0 && image.src === expected.avatarDataUrl;
  }, { timeout: 5000 }, { email, host: new URL(serverUrl).host, displayName: profile.displayName, avatarDataUrl: profile.avatarDataUrl });
  check(`${stage}: home displays decoded saved avatar, name, email and server`, true);
}
async function extensionPage(name: string) {
  console.log(`Starting isolated extension: ${name}`);
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.ONEWARDEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    userDataDir: join(output, name), enableExtensions: true, pipe: process.platform !== 'win32' }); browsers.push(browser);
  console.log('Browser ready');
  const id = await browser.installExtension(resolve('apps/desktop/dist-extension'));
  console.log('Extension installed');
  const page = await browser.newPage(); page.setDefaultTimeout(10000); await page.setViewport({ width: 440, height: 600 });
  page.on('pageerror', (e: Error) => errors.push(e.message)); await page.goto(`chrome-extension://${id}/popup.html`);
  console.log('Extension page ready');
  return page;
}
async function nativePage() {
  const portServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); const port = portServer.port; portServer.stop(true);
  ownApp = spawn(process.env.ONEWARDEN_NATIVE_EXE!, [], { windowsHide: true, env: { ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: join(output, 'native-profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` } });
  const browser = await connectNativeBrowser({ app: ownApp, connect: (options: any) => puppeteer.connect(options), browserURL: `http://127.0.0.1:${port}` });
  browsers.push(browser);
  let page: any; await until(async () => { page = (await browser.pages()).find((p: any) => p.url() === 'http://tauri.localhost/'); return page; }, 'native main page');
  page.setDefaultTimeout(10000); page.on('pageerror', (e: Error) => errors.push(e.message)); return page;
}
const rpc = (page: any, method: string, args: unknown[] = []) => page.evaluate((method: string, args: unknown[]) =>
  (globalThis as any).chrome.runtime.sendMessage({ type: '1warden:application', method, args }), method, args);
try {
  const page = native ? await nativePage() : await extensionPage('device-a');
  await login(page);
  check('vault sidebar has no duplicated home or profile destinations', await page.$$eval('[data-key]', (items: Element[]) =>
    items.every(item => !['home', 'profile'].includes(item.getAttribute('data-key') ?? ''))));
  await home(page); await pickAccount(page); await page.waitForSelector('[aria-label="搜索条目"]');
  check('account picker is home and returning preserves the unlocked session', !(await page.$('#unlock-password')));
  await openDetails(page);
  check('user details directory contains only profile and devices, not appearance', await page.$$eval('[id^="profile-link-"]', (items: Element[]) =>
    items.map(item => item.id).join(',') === 'profile-link-edit,profile-link-devices'));
  await section(page, 'devices');
  await page.waitForFunction(() => document.body.textContent?.includes('本机'));
  check('user details shows the current device', true);
  check('automatic registration creates only one encrypted special record', ciphers.length === 1 && writes[0].body.notes.startsWith('2.'));
  await section(page, 'edit');
  check('profile is a main-content page, not a settings modal', !(await page.$('[role="dialog"]')));
  await text(page, '#profile-name', '裁剪与同步测试');
  const source = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 300;
    const ctx = canvas.getContext('2d')!;
    for (const [i, color] of ['#ef2020', '#20d040', '#2040ef'].entries()) { ctx.fillStyle = color; ctx.fillRect(i * 300, 0, 300, 300); }
    return canvas.toDataURL('image/png');
  });
  const imagePath = join(output, 'synthetic-bands.png'); writeFileSync(imagePath, Buffer.from(source.split(',')[1], 'base64'));
  await (await page.$('input[type="file"]')).uploadFile(imagePath);
  await page.waitForSelector('.avatar-crop-frame');
  check('local PNG decodes into the crop editor under the actual app CSP', await page.$eval('.avatar-crop-frame img', (img: HTMLImageElement) => img.complete && img.naturalWidth === 900 && img.src.startsWith('data:')));
  await page.keyboard.press('Escape'); await page.waitForSelector('.avatar-crop-frame', { hidden: true });
  check('Escape cancels only crop and preserves the name draft', await page.$eval('#profile-name', (input: HTMLInputElement) => input.value === '裁剪与同步测试'));
  await (await page.$('input[type="file"]')).uploadFile(imagePath); await page.waitForSelector('.avatar-crop-frame');
  const box = await (await page.$('.avatar-crop-frame')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x - box.width / 2, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
  await text(page, '#avatar-zoom', '2');
  await page.screenshot({ path: join(output, native ? 'native-crop.png' : 'extension-crop.png') });
  await button(page, '使用此头像');
  await until(async () => parseProfile(await read()).displayName === '裁剪与同步测试' && parseProfile(await read()).avatarDataUrl, 'automatic profile save');
  check('profile saves automatically with visible confirmation', await page.waitForFunction(() => document.body.textContent?.includes('已同步')));
  const saved = parseProfile(await read());
  check('compressed cropped avatar fits the shared note budget', saved.avatarDataUrl!.length <= 3600);
  const pixels = await page.evaluate(async (src: string) => {
    const image = new Image(); image.src = src; await image.decode();
    const c = document.createElement('canvas'); c.width = 1; c.height = 1; const ctx = c.getContext('2d')!;
    ctx.drawImage(image, image.width / 2, image.height / 2, 1, 1, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data];
  }, saved.avatarDataUrl);
  check('saved pixels match the dragged blue region, not the old center crop', pixels[2] > 180 && pixels[0] < 80);
  const beforeBad = writes.length;
  await page.evaluate(() => {
    const files = new DataTransfer(); files.items.add(new File(['not an image'], 'bad.png', { type: 'image/png' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement; input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForSelector('[role="alert"]');
  check('invalid image reports an error without changing the saved avatar', writes.length === beforeBad && parseProfile(await read()).avatarDataUrl === saved.avatarDataUrl);
  await home(page); await homeProfile(page, saved, 'after saving and returning');
  if (!native) {
    await page.reload(); await homeProfile(page, saved, 'after reopening the account page');
  }
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
  await page.screenshot({ path: join(output, native ? 'native-home-avatar.png' : 'extension-home-avatar.png') });
  await pickAccount(page); await page.waitForSelector('[aria-label="搜索条目"]');
  await section(page, 'preferences');
  await page.click('.appearance-mode:has(.mode-dark)'); await page.click('.palette-trigger'); await page.click('[role="option"][id$="-dracula"]');
  await button(page, '隐藏');
  await until(async () => { const p = parseProfileSettings(await read()).preferences; return p?.palette === 'dracula' && p.mode === 'dark' && !p.showTypes; }, 'automatic preference save');
  check('preferences and device history coexist with the saved avatar', parseProfile(await read()).avatarDataUrl === saved.avatarDataUrl && parseProfileSettings(await read()).devices.length === 1);
  const second = await extensionPage('device-b'); await login(second);
  await until(async () => parseProfileSettings(await read()).devices.length === 2, 'second installation registration');
  await second.waitForFunction(() => document.documentElement.dataset.palette === 'dracula' && document.documentElement.dataset.theme === 'dark');
  check('fresh second installation decrypts and applies account appearance', true);
  await openDetails(second); await section(second, 'edit');
  check('second installation receives the synced profile', await second.$eval('#profile-name', (i: HTMLInputElement) => i.value === '裁剪与同步测试'));
  await section(second, 'devices');
  check('second installation receives both device entries', await second.$$eval('#account-devices-heading + p + div > div', (rows: Element[]) => rows.length === 2));
  await second.$eval('#account-devices-heading', (node: HTMLElement) => node.scrollIntoView({ block: 'start' }));
  await second.screenshot({ path: join(output, 'user-details-devices.png') });
  await section(second, 'preferences'); await second.click('.palette-trigger'); await second.click('[role="option"][id$="-github"]');
  await until(async () => parseProfileSettings(await read()).preferences?.palette === 'github', 'second automatic save');
  if (!native) {
    const stale = await rpc(page, 'savePreferences', [{ mode: 'light', palette: 'ayu', showTypes: true }, { mode: 'dark', palette: 'dracula', showTypes: false }]);
    check('stale first device cannot overwrite the newer account record', !stale.ok && parseProfileSettings(await read()).preferences?.palette === 'github');
    const lock = await rpc(page, 'lock'); check('lock removes decrypted device details', lock.ok && !(await rpc(page, 'snapshot')).result.profileSettings);
    await button(page, '返回首页'); await homeProfile(page, saved, 'locked account returning home');
    await pickAccount(page); await page.waitForSelector('#unlock-password');
    check('unlock has a home return path without deleting the account', (await rpc(page, 'snapshot')).result.account?.email === email);
    await button(page, '返回首页'); await button(page, '连接其他服务器');
    await page.waitForSelector('input[type="email"]'); await page.click('[aria-label="返回上一级"]');
    await page.waitForFunction(() => document.body.textContent?.includes('选择要连接的账户'));
    check('connection form can return home without logging in', true);
  }
  rejectWrite = true;
  await second.click('.palette-trigger'); await second.click('[role="option"][id$="-ayu"]');
  await second.waitForSelector('[role="alert"]');
  check('failed settings save does not claim synchronization or overwrite server state', parseProfileSettings(await read()).preferences?.palette === 'github'); rejectWrite = false;
  await section(second, 'edit'); await section(second, 'preferences');
  check('failed preference draft survives leaving and returning to its page', await second.$eval('.palette-trigger', (node: Element) => node.textContent?.includes('Ayu')) && await second.$('[role="alert"]'));
  await button(second, '重试保存'); await until(async () => parseProfileSettings(await read()).preferences?.palette === 'ayu', 'retry saved preferences');
  await section(second, 'edit'); await text(second, '#profile-name', '离开页面自动保存');
  await second.click('[aria-label="返回用户详情"]'); await second.click('[aria-label="返回保险库"]');
  await until(async () => parseProfile(await read()).displayName === '离开页面自动保存', 'draft survives navigation');
  check('leaving the editor does not lose the latest name change', true);
  await openDetails(second);
  // Toolbar popups intentionally have a 440x600 intrinsic body (also needed by Firefox).
  // Test the genuinely resizable native surface at 360px, not an artificial clipped popup.
  const narrow = native ? page : second;
  if (native) await narrow.setViewport({ width: 360, height: 640 });
  await section(narrow, 'edit');
  await (await narrow.$('input[type="file"]')).uploadFile(imagePath); await narrow.waitForSelector('.avatar-crop-frame');
  await narrow.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
  check(`${native ? 360 : 440}px crop editor fits the viewport`, await narrow.$eval('.avatar-crop-frame', (node: HTMLElement) => {
    const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
  }));
  await narrow.screenshot({ path: join(output, 'crop-narrow.png') });
  await narrow.keyboard.press('Escape');
  check('server only sees encrypted account metadata', writes.every(w => w.body.notes.startsWith('2.') && !JSON.stringify(w).includes('裁剪与同步测试') && !JSON.stringify(w).includes('Windows ·')));
  check('no application runtime errors', errors.length === 0);
  writeFileSync(join(output, 'report.json'), JSON.stringify({ native, checks, errors }, null, 2));
  console.log(`PASS ${checks.length} account details checks; ${output}`);
} catch (error) {
  console.log('Failure artifacts:', output);
  for (const browser of browsers) for (const page of await browser.pages()) {
    if (!page.url().includes('popup.html') && page.url() !== 'http://tauri.localhost/') continue;
    console.log('Page state:', await page.evaluate(() => ({ text: document.body.innerText, active: document.activeElement?.tagName, drawer: document.querySelector('.nav-trigger')?.outerHTML })));
    await page.screenshot({ path: join(output, `failure-${browsers.indexOf(browser)}.png`) });
  }
  throw error;
} finally {
  for (const browser of browsers.reverse()) { if (native && !browser.process()) await browser.disconnect(); else await browser.close(); }
  if (ownApp && ownApp.exitCode === null) ownApp.kill(); server.stop(true);
}
