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
    if (url.pathname === '/api/ciphers' && request.method === 'POST') {
      const body = await request.json() as CipherDto;
      const dto = { ...body, id: `smoke-registration-${cipherCreates.length + 1}`,
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
    if (url.pathname.startsWith('/api/ciphers/') && request.method === 'PUT') {
      const index = seed.items.findIndex(record => url.pathname === `/api/ciphers/${record.id}`);
      if (index >= 0) {
        const record = seed.items[index]!;
        const body = await request.json() as CipherDto;
        const dto = { ...body, id: record.id, creationDate: record.createdAt, revisionDate: new Date().toISOString(),
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
        { uri: 'https://keep.example.invalid', match: 3 }], totp: null,
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
  if (name === 'chrome') {
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
    // Gecko BiDi rejects native input on privileged pages; activate its real DOM.
    if (name === 'firefox') await element.evaluate((button: HTMLElement) => button.click());
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
async function openNavigation(): Promise<void> {
  // Explicit state, not hover or an intermediate slide-animation position.
  const open = await popup.$eval('[aria-label="导航"]', (trigger: Element) => trigger.getAttribute('aria-expanded') === 'true');
  if (!open) {
    await click('button[aria-label="导航"]');
    await popup.waitForFunction(() => document.querySelector('.nav-drawer-panel')!.getBoundingClientRect().left >= 0);
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
    if (name === 'firefox') {
      const context = popup.mainFrame().browsingContext;
      if (reload) await context.reload({ wait: 'interactive' });
      else await context.navigate(`${origin}/popup.html`, 'interactive');
    } else if (reload) await popup.reload({ waitUntil: 'domcontentloaded' });
    else await popup.goto(`${origin}/popup.html`, { waitUntil: 'domcontentloaded' });
  };
  await openPopup();
  await popup.waitForSelector('main button');
  await popup.waitForSelector('[data-add-server]');
  check('empty home invites adding the first server', await popup.$eval('[data-add-server]', (node: Element) => node.textContent?.trim() === '添加第一个服务器')
    && await popup.$eval('h1', (node: Element) => node.textContent === '添加服务器，开始使用'));
  await popup.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-brand-mark]')].every(node => node.complete && node.naturalWidth > 0));
  check('production brand asset loads inside extension CSP', await popup.$eval('[data-brand-mark]', (node: HTMLImageElement) => node.complete && node.naturalWidth > 0));
  await screenshot('empty-home-brand');
  await click('[data-add-server]');
  await popup.waitForSelector('input[type="email"]', { visible: true });
  check('shared connect screen renders', await popup.$('input[type="password"]') !== null);
  await screenshot('connect');

  await popup.evaluate(async (fixture: unknown) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    await api.storage.session.set({ '1warden.session': fixture, '1warden.account': (fixture as any).account });
    await api.storage.session.remove('1warden.connectionDraft');
  }, seed);
  await openPopup(true);
  await popup.waitForSelector('main li button');
  check('populated home retains account selection and other-server wording', await popup.$eval('h1', (node: Element) => node.textContent === '选择要连接的账户')
    && await popup.$eval('[data-add-server]', (node: Element) => node.textContent?.trim() === '连接其他服务器'));
  await enterHome();
  await popup.waitForSelector('[aria-label="搜索条目"]', { visible: true });
  check('shared vault renders from background session', true);
  const rpc = async (method: string, args: unknown[] = []) => popup.evaluate(async (m: string, a: unknown[]) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return api.runtime.sendMessage({ type: '1warden:application', method: m, args: a });
  }, method, args);
  async function enterHome() {
    await popup.waitForSelector('main li button');
    await popup.$eval('main li button', (b: HTMLButtonElement) => b.click());
  }
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
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const responsive = await Promise.race([
        Promise.all([rpc('search', ['Alpha']), rpc('getItem', ['smoke-alpha'])])
          .then(([search, detail]) => search.ok && search.result.length === 1 && detail.ok),
        new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      check('search and details respond while a frozen tab blocks filling', responsive === true);
    } finally {
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      await filling;
      await cdp.detach();
    }
  }

  const rowNames = () => popup.$$eval('.vault-list li > button', (rows: Element[]) => rows.map((row) => row.textContent ?? ''));
  const initialRows = await rowNames();
  check('default date sort puts newest first', initialRows[0]?.includes('Zulu smoke login') === true, JSON.stringify(initialRows));
  await click('[aria-label="排序方式"]');
  await click('button::-p-text(名称)');
  await popup.waitForFunction(() => document.querySelector('.vault-list li > button')?.textContent?.includes('Alpha smoke login'));
  check('name sort changes list order', true);
  await type('[aria-label="搜索条目"]', 'Alpha');
  await popup.waitForFunction(() => document.querySelectorAll('.vault-list li > button').length === 1);
  check('search filters shared list', (await rowNames())[0]?.includes('Alpha smoke login') === true);
  await click('.vault-list li > button');
  await popup.waitForSelector('[aria-label="显示"]', { visible: true });
  check('detail starts masked', !(await popup.evaluate(() => document.body.textContent)).includes(secret));
  await click('[aria-label="显示"]');
  await popup.waitForFunction((value: string) => document.body.textContent?.includes(value), {}, secret);
  check('explicit reveal obtains password through background RPC', true);
  await screenshot('detail-440');
  await click('[aria-label="隐藏"]');
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
  await popup.select('[data-item-folder]', 'work');
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
  await popup.select('[data-item-folder]', '');
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
  await popup.select('[data-item-folder]', '');
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
  await popup.select('[data-item-folder]', '');
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
  await popup.select('[aria-label="网址 3 匹配方式"]', '5');
  await popup.$eval('[aria-label="字段 1 开关"]', (button: HTMLElement) => button.scrollIntoView({ block: 'center' }));
  await click('[aria-label="字段 1 开关"]');
  await popup.select('[aria-label="字段 2 关联目标"]', '101');
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
  await popup.waitForSelector('main[aria-label="整理与分析"] select[aria-label="整理分类"]', { visible: true });
  const organizationCategories = [
    ['identical', '已检查内容一致'], ['similar', '疑似重复'], ['missingUrls', '未填写网址'],
    ['missingUsernames', '未填写用户名'], ['lowInformationNames', '名称信息少'], ['unfiled', '未分类'],
  ] as const;
  check('organization exposes all six distinct local finding categories', await popup.$$eval(
    'main[aria-label="整理与分析"] select option', (options: HTMLOptionElement[], expected: string[]) =>
      options.length === expected.length && options.every((option, index) => option.value === expected[index]),
    organizationCategories.map(([id]) => id)));
  for (const [id, label] of organizationCategories) {
    await popup.select('main[aria-label="整理与分析"] select', id);
    await popup.waitForFunction((label: string) => document.querySelector('main[aria-label="整理与分析"] h2:not(.sr-only)')?.textContent === label, {}, label);
  }
  check('organization category filtering updates the current findings without navigation', true);
  await popup.select('main[aria-label="整理与分析"] select', 'similar');
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
    'main[aria-label="整理与分析"] select', (node: HTMLSelectElement) => node.value === 'similar')
    && await popup.$$eval('main[aria-label="整理与分析"] button[aria-label^="编辑「"]',
      (nodes: HTMLButtonElement[]) => nodes.length === 2 && nodes.every(node => node.disabled)));
  await click('.panel-foot button::-p-text(取消)');
  await popup.waitForFunction(() => !document.querySelector('#editor-title')
    && (document.querySelector('main[aria-label="整理与分析"] select') as HTMLSelectElement | null)?.value === 'similar');
  check('organization edit cancellation preserves category and restores reachable report focus', await popup.evaluate(() => {
    const active = document.activeElement;
    return !!active && active !== document.body && active.closest('main[aria-label="整理与分析"]') !== null
      && !active.closest('[inert]');
  }));
  check('organization navigation, filtering and canceled editing remain read-only', organizationWriteCounts() === beforeOrganization);
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

  // Exercise the site's actual submit event and content script, including native
  // new-password/confirmation roles. Saving remains an explicit popup action.
  const registeredUsername = 'registration-smoke@example.invalid';
  const registeredPassword = 'Synthetic-New-Registration!42';
  const changedPassword = 'Synthetic-Changed-Registration!43';
  async function submitCredentialForm(changing: boolean): Promise<void> {
    await login.evaluate(({ changing, user, original, changed }) => {
      const form = document.querySelector('form')!;
      form.innerHTML = '<label>Email<input id="email" type="email" autocomplete="username"></label>'
        + (changing ? '<label>Current password<input id="current" type="password" autocomplete="current-password"></label>' : '')
        + '<label>New password<input id="new-password" type="password" autocomplete="new-password"></label>'
        + '<label>Confirm password<input id="confirm-password" type="password" autocomplete="new-password"></label>'
        + '<button type="submit">Submit</button>';
      (form.querySelector('#email') as HTMLInputElement).value = user;
      if (changing) (form.querySelector('#current') as HTMLInputElement).value = original;
      (form.querySelector('#new-password') as HTMLInputElement).value = changing ? changed : original;
      (form.querySelector('#confirm-password') as HTMLInputElement).value = changing ? changed : original;
      form.requestSubmit();
    }, { changing, user: registeredUsername, original: registeredPassword, changed: changedPassword });
  }
  async function pendingCapture(action: string) {
    await popup.waitForFunction(async (id: number, action: string, user: string) => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      const response = await api.runtime.sendMessage({ type: '1warden:pending', tabId: id });
      return response.pending?.action === action && response.pending?.username === user;
    }, {}, tabId, action, registeredUsername);
    return popup.evaluate(async (id: number) => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      return api.runtime.sendMessage({ type: '1warden:pending', tabId: id });
    }, tabId);
  }
  const saveCapture = () => popup.evaluate(async (id: number) => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return api.runtime.sendMessage({ type: '1warden:save-capture', tabId: id, application: true });
  }, tabId);
  await submitCredentialForm(false);
  const registration = await pendingCapture('save');
  check('registration with new-password and confirmation prompts before writing',
    cipherCreates.length === 0 && !JSON.stringify(registration).includes(registeredPassword));
  check('registration save confirmation succeeds', (await saveCapture()).ok === true);
  const created = seed.items.find(record => record.login?.username === registeredUsername)!;
  check('registration creates one encrypted record with the correct username and new password',
    cipherCreates.length === 1 && created?.login?.password === registeredPassword
      && created.login.uris[0]?.uri === siteUrl && !JSON.stringify(cipherCreates).includes(registeredPassword));
  await submitCredentialForm(true);
  const change = await pendingCapture('update');
  check('change-password targets the existing login and awaits confirmation',
    change.pending.itemId === created.id && seed.items.find(record => record.id === created.id)?.login?.password === registeredPassword);
  check('change-password confirmation succeeds', (await saveCapture()).ok === true);
  const updatedLogin = seed.items.find(record => record.id === created.id)!;
  check('change-password saves the new password and preserves the old password in history',
    updatedLogin.login?.password === changedPassword && updatedLogin.passwordHistory[0]?.password === registeredPassword
      && cipherCreates.length === 1 && !JSON.stringify(cipherWrites).includes(changedPassword));

  await openPopup(true);
  await enterHome();
  await popup.waitForSelector('[aria-label="搜索条目"]', { visible: true });
  await screenshot('vault-440');
  if (process.env.ONEWARDEN_SMOKE_CLIPBOARD === '1') {
    const copyPassword = async () => {
      await click('.vault-list li > button span::-p-text(Alpha smoke login)');
      await click('div.group:has(> span[title="密码"]) button[aria-label="复制"]');
      await popup.waitForSelector('button[aria-label="已复制"]');
      check('real shared copy button writes the revealed password',
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
      await enterHome();
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
  await enterHome();
  await popup.waitForSelector('input[type="password"]', { visible: true });
  check('reopening preserves locked account state', (await rpc('snapshot')).result.status === 'locked');
  check('no uncaught UI errors', errors.length === 0, errors.join('\n'));
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(failure);
  if (popup) {
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
