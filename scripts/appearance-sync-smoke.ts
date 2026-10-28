#!/usr/bin/env bun
/** Real Windows WebView, synthetic encrypted vault and SignalR push traffic.
 * All native config and WebView storage belong to this disposable test process. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { deriveMasterKey, encryptString, makeUserKey, stretchMasterKey } from '../packages/crypto/src/index';
import { decryptCipher, parseProfileSettings } from '../packages/vault/src/index';
import { createFakeServer } from '../packages/vault/src/testing/fake-server';
import { selectCustomServer } from './entry-smoke-helpers';
import { connectNativeBrowser } from './native-smoke-startup.mjs';

const { MessagePackHubProtocol } = await import(pathToFileURL(Bun.resolveSync('@microsoft/signalr-protocol-msgpack', resolve('packages/api'))).href);
const { default: puppeteer } = await import(pathToFileURL(process.env.ONEWARDEN_PUPPETEER!).href);
const output = mkdtempSync(join(tmpdir(), '1warden-appearance-sync-'));
const email = 'appearance-sync@example.invalid', password = 'Synthetic-Appearance-Sync!42';
const userKey = makeUserKey(), protocol = new MessagePackHubProtocol();
const sockets = new Set<any>(), checks: string[] = [], errors: string[] = [];
let profileCipher: any, revision = 0, writes = 0, syncing = 0, syncs = 0, slow = false;
const encryptedName = await encryptString('Synthetic selected login', userKey);
const records = Array.from({ length: 200 }, (_, index) => ({ id: `synthetic-${index}`, type: 1, name: encryptedName,
  notes: null, login: { username: null, password: null, uris: [] }, fields: [], favorite: false,
  creationDate: '2026-01-01T00:00:00Z', revisionDate: '2026-01-01T00:00:00Z' }));
const notify = () => { for (const socket of sockets) socket.send(protocol.writeMessage({ type: 1, target: 'ReceiveMessage', arguments: [{ Type: 1 }] })); };
let fake: ReturnType<typeof createFakeServer>;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/notifications/hub' && server.upgrade(request)) return undefined;
  if (path === '/api/sync') {
    syncing++; syncs++;
    try {
      if (slow) await Bun.sleep(800);
      return Response.json({ profile: { id: 'synthetic-user', email }, ciphers: [...records, ...(profileCipher ? [profileCipher] : [])], folders: [], collections: [] });
    } finally { syncing--; }
  }
  if (path.startsWith('/api/ciphers') && ['POST', 'PUT'].includes(request.method)) {
    const body = await request.json();
    if (profileCipher && body.lastKnownRevisionDate !== profileCipher.revisionDate) return Response.json({ message: 'Synthetic revision conflict' }, { status: 409 });
    const date = new Date(Date.now() + ++revision).toISOString();
    profileCipher = { ...body, id: 'synthetic-profile', creationDate: profileCipher?.creationDate ?? date, revisionDate: date };
    writes++; if (slow) notify(); return Response.json(profileCipher);
  }
  return fake.fetchImpl(request.url, { method: request.method });
}, websocket: {
  message(socket, value) { if (typeof value === 'string') { socket.send('{}\u001e'); sockets.add(socket); } },
  close(socket) { sockets.delete(socket); },
} });
fake = createFakeServer({ userKey, stretchedMasterKey: await stretchMasterKey(await deriveMasterKey(password, email, { kdf: 0, iterations: 1000 })),
  override: path => path === '/api/accounts/revision-date' ? new Response(String(Date.now())) : undefined });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function check(label: string, value: unknown) { if (!value) throw Error(label); checks.push(label); console.log(`PASS ${label}`); }
async function until(predicate: () => unknown | Promise<unknown>, label: string) {
  for (let i = 0; i < 120; i++) { if (await predicate()) return; await pause(100); } throw Error(label);
}
async function preferences() { return profileCipher ? parseProfileSettings(await decryptCipher(profileCipher, userKey)).preferences : null; }
let browser: any, page: any, app: ReturnType<typeof spawn> | undefined, pushTimer: ReturnType<typeof setInterval> | undefined;
async function input(selector: string, value: string) {
  await page.$eval(selector, (node: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function button(label: string) {
  const node = await page.evaluateHandle((label: string) => [...document.querySelectorAll('button')].find(n => n.textContent?.trim() === label && n.getClientRects().length), label);
  if (!node.asElement()) throw Error(`Missing button ${label}`);
  await node.asElement().click(); await node.dispose();
}
try {
  const portServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = portServer.port; portServer.stop(true);
  const roaming = join(output, 'native-config/roaming'), local = join(output, 'native-config/local');
  mkdirSync(roaming, { recursive: true }); mkdirSync(local, { recursive: true });
  app = spawn(process.env.ONEWARDEN_NATIVE_EXE!, [], { windowsHide: true, env: { ...process.env, APPDATA: roaming, LOCALAPPDATA: local,
    WEBVIEW2_USER_DATA_FOLDER: join(output, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` } });
  browser = await connectNativeBrowser({ app, connect: (options: any) => puppeteer.connect(options), browserURL: `http://127.0.0.1:${port}` });
  await until(async () => { page = (await browser.pages()).find((p: any) => p.url() === 'http://tauri.localhost/'); return page; }, 'main WebView');
  page.setDefaultTimeout(10000); page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.waitForSelector('[data-add-server]'); await button('登录'); await page.waitForSelector('input[type=email]');
  await selectCustomServer(page); await input('input[type=url]', `http://127.0.0.1:${server.port}`);
  await input('input[type=email]', email); await input('input[type=password]', password); await page.click('button[type=submit]');
  await page.waitForSelector('.vault-list ul > li > button');
  await until(async () => profileCipher && parseProfileSettings(await decryptCipher(profileCipher, userKey)).devices.length > 0 && !syncing, 'verified profile and device registration');
  await until(() => sockets.size > 0, 'SignalR connection established');
  check('actual SignalR notification connection is established', sockets.size > 0);
  await input('input[aria-label="搜索条目"]', 'Synthetic');
  await page.waitForSelector('.vault-list ul > li > button');
  await page.click('.vault-list ul > li > button'); await page.waitForSelector('.item-detail');
  await page.evaluate(() => { (window as any).__selectedBeforeSync = document.querySelector('.item-detail'); });
  await page.click('[aria-label="账户菜单"]'); await button('设置'); await page.waitForSelector('.palette-trigger');
  await page.evaluate(() => {
    const state = { picker: document.querySelector('.appearance-picker'), rootMutations: 0, removedDetails: 0 };
    (window as any).__syncProbe = state;
    new MutationObserver(records => {
      for (const record of records) {
        if (record.target === document.documentElement) state.rootMutations++;
        for (const node of record.removedNodes) if (node instanceof Element && (node.matches('.item-detail') || node.querySelector('.item-detail'))) state.removedDetails++;
      }
    }).observe(document.documentElement, { attributes: true, childList: true, subtree: true });
  });
  slow = true; notify(); await until(() => syncing > 0, 'background sync begins');
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  check('appearance remains enabled during an already verified background sync', !await page.$eval('.appearance-picker', (node: Element) => node.closest('fieldset')!.disabled));
  await page.click('.appearance-mode:has(.mode-dark)');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { timeout: 500 });
  await page.click('.palette-trigger'); await page.click('[role=option][id$="-whale"]');
  check('palette and mode clicks apply immediately while sync is busy', await page.$eval('html', (node: HTMLElement) => node.dataset.palette === 'whale' && node.dataset.theme === 'dark'));
  // Each 800ms sync leaves only 400ms of readiness. A timer restarted by every
  // snapshot can never reach its 650ms delay; an edit-owned deadline can.
  pushTimer = setInterval(notify, 1200);
  for (const mode of ['light', 'dark', 'light']) {
    await page.click(`.appearance-mode:has(.mode-${mode})`);
    await page.waitForFunction((mode: string) => document.documentElement.dataset.theme === mode, { timeout: 500 }, mode);
    await pause(200);
  }
  await until(async () => { const value = await preferences(); return value?.mode === 'light' && value.palette === 'whale'; }, 'last click is eventually saved during repeated background sync');
  check('latest appearance selection saves despite frequent push traffic', true);
  await pause(1000);
  const before = await page.evaluate(() => (window as any).__syncProbe.rootMutations), writesBeforeIdle = writes;
  await pause(2800);
  const metrics = await page.evaluate(() => ({ rootMutations: (window as any).__syncProbe.rootMutations,
    removedDetails: (window as any).__syncProbe.removedDetails,
    retainedPicker: (window as any).__syncProbe.picker === document.querySelector('.appearance-picker'),
    retainedDetail: (window as any).__selectedBeforeSync === document.querySelector('.item-detail') }));
  check('idle sync leaves the appearance and selected detail DOM mounted', metrics.retainedPicker && metrics.retainedDetail && metrics.removedDetails === 0);
  check('idle sync does not rewrite root theme attributes or colors', metrics.rootMutations === before);
  check('incoming snapshots do not echo preference writes', writes === writesBeforeIdle);
  clearInterval(pushTimer); pushTimer = undefined;
  records[0]!.name = await encryptString('Synthetic updated login', userKey); records[0]!.revisionDate = '2026-02-01T00:00:00Z';
  notify(); await page.waitForFunction(() => document.querySelector('.item-detail')?.textContent?.includes('Synthetic updated login'));
  check('a genuine selected-record revision still refreshes the detail', await page.evaluate(() => (window as any).__selectedBeforeSync !== document.querySelector('.item-detail')));
  check('no application runtime errors', errors.length === 0);
  await page.screenshot({ path: join(output, 'appearance-sync.png') });
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, errors, syncs, writes, metrics }, null, 2));
  console.log(`PASS ${checks.length} native appearance sync checks; ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, errors, syncs, writes, error: String(error) }, null, 2));
  console.log(`Failure evidence: ${output}`); throw error;
} finally {
  clearInterval(pushTimer); if (browser) await browser.disconnect();
  if (app && app.exitCode === null) app.kill(); server.stop(true);
}
