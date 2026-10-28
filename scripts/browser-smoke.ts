#!/usr/bin/env bun
/**
 * Built-extension smoke in real Chrome/Firefox, with disposable profiles and an
 * in-memory synthetic vault. No development server/account or personal profile.
 * See apps/desktop/extension/README.md for browser/tool setup.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import type { VaultItem } from '../packages/vault/src/model';
import { encryptCipher } from '../packages/vault/src/encrypt';
import { decryptCipher, decryptFolder } from '../packages/vault/src/decrypt';
import type { CipherDto } from '../packages/api/src/types';
import type { CapturePreview } from '../apps/desktop/src/application/browser-credentials';
import { generateTotp } from '../packages/crypto/src/totp';

const ROOT = resolve(import.meta.dir, '..');
const product = process.argv[2];
if (!['chrome', 'firefox', 'edge', 'zen'].includes(product ?? '')) throw new Error('Usage: bun scripts/browser-smoke.ts chrome|firefox|edge|zen');
const name = product === 'edge' || product === 'chrome' ? 'chrome' : 'firefox';
const engine = name === 'chrome' ? 'Chromium' : 'Gecko';
const localDefaults: Record<string, string> = {
  edge: process.platform === 'win32'
    ? join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')
    : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  zen: '/Applications/Zen.app/Contents/MacOS/zen',
};
const executable = process.env[`ONEWARDEN_${product!.toUpperCase()}`] ?? localDefaults[product!];
if (!executable || !existsSync(executable)) throw new Error(`Set ONEWARDEN_${product!.toUpperCase()} to the browser executable`);
const modulePath = process.env.ONEWARDEN_PUPPETEER;
// Kept outside the application dependency tree: this is an optional browser tool.
const { default: puppeteer } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'puppeteer-core');
const dist = join(ROOT, 'apps/desktop', name === 'chrome' ? 'dist-extension' : 'dist-firefox');
if (!existsSync(join(dist, 'manifest.json'))) throw new Error(`Build the extension first: ${dist}`);
function packageFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) return packageFiles(join(directory, entry.name), relative);
    return entry.isFile() && !entry.name.endsWith('.map') ? [relative] : [];
  });
}
const buildHashes = Object.fromEntries(packageFiles(dist).sort().map((file) => [
  file, createHash('sha256').update(readFileSync(join(dist, file))).digest('hex'),
]));
const artifacts = resolve(process.env.ONEWARDEN_SMOKE_OUT ?? join(tmpdir(), `onewarden-browser-smoke-${Date.now()}`));
mkdirSync(artifacts, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), `onewarden-smoke-${product}-`));
const downloads = join(profile, 'downloads');
mkdirSync(downloads);
const firefoxUuid = 'f69448ed-9c3e-44ad-876b-950aab9a0cab';
const checks: string[] = [];
const errors: string[] = [];
let version = '';
let userAgent = '';
let failure = '';
const attachmentContent = Buffer.from('Synthetic attachment bytes\n\0\xff', 'utf8');
function encryptFixture(bytes: Uint8Array, encByte: number, macByte: number): string {
  const iv = Buffer.alloc(16, 31);
  const cipher = createCipheriv('aes-256-cbc', Buffer.alloc(32, encByte), iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const mac = createHmac('sha256', Buffer.alloc(32, macByte)).update(iv).update(encrypted).digest();
  return `2.${iv.toString('base64')}|${encrypted.toString('base64')}|${mac.toString('base64')}`;
}
const attachmentParts = encryptFixture(attachmentContent, 41, 43).slice(2).split('|');
const encryptedAttachment = Buffer.concat([Buffer.from([2]), Buffer.from(attachmentParts[0]!, 'base64'),
  Buffer.from(attachmentParts[2]!, 'base64'), Buffer.from(attachmentParts[1]!, 'base64')]);
const attachmentKey = encryptFixture(Buffer.concat([Buffer.alloc(32, 41), Buffer.alloc(32, 43)]), 17, 23);
const folderRequests: unknown[] = [];
const folderCreates: { name: string }[] = [];
let rejectFolderMove = false;
const cipherWrites: CipherDto[] = [];
const cipherCreates: CipherDto[] = [];
const mergeTrashRequests: string[] = [];
const savedDtos = new Map<string, CipherDto>();

function check(label: string, passed: boolean, diagnostic = ''): void {
  if (!passed) throw new Error(`${label}${diagnostic ? `: ${diagnostic}` : ''}`);
  checks.push(label);
  console.log(`  ✓ ${label}`);
}

const site = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/accounts/revision-date') return Response.json(1);
    if (url.pathname === '/api/sync') {
      // Returning from another tab triggers focus sync. Serve the same synthetic
      // vault instead of treating that legitimate request as a network failure.
      return Response.json({ profile: { id: account.userId }, collections: [],
        folders: seed.folders.map(folder => ({ id: folder.id, name: encryptFixture(Buffer.from(folder.name), 17, 23),
          revisionDate: folder.updatedAt })),
        ciphers: await Promise.all(seed.items.map(async record => ({
          ...await encryptCipher(record, { encKey: Buffer.alloc(32, 17), macKey: Buffer.alloc(32, 23) }, {}),
          id: record.id, creationDate: record.createdAt, revisionDate: record.updatedAt,
          deletedDate: record.deletedAt, archivedDate: record.archivedAt,
          attachments: record.attachments.map(attachment => ({ ...attachment,
            fileName: encryptFixture(Buffer.from(attachment.fileName), 17, 23) })),
        }))),
      });
    }
    if (url.pathname === '/api/ciphers' && request.method === 'POST') {
      const body = await request.json() as CipherDto;
      // Request-only concurrency/owner fields are not part of CipherDto responses.
      const { encryptedFor: _owner, lastKnownRevisionDate: _revision, ...responseBody } = body as CipherDto & { encryptedFor?: string; lastKnownRevisionDate?: string };
      const dto = { ...responseBody, id: `smoke-registration-${cipherCreates.length + 1}`,
        creationDate: new Date().toISOString(), revisionDate: new Date().toISOString(),
        deletedDate: null, archivedDate: null, attachments: [] };
      const record = await decryptCipher(dto, { encKey: Buffer.alloc(32, 17), macKey: Buffer.alloc(32, 23) });
      cipherCreates.push(body); savedDtos.set(record.id, dto); seed.items.push(record);
      return Response.json(dto);
    }
    if (url.pathname === '/api/folders' && request.method === 'POST') {
      const body = await request.json() as { name: string };
      folderCreates.push(body);
      const dto = { id: `smoke-created-${folderCreates.length}`, name: body.name, revisionDate: '2026-10-09T16:05:00Z' };
      seed.folders.push(await decryptFolder(dto, { encKey: Buffer.alloc(32, 17), macKey: Buffer.alloc(32, 23) }));
      return Response.json(dto);
    }
    if (url.pathname === '/api/ciphers/move' && request.method === 'POST') {
      const body = await request.json() as { folderId: string | null; ids: string[] };
      folderRequests.push(body);
      if (rejectFolderMove) return Response.json({ message: 'Synthetic folder move rejected' }, { status: 403 });
      for (const record of seed.items) if (body.ids.includes(record.id)) {
        record.folderId = body.folderId; record.updatedAt = '2026-10-09T16:00:00Z';
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith('/partial') && request.method === 'PUT') {
      const record = seed.items.find(record => url.pathname === `/api/ciphers/${record.id}/partial`);
      if (record) {
        const body = await request.json() as { folderId?: string | null; favorite: boolean };
        record.folderId = body.folderId ?? null; record.favorite = body.favorite;
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname.endsWith('/delete') && request.method === 'PUT') {
      const record = seed.items.find(record => url.pathname === `/api/ciphers/${record.id}/delete`);
      if (record) {
        record.deletedAt = new Date().toISOString();
        const saved = savedDtos.get(record.id);
        if (saved) savedDtos.set(record.id, { ...saved, deletedDate: record.deletedAt });
        mergeTrashRequests.push(record.id);
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname.startsWith('/api/ciphers/') && request.method === 'PUT') {
      const index = seed.items.findIndex(record => url.pathname === `/api/ciphers/${record.id}`);
      if (index >= 0) {
        const record = seed.items[index]!;
        const body = await request.json() as CipherDto;
        const { encryptedFor: _owner, lastKnownRevisionDate: _revision, ...responseBody } = body as CipherDto & { encryptedFor?: string; lastKnownRevisionDate?: string };
        const dto = { ...responseBody, id: record.id, creationDate: record.createdAt, revisionDate: new Date().toISOString(),
          deletedDate: null, archivedDate: null, attachments: record.attachments.map(attachment => ({
            ...attachment, fileName: encryptFixture(Buffer.from(attachment.fileName), 17, 23),
          })) };
        seed.items[index] = await decryptCipher(dto, { encKey: Buffer.alloc(32, 17), macKey: Buffer.alloc(32, 23) });
        cipherWrites.push(body); savedDtos.set(record.id, dto);
        return Response.json(dto);
      }
    }
    if (url.pathname.startsWith('/api/ciphers/') && request.method === 'GET') {
      const record = seed.items.find(record => url.pathname === `/api/ciphers/${record.id}`);
      if (record) {
        const saved = savedDtos.get(record.id);
        if (saved) return Response.json(saved);
        const body = await encryptCipher(record, { encKey: Buffer.alloc(32, 17), macKey: Buffer.alloc(32, 23) }, {});
        return Response.json({ ...body, id: record.id, creationDate: record.createdAt, revisionDate: record.updatedAt,
          deletedDate: null, archivedDate: null, attachments: record.attachments.map(attachment => ({
            ...attachment, fileName: encryptFixture(Buffer.from(attachment.fileName), 17, 23),
          })) });
      }
    }
    if (url.pathname === '/attachment') return new Response(encryptedAttachment);
    if (url.pathname === '/api/ciphers/smoke-alpha/attachment/smoke-file') {
      return Response.json({ id: 'smoke-file', url: `${url.origin}/attachment` });
    }
    if (url.pathname !== '/login') return new Response('', { status: 404 });
    return new Response(`<!doctype html><html><meta charset="utf-8"><title>Smoke login</title>
      <form><label>Email<input id="email" type="email" autocomplete="username"></label>
      <label>Password<input id="password" type="password" autocomplete="current-password"></label>
      <button type="submit">Sign in</button></form>
      <script>document.querySelector('form').onsubmit=e=>e.preventDefault()</script></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
});
const siteUrl = `http://127.0.0.1:${site.port}/login`;
const secret = 'Synthetic-Smoke-Password-Only!42';
const username = 'smoke@example.invalid';
function item(id: string, title: string, date: string): VaultItem {
  return {
    id, name: title, type: 'login', rawType: 1, nameFailed: false, notes: 'Synthetic smoke fixture',
    notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: date, updatedAt: date, deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { username, password: secret, uris: [{ uri: siteUrl, match: 1 }, { uri: 'https://old.example.invalid', match: 0 },
        { uri: 'https://keep.example.invalid', match: 3 }], totp: id === 'smoke-zulu' ? 'JBSWY3DPEHPK3PXP' : null,
      passwordRevisionDate: '2026-01-01T00:00:00Z', fido2Credentials: [] },
    card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [{ name: 'Toggle smoke', value: 'false', type: 2, linkedId: null },
      { name: 'Linked smoke', value: '', type: 3, linkedId: 100 }], passwordHistory: [], attachments: id === 'smoke-alpha' ? [{
      id: 'smoke-file', fileName: 'smoke-attachment.txt', size: String(encryptedAttachment.length), sizeName: '32 B',
      url: `${new URL(siteUrl).origin}/attachment`, key: attachmentKey, failed: false,
    }] : [],
  };
}
const account = { serverUrl: `http://127.0.0.1:${site.port}`, email: username,
  userId: 'synthetic-smoke-user', kdf: { kdf: 0, iterations: 600000 } };
const seed = {
  account, userKey: { encKey: Buffer.alloc(32, 17).toString('base64'), macKey: Buffer.alloc(32, 23).toString('base64') },
  items: [item('smoke-alpha', 'Alpha smoke login', '2026-01-01T00:00:00Z'),
    item('smoke-zulu', 'Zulu smoke login', '2026-02-01T00:00:00Z')],
  folders: [{ id: 'work', name: 'Synthetic Work', nameFailed: false, updatedAt: '2026-01-01T00:00:00Z' }],
  token: { accessToken: 'synthetic-smoke-token', expiresIn: 3600, kdf: 0 }, expiresAt: Date.now() + 15 * 60 * 1000,
};

let browser: any;
let popup: any;
async function screenshot(label: string): Promise<void> {
  // Firefox 156/157 BiDi rejects captureScreenshot for privileged extension pages.
  // Keep interaction assertions active and report this limitation explicitly.
  if (name === 'chrome' && await popup.evaluate(() => document.visibilityState === 'visible')) {
    await popup.evaluate(() => Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {}))));
    await popup.screenshot({ path: join(artifacts, `${product}-${label}.png`) });
  }
}
async function click(selector: string): Promise<void> {
  const textSelector = selector.match(/^(.*)::-p-text\((.*)\)$/);
  // A saved revision remounts SelectedDetail. Resolve each polling frame so a
  // detached pre-save button cannot keep the actionability wait stuck forever.
  const element = await popup.waitForFunction((query: string, text: string | null, native: boolean) => {
    const node = text === null ? document.querySelector<HTMLElement>(query)
      : Array.from(document.querySelectorAll<HTMLElement>(query)).find(node => node.textContent?.trim().startsWith(text));
    if (!node || node.closest('[inert], :disabled')) return false;
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(node).visibility === 'hidden') return false;
    if (native) {
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight
        || hit === null || !node.contains(hit)) return false;
    }
    return node;
  }, {}, textSelector?.[1] ?? selector, textSelector?.[2] ?? null, name === 'chrome');
  try {
    // Gecko BiDi rejects native input on privileged pages. Model pointer focus
    // before DOM activation so scrolling cannot leave focus on an old control.
    if (name === 'firefox') await element.evaluate((button: HTMLElement) => {
      button.focus({ preventScroll: true }); button.click();
    });
    else await element.click();
  } finally { await element.dispose(); }
}
async function type(selector: string, value: string): Promise<void> {
  await popup.waitForSelector(selector, { visible: true });
  if (name === 'chrome') return popup.type(selector, value);
  await popup.$eval(selector, (input: HTMLInputElement, text: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function selectOption(selector: string, value: string): Promise<void> {
  await click(selector);
  const popupId = await popup.$eval(selector, (element: HTMLElement) => element.getAttribute('aria-controls'));
  await click(`[id=${JSON.stringify(popupId)}] [role="option"][data-value=${JSON.stringify(value)}]`);
  await popup.waitForFunction((selector: string) => document.querySelector(selector)?.getAttribute('aria-expanded') === 'false', {}, selector);
}
async function openNavigation(): Promise<void> {
  // Explicit state, not hover or an intermediate slide-animation position.
  const open = await popup.$eval('[aria-label="导航"]', (trigger: Element) => trigger.getAttribute('aria-expanded') === 'true');
  if (!open) {
    await click('button[aria-label="导航"]');
    await popup.waitForFunction(() => document.querySelector('.nav-drawer-panel')!.getBoundingClientRect().left >= 0);
    check('drawer covers the list navigation trigger and has its own reachable close button', await popup.evaluate(() => {
      const trigger = document.querySelector('.nav-trigger')!.getBoundingClientRect();
      const close = document.querySelector('[aria-label="关闭导航"]')?.getBoundingClientRect();
      const covered = document.elementFromPoint(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2)?.closest('.nav-drawer-panel');
      return !!covered && !!close && !!document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2)?.closest('[aria-label="关闭导航"]');
    }));
  }
}
try {
  browser = await puppeteer.launch({
    browser: name, executablePath: executable, userDataDir: profile, headless: process.env.ONEWARDEN_SMOKE_HEADED !== '1',
    enableExtensions: true, ...(name === 'chrome' ? { pipe: process.platform !== 'win32', downloadBehavior: { policy: 'allow', downloadPath: downloads } } : {
      // Firefox 153+ requires this opt-in to automate moz-extension pages.
      args: ['--remote-allow-system-access'],
      extraPrefsFirefox: { 'extensions.webextensions.uuids': JSON.stringify({ '1warden@1warden.app': firefoxUuid }) },
    }),
  });
  version = await browser.version();
  userAgent = await browser.userAgent();
  if (name === 'firefox') await browser.connection.send('browser.setDownloadBehavior', {
    downloadBehavior: { type: 'allowed', destinationFolder: downloads },
  });
  console.log(`${product} (${engine}): ${version}\nExecutable: ${executable}\nArtifacts: ${artifacts}`);
  if (process.env.ONEWARDEN_SMOKE_HEADED === '1') console.log(`Browser PID: ${browser.process()?.pid}`);
  check('correct browser engine', name === 'chrome' ? /(?:Chrome|Edg|Edge)\//i.test(version) : /(?:firefox|zen)\//i.test(version), version);
  const extensionId = await browser.installExtension(dist);
  if (name === 'chrome') {
    const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
    const expectedId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
    check('unpacked extension uses its new stable identity', extensionId === expectedId, extensionId);
  }
  const origin = name === 'chrome' ? `chrome-extension://${extensionId}` : `moz-extension://${firefoxUuid}`;
  const login = await browser.newPage();
  await login.goto(siteUrl);
  popup = await browser.newPage();
  popup.on('pageerror', (error: Error) => errors.push(error.message));
  popup.setDefaultTimeout(15_000);
  await popup.setViewport({ width: 440, height: 600 });
  // Firefox does not emit normal network-navigation events for moz-extension
  // URLs. Wait on its BiDi readiness result, then the actual UI selector.
  const openPopup = async (reload = false) => {
    // Chromium needs a foreground page to finish screenshot animations.
    // Gecko BiDi cannot activate privileged extension pages (no screenshots there).
    if (name === 'chrome') await popup.bringToFront();
    if (name === 'firefox') {
      const context = popup.mainFrame().browsingContext;
      if (reload) await context.reload({ wait: 'interactive' });
      else await context.navigate(`${origin}/popup.html`, 'interactive');
      // Use the extension tab API where BiDi activation is unsupported. After
      // submitting the website, leaving this tab hidden stalls rendering/RAF.
      await popup.evaluate(async () => {
        const api = (globalThis as any).browser;
        const tab = await api.tabs.getCurrent();
        await api.tabs.update(tab.id, { active: true });
      });
    } else if (reload) await popup.reload({ waitUntil: 'domcontentloaded' });
    else await popup.goto(`${origin}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popup.waitForFunction(() => document.visibilityState === 'visible');
  };
  await openPopup();
  await popup.waitForSelector('main button');
  await popup.waitForSelector('[data-add-server]');
  check('empty home offers login and registration', await popup.$eval('[data-add-server]', (node: Element) => node.textContent?.trim() === '登录')
    && await popup.$eval('h1', (node: Element) => node.textContent === '你的密码，从这里开始')
    && await popup.evaluate(() => [...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '注册')));
  await popup.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-brand-mark]')].every(node => node.complete && node.naturalWidth > 0));
  check('production brand asset loads inside extension CSP', await popup.$eval('[data-brand-mark]', (node: HTMLImageElement) => node.complete && node.naturalWidth > 0));
  await screenshot('empty-home-brand');
  await click('[data-add-server]');
  await popup.waitForSelector('input[type="email"]', { visible: true });
  check('shared connect screen renders', await popup.$('input[type="password"]') !== null);
  await screenshot('connect');

  await popup.evaluate(async (fixture: unknown) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    const { serverUrl, email } = (fixture as any).account;
    // Session injection bypasses the login form's remembered-account write.
    await api.storage.local.set({ '1warden.accounts': JSON.stringify([{ serverUrl, email }]) });
    await api.storage.session.set({ '1warden.session': fixture, '1warden.account': (fixture as any).account });
    await api.storage.session.remove('1warden.connectionDraft');
  }, seed);
  await openPopup(true);
  await popup.waitForSelector('[aria-label="搜索条目"]', { visible: true });
  check('reopening an unlocked popup resumes the current vault directly', !(await popup.$('[data-add-server]')));
  // Visit the saved-account picker through its real navigation path.
  await openNavigation();
  await click('[aria-label="账户菜单"]');
  await click('[role="menuitem"]::-p-text(添加账户)');
  await popup.waitForSelector('input[type="email"]', { visible: true });
  await click('[aria-label="返回上一级"]');
  await popup.waitForSelector('main li button');
  check('populated home retains account selection and another-account login', await popup.$eval('h1', (node: Element) => node.textContent === '欢迎回来')
    && await popup.$eval('[data-add-server]', (node: Element) => node.textContent?.trim() === '登录其他账户'));
  await click('main li button');
  await popup.waitForSelector('[aria-label="搜索条目"]', { visible: true });
  check('shared vault renders from background session', true);
  const rpc = async (method: string, args: unknown[] = []) => popup.evaluate(async (m: string, a: unknown[]) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return api.runtime.sendMessage({ type: '1warden:application', method: m, args: a });
  }, method, args);
  const snapshot = await rpc('snapshot');
  check('snapshot contains summaries without passwords or keys', snapshot.ok && snapshot.result.items.length === 2
    && !JSON.stringify(snapshot).includes(secret) && !JSON.stringify(snapshot).includes('userKey'));

  if (name === 'chrome') {
    // Frozen/sleeping tabs can hold executeScript indefinitely. Local browsing must stay responsive.
    const cdp = await login.createCDPSession();
    const targetId = await popup.evaluate(async (url: string) => {
      const api = (globalThis as any).chrome;
      return (await api.tabs.query({})).find((tab: any) => tab.url === url)?.id;
    }, siteUrl);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    const filling = popup.evaluate((tabId: number) => (globalThis as any).chrome.runtime.sendMessage({
      type: '1warden:fill', application: true, itemId: 'smoke-alpha', tabId,
    }), targetId);
    let lookup: any;
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const responsive = await Promise.race([
        Promise.all([rpc('search', ['Alpha']), rpc('getItem', ['smoke-alpha'])])
          .then(([search, detail]) => search.ok && search.result.length === 1 && detail.ok),
        new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      check('search and details respond while a frozen tab blocks filling', responsive === true);
      lookup = await browser.newPage();
      await lookup.goto(siteUrl);
      await lookup.click('#email');
      await lookup.waitForSelector('[data-onewarden-inline][data-state="accounts"]', { visible: true, timeout: 3000 });
      check('another website receives inline accounts while a frozen tab blocks filling', true);
    } finally {
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      await filling;
      await lookup?.close();
      await popup.bringToFront();
      await cdp.detach();
    }
  }

  const rowNames = () => popup.$$eval('.vault-list li > button', (rows: Element[]) => rows.map((row) => row.textContent ?? ''));
  const initialRows = await rowNames();
  check('default date sort puts newest first', initialRows[0]?.includes('Zulu smoke login') === true, JSON.stringify(initialRows));
  await click('[aria-label="排序方式"]');
  await click('[data-select-popup] [role="option"][data-value="name"]');
  await popup.waitForFunction(() => document.querySelector('.vault-list li > button')?.textContent?.includes('Alpha smoke login'));
  check('name sort changes list order', true);
  await type('[aria-label="搜索条目"]', 'Alpha');
  await popup.waitForFunction(() => document.querySelectorAll('.vault-list li > button').length === 1);
  check('search filters shared list', (await rowNames())[0]?.includes('Alpha smoke login') === true);
  await click('.vault-list li > button');
  await popup.waitForSelector('[aria-label="显示密码"]', { visible: true });
  check('detail starts masked', !(await popup.evaluate(() => document.body.textContent)).includes(secret));
  await click('[aria-label="显示密码"]');
  await popup.waitForFunction((value: string) => document.body.textContent?.includes(value), {}, secret);
  check('explicit reveal obtains password through background RPC', true);
  await screenshot('detail-440');
  await click('[aria-label="隐藏密码"]');
  check('hide removes revealed value', !(await popup.evaluate(() => document.body.textContent)).includes(secret));
  const openFolderEditor = () => click('[aria-label="更改文件夹归类"]');
  const waitForFolder = (target: string) => popup.waitForFunction((value: string) => {
    const group = document.querySelector<HTMLElement>('[data-folder-organization]');
    const manage = group?.querySelector<HTMLButtonElement>('[aria-label="更改文件夹归类"]');
    return group?.dataset.folderId === value && group.getAttribute('aria-busy') !== 'true' && manage?.matches(':disabled') === false;
  }, {}, target);
  check('detail shows folder organization and record metadata', await popup.$('[data-folder-organization]') !== null
    && await popup.evaluate(() => ['创建时间', '更新时间', '密码更新', '记录 ID'].every(label => document.body.textContent?.includes(label))));
  await openFolderEditor();
  await selectOption('[data-item-folder]', 'work');
  await waitForFolder('work');
  const filed = await rpc('getItem', ['smoke-alpha']);
  check('detail folder choice updates the real background record and revision', filed.ok
    && filed.result.summary.folderId === 'work' && filed.result.summary.updatedAt === seed.items[0]!.updatedAt);
  check('folder mutation sends only membership and retains masked credentials',
    JSON.stringify(folderRequests[0]) === JSON.stringify({ folderId: 'work', ids: ['smoke-alpha'] })
    && !(await popup.evaluate(() => document.body.textContent)).includes(secret));
  check('folder assignment preserves attachment metadata', filed.result.attachments[0]?.fileName === 'smoke-attachment.txt');
  await click('[aria-label="加入收藏"]');
  await popup.waitForSelector('[aria-label="取消收藏"]');
  check('favoriting a filed record retains folder membership on the server', seed.items[0]!.folderId === 'work' && seed.items[0]!.favorite);
  await click('[data-folder-organization] button[aria-label^="打开文件夹 "]');
  await popup.waitForFunction(() => document.querySelector('.vault-detail')?.getAttribute('data-state') === 'closed');
  check('opening the folder returns to an interactive list in a narrow window',
    await popup.$eval('.vault-list', (list: HTMLElement) => !list.inert));
  await openNavigation();
  await click('nav button::-p-text(全部)');
  await click('.vault-list li > button');
  await popup.waitForSelector('[aria-label="更改文件夹归类"]', { visible: true });
  await openFolderEditor();
  rejectFolderMove = true;
  await selectOption('[data-item-folder]', '');
  await popup.waitForSelector('[aria-label="通知"] [role="alert"]');
  check('rejected assignment leaves the saved folder selected and exposes the error',
    await popup.$eval('[data-item-folder]', (picker: HTMLSelectElement) => picker.value === 'work' && !picker.disabled)
      && (await rpc('getItem', ['smoke-alpha'])).result.summary.folderId === 'work');
  check('one failed folder operation produces only one visible error',
    await popup.$$eval('[role="alert"]:not([aria-hidden="true"])', (nodes: Element[]) => nodes.length === 1));
  await click('button::-p-text(编辑)');
  await popup.waitForSelector('#editor-title', { visible: true });
  check('persistent error belongs to the active dialog accessibility scope',
    await popup.$eval('[aria-label="关闭通知"]', (button: HTMLElement) => button.closest('[role="dialog"]') !== null));
  // Error notifications persist until dismissed; close this deliberate rejection before testing the editor footer.
  if (name === 'chrome') {
    await popup.focus('.floating-layer[data-open="true"] .panel');
    await popup.keyboard.down('Shift');
    await popup.keyboard.press('Tab');
    await popup.keyboard.up('Shift');
    check('keyboard can reach a persistent notification while the editor is open',
      await popup.evaluate(() => document.activeElement?.getAttribute('aria-label') === '关闭通知'));
    await popup.keyboard.press('Enter');
    check('dismissing the notification returns keyboard focus to the editor',
      await popup.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null));
  } else await click('[aria-label="关闭通知"]');
  await click('.panel-foot button::-p-text(取消)');
  await popup.waitForSelector('#editor-title', { hidden: true });
  rejectFolderMove = false;
  await selectOption('[data-item-folder]', '');
  await waitForFolder('');
  check('detail can remove folder membership without changing its password',
    (await rpc('getItem', ['smoke-alpha'])).result.summary.folderId === null
      && (await rpc('reveal', ['smoke-alpha', { kind: 'password' }])).result === secret);
  await openFolderEditor();
  await click('[data-folder-organization] button::-p-text(新建文件夹)');
  await type('[data-item-folder-name]', '  Synthetic Created  ');
  await click('[data-folder-organization] button::-p-text(创建并归类)');
  await waitForFolder('smoke-created-1');
  const createdFolderDetail = await rpc('getItem', ['smoke-alpha']);
  check('detail creates an encrypted folder and immediately assigns the selected record',
    folderCreates.length === 1 && /^2\./.test(folderCreates[0]!.name)
      && !JSON.stringify(folderCreates).includes('Synthetic Created')
      && seed.folders.find(folder => folder.id === 'smoke-created-1')?.name === 'Synthetic Created'
      && createdFolderDetail.result.summary.folderId === 'smoke-created-1');
  check('new folder becomes available in the shared snapshot and keeps record secrets masked',
    (await rpc('snapshot')).result.folders.some((folder: any) => folder.id === 'smoke-created-1' && folder.name === 'Synthetic Created')
      && !(await popup.evaluate(() => document.body.textContent)).includes(secret)
      && createdFolderDetail.result.attachments[0]?.fileName === 'smoke-attachment.txt');
  await screenshot('created-folder-detail-440');
  await openFolderEditor();
  await selectOption('[data-item-folder]', '');
  await waitForFolder('');
  await click('button::-p-text(编辑)');
  await popup.waitForSelector('#editor-title', { visible: true });
  check('editor loads selected record through explicit draft RPC',
    (await popup.$eval('#editor-title', (node: Element) => node.textContent)) === '编辑条目');
  await screenshot('editor-440');
  const editorLayout = await popup.$$eval('[data-editor-field]', (nodes: HTMLElement[]) => nodes.map(node => {
    const card = node.closest('.card') as HTMLElement;
    return { field: node.dataset.editorField, height: node.getBoundingClientRect().height,
      cardHeight: card.getBoundingClientRect().height };
  }));
  check('native editor fields have visible layout, not just hidden DOM',
    editorLayout.every((row: { height: number; cardHeight: number }) => row.height > 0 && row.cardHeight > 2), JSON.stringify(editorLayout));
  check('notes use a single section label and retain an accessible textarea',
    await popup.$eval('[data-editor-field="notes"]', (row: HTMLElement) => row.querySelector(':scope > span') === null
      && row.querySelector('textarea')?.getAttribute('aria-label') === '备注'));
  check('saved editor shows all native login fields and one custom-field entrance',
    await popup.evaluate(() => ['login.username', 'login.password', 'login.totp', 'login.uris', 'notes']
      .every(id => document.querySelector(`[data-editor-field="${id}"]`) !== null))
      && await popup.$('[data-editor-field] button[aria-label^="移除"]') === null
      && await popup.$$eval('button[data-editor-add-more]', (nodes: Element[]) => nodes.length === 1
        && nodes[0]?.textContent?.trim() === '添加自定义字段'
        && nodes[0]?.getAttribute('aria-haspopup') === 'menu'
        && nodes[0]?.getAttribute('aria-controls') === 'editor-add-more-menu'));
  await click('[aria-label="用户名"]');
  if (name === 'chrome') {
    await popup.$eval('[aria-label="用户名"]', (input: HTMLInputElement) => input.select());
    await popup.keyboard.press('Backspace');
  } else await type('[aria-label="用户名"]', '');
  check('clearing a native field keeps its control visible and editable',
    await popup.$eval('[aria-label="用户名"]', (input: HTMLInputElement) => input.value === ''
      && !input.disabled && input.getBoundingClientRect().height > 0));
  await type('[aria-label="用户名"]', username);
  await click('[data-editor-add-more]');
  check('custom-field menu only offers the four supported native custom types',
    await popup.$('[role="menu"][aria-label="添加自定义字段"]') !== null
      && await popup.$$eval('#editor-add-more-menu [role="menuitem"]', (nodes: Element[]) => nodes.length === 4
        && nodes.every((node, index) => node.getAttribute('data-add-custom') === String(index))));
  await screenshot('custom-field-picker-440');
  await click('[data-editor-add-more]');
  check('custom-field trigger toggles the picker closed', await popup.$('#editor-add-more-menu') === null);
  await click('[data-editor-add-more]');
  await click('[data-add-custom="1"]');
  await popup.waitForFunction(() => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="字段 3 名称"]');
    return input !== null && document.activeElement === input;
  });
  check('custom-field selection adds a masked field and focuses its name',
    await popup.$eval('[aria-label="字段 3 类型"]', (input: HTMLSelectElement) => input.value === '1')
      && await popup.$eval('[aria-label="字段 3 值"]', (input: HTMLInputElement) => input.type === 'password')
      && await popup.$('#editor-add-more-menu') === null);
  await screenshot('custom-hidden-control-440');
  await click('[aria-label="删除字段 3"]');
  check('custom fields remain removable without removing native controls',
    await popup.$('[aria-label="字段 3 名称"]') === null && await popup.$('[aria-label="验证码"]') !== null);

  check('editor exposes one cancel action without a duplicate header close', await popup.$('.panel-head [aria-label="关闭"]') === null);
  await click('.panel-foot button::-p-text(取消)');
  await popup.waitForSelector('[aria-label="返回列表"]', { visible: true });
  check('editor cancel returns to selected detail', true);
  check('record metadata is a compact footer', await popup.$eval('[data-record-info]', (node: HTMLElement) =>
    node.tagName === 'FOOTER' && parseFloat(getComputedStyle(node).fontSize) <= 12));
  await click('button::-p-text(编辑)');
  await popup.waitForSelector('[aria-label="网址 3"]');
  check('editor presents every saved URL and its match rule',
    await popup.$eval('[aria-label="网址 3"]', (input: HTMLInputElement) => input.value === 'https://keep.example.invalid')
    && await popup.$eval('[aria-label="网址 3 匹配方式"]', (input: HTMLSelectElement) => input.value === '3'));
  await popup.$eval('[aria-label="删除网址 2"]', (button: HTMLElement) => button.scrollIntoView({ block: 'center' }));
  await click('[aria-label="删除网址 2"]');
  await click('[data-editor-add-url]');
  await type('[aria-label="网址 3"]', 'https://new.example.invalid');
  await click('[data-editor-url="2"] summary');
  await selectOption('[aria-label="网址 3 匹配方式"]', '5');
  await popup.$eval('[aria-label="字段 1 开关"]', (button: HTMLElement) => button.scrollIntoView({ block: 'center' }));
  await click('[aria-label="字段 1 开关"]');
  await selectOption('[aria-label="字段 2 关联目标"]', '101');
  await click('.panel-foot button::-p-text(保存)');
  await popup.waitForFunction(() => !document.querySelector('#editor-title'));
  await popup.waitForSelector('[data-record-info]');
  const edited = await rpc('getItem', ['smoke-alpha']);
  check('saving URL additions and deletions preserves the other URLs and native matching', edited.ok
    && JSON.stringify(edited.result.login.uris) === JSON.stringify([
      { uri: siteUrl, match: 1 }, { uri: 'https://keep.example.invalid', match: 3 }, { uri: 'https://new.example.invalid', match: 5 },
    ]));
  check('native boolean and linked fields round trip through the editor and encrypted API',
    edited.result.customFields[0].value === 'true' && edited.result.customFields[1].value === null
    && edited.result.customFields[1].linkedId === 101
    && (await rpc('reveal', ['smoke-alpha', { kind: 'custom', index: 1 }])).result === secret
    && cipherWrites.length === 1 && !JSON.stringify(cipherWrites).includes(secret));
  check('ordinary edits retain attachment metadata and do not add password history',
    edited.result.attachments[0]?.fileName === 'smoke-attachment.txt' && edited.result.passwordHistory.length === 0);
  await screenshot('edited-detail-440');
  const downloaded = await rpc('downloadAttachment', ['smoke-alpha', 'smoke-file']);
  check('attachment decrypts native binary through the extension bridge', downloaded.ok
    && Buffer.from(downloaded.result.dataBase64, 'base64').equals(attachmentContent));
  if (process.env.ONEWARDEN_SMOKE_ATTACHMENTS === '1') {
    await popup.evaluate(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === '取回')?.scrollIntoView({ block: 'center' }));
    await click('button::-p-text(取回)');
    console.log(`  Waiting for attachment download; test destination: ${downloads}`);
    await popup.waitForFunction(async () => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      return (await api.downloads.search({})).some((download: any) => download.state === 'complete');
    }, { timeout: process.env.ONEWARDEN_SMOKE_HEADED === '1' ? 60_000 : 15_000 });
    const file = await popup.evaluate(async () => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      return (await api.downloads.search({})).find((download: any) => download.state === 'complete');
    });
    check('attachment Blob download completes in isolated destination', file.filename.startsWith(downloads));
    check('downloaded attachment matches decrypted fixture bytes', readFileSync(file.filename).equals(attachmentContent));
  }
  await click('[aria-label="返回列表"]');
  await popup.waitForSelector('[aria-label="搜索条目"]', { visible: true });
  check('narrow detail returns to list', true);

  // Enter through the actual drawer; each screen must retain its own way back.
  async function navigation(label: string): Promise<void> {
    await openNavigation();
    await click(`nav button::-p-text(${label})`);
  }
  const organizationWriteCounts = () => JSON.stringify({ cipherWrites: cipherWrites.length,
    cipherCreates: cipherCreates.length, folderRequests: folderRequests.length, folderCreates: folderCreates.length });
  const beforeOrganization = organizationWriteCounts();
  const organization = await rpc('organizationReport');
  const organizationText = JSON.stringify(organization);
  check('organization RPC returns only local findings without passwords, keys or login contents', organization.ok
    && organization.result.total === 2 && organization.result.checked === 2 && organization.result.skipped === 0
    && organization.result.duplicates.some((group: { kind: string; itemIds: string[] }) => group.kind === 'similar'
      && group.itemIds.includes('smoke-alpha') && group.itemIds.includes('smoke-zulu'))
    && !organizationText.includes(secret) && !organizationText.includes('userKey')
    && !organizationText.includes(username) && !organizationText.includes(siteUrl));
  check('organization RPC does not write or create ciphers or folders', organizationWriteCounts() === beforeOrganization);
  await navigation('整理与分析');
  const organizationPicker = 'main[aria-label="整理与分析"] [role="combobox"][aria-label="整理分类"]';
  await popup.waitForSelector(organizationPicker, { visible: true });
  const organizationCategories = [
    ['identical', '已检查内容一致'], ['similar', '疑似重复'], ['missingUrls', '未填写网址'],
    ['missingUsernames', '未填写用户名'], ['lowInformationNames', '名称信息少'], ['unfiled', '未分类'],
  ] as const;
  await click(organizationPicker);
  check('organization exposes all six distinct local finding categories in a themed picker', await popup.$$eval(
    'main[aria-label="整理与分析"] [role="option"]', (options: HTMLElement[], expected: string[]) =>
      options.length === expected.length && options.every((option, index) => option.dataset.value === expected[index]),
    organizationCategories.map(([id]) => id)));
  check('organization does not render a platform-native select', await popup.$('main[aria-label="整理与分析"] select') === null);
  await screenshot('organization-picker-440');
  await click(organizationPicker);
  for (const [id, label] of organizationCategories) {
    await selectOption(organizationPicker, id);
    await popup.waitForFunction((label: string) => document.querySelector('main[aria-label="整理与分析"] h2:not(.sr-only)')?.textContent === label, {}, label);
  }
  check('organization category filtering updates the current findings without navigation', true);
  await selectOption(organizationPicker, 'similar');
  await popup.waitForSelector('main[aria-label="整理与分析"] button[aria-label="编辑「Alpha smoke login」"]', { visible: true });
  check('organization groups show readable summaries without revealed passwords', await popup.$eval(
    'main[aria-label="整理与分析"]', (node: HTMLElement, expected: { username: string; secret: string }) =>
      node.textContent?.includes('Alpha smoke login') === true && node.textContent.includes('Zulu smoke login')
      && node.textContent.includes(expected.username) && !node.textContent.includes(expected.secret), { username, secret }));
  check('organization has one shared back button and no duplicate close action', await popup.$$eval(
    'main[aria-label="整理与分析"] [data-page-back]', (nodes: Element[]) => nodes.length === 1)
    && await popup.$('main[aria-label="整理与分析"] button[aria-label^="关闭"]') === null);
  if (await popup.$('button[aria-label="关闭通知"]') !== null) {
    await click('button[aria-label="关闭通知"]');
    await popup.waitForFunction(() => !document.querySelector('button[aria-label="关闭通知"]'));
  }
  await screenshot('organization-440');
  // The production action popup has a fixed 440x600 surface; wide layouts are
  // covered by the desktop preview rather than resizing this privileged page.
  await click('main[aria-label="整理与分析"] button[aria-label="编辑「Alpha smoke login」"]');
  await popup.waitForSelector('[aria-labelledby="editor-title"]', { visible: true });
  check('organization edit opens the existing editor above the same filtered report', await popup.$eval(
    'main[aria-label="整理与分析"] [role="combobox"]', (node: HTMLElement) => node.textContent?.includes('疑似重复'))
    && await popup.$$eval('main[aria-label="整理与分析"] button[aria-label^="编辑「"]',
      (nodes: HTMLButtonElement[]) => nodes.length === 2 && nodes.every(node => node.disabled)));
  await click('.panel-foot button::-p-text(取消)');
  await popup.waitForFunction(() => !document.querySelector('#editor-title')
    && document.querySelector('main[aria-label="整理与分析"] [role="combobox"]')?.textContent?.includes('疑似重复'));
  check('organization edit cancellation preserves category and restores reachable report focus', await popup.evaluate(() => {
    const active = document.activeElement;
    return !!active && active !== document.body && active.closest('main[aria-label="整理与分析"]') !== null
      && !active.closest('[inert]');
  }));
  check('organization navigation, filtering and canceled editing remain read-only', organizationWriteCounts() === beforeOrganization);
  await click('[aria-label="合并第 1 组"]');
  await popup.waitForSelector('[role="combobox"][aria-label="合并主条目"]', { visible: true });
  await click('.panel-foot button::-p-text(预览合并)');
  await popup.waitForFunction(() => document.querySelector('[role="dialog"] [role="alert"]')?.textContent?.includes('附件'));
  check('merge preview blocks records with attachments without changing any source', organizationWriteCounts() === beforeOrganization
    && await popup.$eval('.panel-foot button', (node: HTMLButtonElement) => node.disabled));
  await screenshot('organization-merge-blocked-440');
  await click('[aria-label="返回选择主条目"]');
  await click('[aria-label="取消合并"]');
  await popup.waitForSelector('[role="dialog"]', { hidden: true });
  await click('main[aria-label="整理与分析"] [data-page-back]');
  await popup.waitForSelector('[aria-label="搜索条目"]', { visible: true });
  check('organization shared back returns to the vault list', await popup.$('main[aria-label="整理与分析"]') === null);
  await navigation('生成器');
  await popup.waitForSelector('[aria-labelledby="generator-title"] [data-page-back]', { visible: true });
  check('generator opens from shared navigation', true);
  await click('[aria-labelledby="generator-title"] [data-page-back]');
  await navigation('安全报告');
  await popup.waitForSelector('button[aria-label="导航"]', { visible: true });
  check('security report retains narrow navigation', (await popup.evaluate(() => document.body.textContent)).includes('安全报告'));
  await navigation('导入');
  await popup.waitForSelector('button[aria-label="导航"]', { visible: true });
  check('import retains narrow navigation', (await popup.evaluate(() => document.body.textContent)).includes('导入'));
  await navigation('全部');
  await popup.waitForSelector('[aria-label="搜索条目"]', { visible: true });
  await openNavigation();
  await click('[aria-label="账户菜单"]');
  check('account menu omits the redundant account-home action', await popup.$eval('#profile-account-menu', (node: Element) => !node.textContent?.includes('返回账户首页')));
  await click('[role="menuitem"]::-p-text(设置)');
  await popup.waitForSelector('[aria-labelledby="settings-title"] [data-page-back]', { visible: true });
  check('settings opens from the shared drawer', true);
  check('narrow settings starts in a full-width directory',
    await popup.$('[aria-label="设置目录"]') !== null && await popup.$('[aria-label="设置分组"]') === null);
  await click('#settings-link-appearance');
  await popup.waitForSelector('#settings-panel-appearance', { visible: true });
  check('settings directory opens a single content page', await popup.$('[aria-label="设置目录"]') === null);
  await click('[aria-label="返回设置目录"]');
  await popup.waitForFunction(() => document.activeElement?.id === 'settings-link-appearance');
  check('settings back returns to directory and restores focus', true);
  await click('[aria-labelledby="settings-title"] [data-page-back]');

  const tabId = await popup.evaluate(async (url: string) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return (await api.tabs.query({})).find((tab: any) => tab.url === url)?.id;
  }, siteUrl);
  check('test site tab is available', typeof tabId === 'number');
  const fields = await popup.evaluate(async (id: number) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return api.tabs.sendMessage(id, { type: '1warden:read-fields' });
  }, tabId);
  check('real content script bridge responds', fields !== undefined);
  const denial = await popup.evaluate(async (id: number) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return api.scripting.executeScript({ target: { tabId: id }, func: async () => {
      const contentApi = (globalThis as any).browser ?? (globalThis as any).chrome;
      return contentApi.runtime.sendMessage({ type: '1warden:application', method: 'reveal', args: ['smoke-alpha', { kind: 'password' }] });
    } });
  }, tabId);
  check('content context cannot invoke privileged reveal RPC', denial[0]?.result?.ok === false
    && !JSON.stringify(denial).includes(secret), JSON.stringify(denial));
  const fill = await popup.evaluate(async (id: number) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return api.runtime.sendMessage({ type: '1warden:fill', itemId: 'smoke-alpha', tabId: id, application: true });
  }, tabId);
  check('background fill accepts explicit request', fill?.ok === true, JSON.stringify(fill));
  await login.waitForFunction((expected: string) => (document.querySelector('#password') as HTMLInputElement)?.value === expected, {}, secret);
  check('real site receives username and password', await login.$eval('#email', (input: HTMLInputElement) => input.value) === username);

  // GitHub-style second step: no password field remains on the page. Use real
  // content/background scripts and trusted input, including Gecko, not RPC fill.
  await login.bringToFront();
  await login.evaluate(() => {
    history.pushState({}, '', '/sessions/two-factor/app');
    document.querySelector('form')!.innerHTML = '<label for="app_totp">Authentication code</label>'
      + '<input id="app_totp" name="app_otp" autocomplete="one-time-code" inputmode="numeric">'
      + '<button type="submit">Verify</button>';
    (window as any).otpSubmits = 0;
    document.querySelector('form')!.onsubmit = event => { event.preventDefault(); (window as any).otpSubmits++; };
  });
  async function pickCode(selector: string): Promise<string[]> {
    await login.click(selector);
    await login.waitForSelector('[data-onewarden-inline][data-kind="totp"][data-state="accounts"]', { visible: true });
    const before = (await generateTotp('JBSWY3DPEHPK3PXP')).code;
    await login.keyboard.press('ArrowDown');
    await login.keyboard.press('Enter');
    await login.waitForFunction(() => document.querySelector('[data-onewarden-inline]') === null);
    return [before, (await generateTotp('JBSWY3DPEHPK3PXP')).code];
  }
  const codes = await pickCode('#app_totp');
  check('standalone authenticator input suggests and fills a fresh TOTP', codes.includes(await login.$eval('#app_totp', (input: HTMLInputElement) => input.value)));
  check('choosing a TOTP does not submit the website form', await login.evaluate(() => (window as any).otpSubmits === 0));
  await login.evaluate(() => {
    document.querySelector('form')!.innerHTML = Array.from({ length: 6 }, (_, i) =>
      `<input id="digit-${i}" maxlength="1" inputmode="numeric" ${i === 0 ? 'autocomplete="one-time-code"' : ''}>`).join('');
  });
  const splitCodes = await pickCode('#digit-3');
  check('focusing any cell fills the entire split verification code', splitCodes.includes(await login.$$eval('form input', (inputs: HTMLInputElement[]) => inputs.map(input => input.value).join(''))));

  await login.evaluate(() => {
    document.querySelector('form')!.innerHTML = '<input id="current" type="password" autocomplete="current-password" value="keep-current">'
      + '<input id="new" type="password" autocomplete="new-password" value="keep-new">'
      + '<input id="confirm" type="password" autocomplete="new-password" value="keep-confirm">'
      + '<label for="otp">Authenticator code</label><input id="otp" name="totp">';
  });
  await pickCode('#otp');
  check('TOTP fill preserves current and new passwords', await login.$$eval('input[type="password"]', (inputs: HTMLInputElement[]) =>
    inputs.map(input => input.value).join(',') === 'keep-current,keep-new,keep-confirm'));
  await login.click('#current');
  await login.waitForSelector('[data-onewarden-inline][data-kind="login"][data-state="accounts"]', { visible: true });
  await login.keyboard.press('ArrowDown');
  await login.keyboard.press('Enter');
  await login.waitForFunction(() => (document.querySelector('#current') as HTMLInputElement).value !== 'keep-current');
  check('saved current-password fill preserves generated new passwords', await login.$eval('#new', (input: HTMLInputElement) => input.value) === 'keep-new'
    && await login.$eval('#confirm', (input: HTMLInputElement) => input.value) === 'keep-confirm');
  await login.click('#new');
  await login.waitForSelector('[data-onewarden-credentials="generator"]', { visible: true });
  check('new-password focus offers the generator instead of saved-password fill', await login.$('[data-onewarden-inline]') === null);
  await login.keyboard.press('Escape');
  const otpRecord = seed.items.find(record => record.id === 'smoke-zulu')!;
  check('TOTP can be removed for the missing-code interaction fixture', (await rpc('saveItem', [{
    ...otpRecord, login: { ...otpRecord.login!, totp: null },
  }])).ok);
  await login.evaluate(() => { (document.querySelector('#otp') as HTMLInputElement).value = ''; });
  await login.click('#otp');
  await login.waitForSelector('[data-onewarden-inline][data-kind="totp"][data-state="empty"]', { visible: true });
  check('no configured TOTP shows an explicit empty hint without filling a password', await login.$eval('#otp', (input: HTMLInputElement) => input.value) === '');
  await login.keyboard.press('Escape');
  check('Escape from an empty suggestion returns to the code input', await login.evaluate(() => document.activeElement?.id === 'otp'));
  const latestOtpRecord = seed.items.find(record => record.id === otpRecord.id)!;
  check('restoring TOTP is saved before re-opening suggestions', (await rpc('saveItem', [{
    ...latestOtpRecord, login: { ...latestOtpRecord.login!, totp: otpRecord.login!.totp },
  }])).ok);
  await pickCode('#otp');
  check('re-opening the code field observes newly configured TOTP', true);

  await login.evaluate(() => {
    document.querySelector('form')!.innerHTML = '<label for="recovery">Recovery code</label>'
      + '<input id="recovery" name="recovery_code" autocomplete="one-time-code">'
      + '<input id="sms" name="sms_otp" autocomplete="one-time-code">';
  });
  for (const selector of ['#recovery', '#sms']) {
    await login.click(selector);
    check(`${selector} does not offer an authenticator code`, await login.$('[data-onewarden-inline]') === null);
  }
  await login.evaluate((url: string) => history.replaceState({}, '', url), siteUrl);

  // Exercise the site's actual submit event and content script, including native
  // new-password/confirmation roles. Saving remains an explicit popup action.
  const registeredUsername = 'registration-smoke@example.invalid';
  const registeredPassword = 'Synthetic-New-Registration!42';
  const changedPassword = 'Synthetic-Changed-Registration!43';
  // Successful focus sync may persist a profile secure note. Count login writes
  // separately so this assertion still detects an unconfirmed credential save.
  const loginCreates = () => cipherCreates.filter(cipher => cipher.type === 1).length;
  async function submitCredentialForm(changing: boolean): Promise<void> {
    await login.bringToFront();
    await login.evaluate((changing: boolean) => {
      const form = document.querySelector('form')!;
      form.innerHTML = '<label>Email<input id="email" type="email" autocomplete="username"></label>'
        + (changing ? '<label>Current password<input id="current" type="password" autocomplete="current-password"></label>' : '')
        + '<label>New password<input id="new-password" type="password" autocomplete="new-password"></label>'
        + '<label>Confirm password<input id="confirm-password" type="password" autocomplete="new-password"></label>'
        + '<button type="submit">Submit</button>';
    }, changing);
    // Both engines support trusted keyboard/pointer input on regular web pages.
    // Scripted requestSubmit alone must not authorize credential capture.
    await login.type('#email', registeredUsername);
    if (changing) await login.type('#current', registeredPassword);
    await login.type('#new-password', changing ? changedPassword : registeredPassword);
    await login.type('#confirm-password', changing ? changedPassword : registeredPassword);
    await login.click('button[type="submit"]');
  }
  async function pendingCapture(action: string): Promise<CapturePreview> {
    const handle = await popup.waitForFunction(async (id: number, action: string, user: string) => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      const response = await api.runtime.sendMessage({ type: '1warden:credential-list', application: true });
      if (!response?.ok) throw new Error(response?.error?.message ?? 'Missing capture response');
      return response.result.find((row: CapturePreview) => row.tabId === id && row.action === action && row.username === user);
    }, {}, tabId, action, registeredUsername);
    try { return await handle.jsonValue(); } finally { await handle.dispose(); }
  }
  const saveCapture = (capture: CapturePreview) => popup.evaluate(async (capture: CapturePreview) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return api.runtime.sendMessage({ type: '1warden:credential-save', application: true, choice: {
      captureId: capture.id, revision: capture.revision, action: capture.action,
      ...(capture.action === 'update' ? { itemId: capture.itemId,
        targetUpdatedAt: capture.targets.find(row => row.id === capture.itemId)?.updatedAt } : {}),
    } });
  }, capture);
  await submitCredentialForm(false);
  const registration = await pendingCapture('save');
  check('registration with new-password and confirmation prompts before writing',
    loginCreates() === 0 && !JSON.stringify(registration).includes(registeredPassword));
  check('registration save confirmation succeeds', (await saveCapture(registration)).ok === true);
  const created = seed.items.find(record => record.login?.username === registeredUsername)!;
  check('registration creates one encrypted record with the correct username and new password',
    loginCreates() === 1 && created?.login?.password === registeredPassword
      && created.login.uris[0]?.uri === siteUrl && !JSON.stringify(cipherCreates).includes(registeredPassword));
  await submitCredentialForm(true);
  const change = await pendingCapture('update');
  check('change-password targets the existing login and awaits confirmation',
    change.itemId === created.id && seed.items.find(record => record.id === created.id)?.login?.password === registeredPassword);
  check('change-password confirmation succeeds', (await saveCapture(change)).ok === true);
  const updatedLogin = seed.items.find(record => record.id === created.id)!;
  check('change-password saves the new password and preserves the old password in history',
    updatedLogin.login?.password === changedPassword && updatedLogin.passwordHistory[0]?.password === registeredPassword
      && loginCreates() === 1 && !JSON.stringify(cipherWrites).includes(changedPassword));

  await openPopup(true);
  await popup.waitForSelector('[aria-label="搜索条目"]', { visible: true });
  await screenshot('vault-440');
  // Exercise the complete merge against this loopback server, after unrelated
  // capture checks. New records have neither attachments nor linked fields.
  const mergePasswords = ['Synthetic-Merge-Base!42', 'Synthetic-Merge-Source!87'];
  const mergeIds: string[] = [];
  for (const [index, title] of ['Merge smoke base', 'Merge smoke source'].entries()) {
    const draft = item('', title, '2026-10-12T00:00:00Z');
    draft.customFields = []; draft.attachments = [];
    draft.notes = index ? 'Source note survives merging' : 'Base note survives merging';
    draft.login = { ...draft.login!, username: 'merge-user@example.invalid', password: mergePasswords[index]!,
      uris: [{ uri: 'https://merge.example.invalid/login', match: 1 }] };
    const created = await rpc('saveItem', [draft]);
    check(`synthetic merge source ${index + 1} is created through the encrypted service`, created.ok);
    mergeIds.push(created.result.id);
  }
  const mergePreview = await rpc('previewMerge', [{ baseId: mergeIds[0], sourceIds: [mergeIds[1]] }]);
  check('merge preview crosses the extension boundary without secret values', mergePreview.ok
    && mergePreview.result.blockers.length === 0
    && mergePasswords.every(value => !JSON.stringify(mergePreview).includes(value)),
    JSON.stringify({ ok: mergePreview.ok, error: mergePreview.error, blockers: mergePreview.result?.blockers }));
  await openPopup(true);
  await popup.waitForSelector('[aria-label="搜索条目"]', { visible: true });
  await navigation('整理与分析');
  await selectOption(organizationPicker, 'similar');
  const groupLabel = await popup.$$eval('main[aria-label="整理与分析"] section', (sections: HTMLElement[]) =>
    sections.find(section => section.textContent?.includes('Merge smoke base'))?.getAttribute('aria-label'));
  check('new related records are discoverable as a duplicate group', Boolean(groupLabel));
  await click(`section[aria-label=${JSON.stringify(groupLabel)}] button[aria-label^="合并第"]`);
  await selectOption('[aria-label="合并主条目"]', mergeIds[0]!);
  const beforeMergeWrites = cipherWrites.length;
  await click('.panel-foot button::-p-text(预览合并)');
  await popup.waitForSelector('[aria-label="冲突字段"]', { visible: true });
  check('merge remains read-only until confirmation and requires conflict choices', cipherWrites.length === beforeMergeWrites
    && mergeTrashRequests.length === 0 && await popup.$eval('.panel-foot button', (node: HTMLButtonElement) => node.disabled));
  const revealLabel = await popup.$$eval('button[aria-label^="显示密码"]', (buttons: HTMLElement[]) => buttons[0]?.getAttribute('aria-label'));
  await click(`button[aria-label=${JSON.stringify(revealLabel)}]`);
  await popup.waitForFunction((value: string) => document.querySelector('[role="dialog"]')?.textContent?.includes(value), {}, mergePasswords[0]);
  check('merge reveals a single conflict only after its explicit action', !(await popup.evaluate(() => document.body.textContent)).includes(mergePasswords[1]));
  await click('button[aria-label^="隐藏密码"]');
  const baseChoices = await popup.$$eval('[aria-label="冲突字段"] input[type="radio"]', (inputs: HTMLInputElement[]) =>
    inputs.filter(input => input.getAttribute('aria-label')?.includes('Merge smoke base')).map(input => input.getAttribute('aria-label')));
  for (const label of baseChoices) await click(`input[aria-label=${JSON.stringify(label)}]`);
  await screenshot('organization-merge-preview-440');
  await click('.panel-foot button::-p-text(确认合并)');
  await popup.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes('1 条来源已移到回收站'));
  const mergedRecord = seed.items.find(record => record.id === mergeIds[0])!;
  check('merge saves the selected base, retains both notes and password history, then trashes only the source',
    cipherWrites.length === beforeMergeWrites + 1 && mergedRecord.login?.password === mergePasswords[0]
    && mergedRecord.passwordHistory.some(entry => entry.password === mergePasswords[1])
    && mergedRecord.notes?.includes('Source note survives merging') === true
    && mergedRecord.notes.includes('Base note survives merging')
    && JSON.stringify(mergeTrashRequests) === JSON.stringify([mergeIds[1]])
    && !!seed.items.find(record => record.id === mergeIds[1])?.deletedAt
    && mergePasswords.every(value => !JSON.stringify(cipherWrites).includes(value)));
  await screenshot('organization-merge-result-440');
  await click('.panel-foot button::-p-text(完成)');
  await popup.waitForSelector('[role="dialog"]', { hidden: true });
  await click('main[aria-label="整理与分析"] [data-page-back]');
  await popup.waitForSelector('[aria-label="搜索条目"]', { visible: true });
  if (process.env.ONEWARDEN_SMOKE_CLIPBOARD === '1') {
    const copyPassword = async () => {
      await click('.vault-list li > button span::-p-text(Alpha smoke login)');
      await click('[data-field-copy][aria-label="复制密码"]');
      await popup.waitForSelector('[data-field-copy][aria-label="复制密码"][data-state="ok"]');
      check('clicking the shared password field copies the revealed password',
        await popup.evaluate(() => navigator.clipboard.readText()) === secret);
    };
    const closePastDeadline = async () => {
      await popup.close();
      console.log('  Waiting 32 seconds with the popup closed for clipboard cleanup…');
      await new Promise((resolve) => setTimeout(resolve, 32_000));
      popup = await browser.newPage();
      popup.on('pageerror', (error: Error) => errors.push(error.message));
      popup.setDefaultTimeout(15_000);
      await popup.setViewport({ width: 440, height: 600 });
      await openPopup();
      await popup.waitForSelector('[aria-label="搜索条目"]', { visible: true });
    };
    await copyPassword();
    await closePastDeadline();
    check('clipboard expires after popup closes', await popup.evaluate(() => navigator.clipboard.readText()) === '');
    await copyPassword();
    const laterCopy = 'Later synthetic clipboard content';
    await popup.evaluate((value: string) => navigator.clipboard.writeText(value), laterCopy);
    await closePastDeadline();
    check('clipboard cleanup preserves a later copy', await popup.evaluate(() => navigator.clipboard.readText()) === laterCopy);
    await popup.evaluate(() => navigator.clipboard.writeText(''));
  }
  // Lock is a vault shortcut; the account menu's logout is a different operation.
  await popup.focus('[aria-label="搜索条目"]');
  if (name === 'chrome') {
    await popup.keyboard.down('Control');
    await popup.keyboard.press('l');
    await popup.keyboard.up('Control');
  } else await popup.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true })));
  await popup.waitForSelector('input[type="password"]', { visible: true });
  const locked = await rpc('snapshot');
  check('lock clears vault display and retains account', locked.ok && locked.result.status === 'locked'
    && locked.result.items.length === 0 && locked.result.account?.email === username);
  const stored = await popup.evaluate(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return api.storage.session.get('1warden.session');
  });
  check('lock removes persisted session keys', stored['1warden.session'] === undefined);
  await openPopup(true);
  await popup.waitForSelector('input[type="password"]', { visible: true });
  check('reopening preserves locked account state', (await rpc('snapshot')).result.status === 'locked');
  await login.bringToFront();
  await login.evaluate(() => {
    document.querySelector('form')!.innerHTML = '<input id="locked-otp" autocomplete="one-time-code">';
  });
  await login.click('#locked-otp');
  await login.waitForSelector('[data-onewarden-inline][data-kind="totp"][data-state="locked"]', { visible: true });
  check('a locked vault offers an unlock action directly beside the code input', await login.$eval('#locked-otp', (input: HTMLInputElement) => input.value) === '');
  await login.keyboard.press('Escape');
  check('no uncaught UI errors', errors.length === 0, errors.join('\n'));
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(failure);
  if (popup) {
    console.error('Page visibility at failure:', await popup.evaluate(() => document.visibilityState).catch(() => 'unavailable'));
    await screenshot('failure').catch(() => {});
    const text = await popup.evaluate(() => document.body.innerText).catch(() => 'unavailable');
    console.error(`UI at failure: ${text}`);
  }
} finally {
  await browser?.close().catch(() => {});
  site.stop(true);
  rmSync(profile, { recursive: true, force: true });
  writeFileSync(join(artifacts, `${product}-report.json`), JSON.stringify({
    browser: product, engine, version, userAgent, executable, extension: dist, buildHashes, viewport: [440, 600], checks, errors,
    passed: !failure, failure, synthetic: true, timestamp: new Date().toISOString(),
    screenshots: name === 'chrome' ? 'captured' : 'Gecko BiDi cannot capture privileged extension pages',
    interaction: name === 'chrome' ? 'native pointer and keyboard' : 'DOM events; Gecko BiDi rejects native actions on extension pages',
  }, null, 2) + '\n');
}
if (failure) process.exitCode = 1;
else console.log(`PASS ${product}: ${checks.length} checks`);
