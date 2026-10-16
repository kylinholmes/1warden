#!/usr/bin/env bun
/** Local-only production-extension smoke. All keyboard/mouse actions go through CDP. */
import puppeteer, { type Page, type Frame, type Browser } from 'puppeteer-core';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve(import.meta.dir, '../apps/desktop/dist-extension');
const executablePath = process.env.ONEWARDEN_BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if (!existsSync(executablePath) || !existsSync(join(dist, 'background.js'))) throw Error('Build the extension and install Edge (or set ONEWARDEN_BROWSER_PATH) first.');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
  .flatMap(byte => [byte >> 4, byte & 15]).map(n => String.fromCharCode(97 + n)).join('');
const artifacts = mkdtempSync(join(tmpdir(), 'onewarden-credential-smoke-artifacts-'));
const profile = mkdtempSync(join(tmpdir(), 'onewarden-credential-smoke-profile-'));
const baseStyle = `<style>body{font:16px/1.5 system-ui;background:#f4f7fb;color:#233247;margin:0;padding:56px}main{background:white;border:1px solid #dbe3ef;border-radius:18px;padding:32px;width:490px;box-shadow:0 8px 30px #20304010}h1{margin-top:0}label{display:block;font-size:14px;margin:18px 0 6px}input{box-sizing:border-box;width:100%;font:inherit;padding:10px;border:1px solid #a6b6cc;border-radius:7px}button{margin-top:24px;font:inherit;padding:10px 20px;border:0;border-radius:8px;background:#1465d9;color:white}iframe{width:850px;height:700px;border:1px solid #ccc}</style>`;
const form = (kind: string, prefix = '') => `<form id="${prefix}f"><label>Username<input id="${prefix}u" autocomplete="username"></label><label>Password<input id="${prefix}p" type="password" autocomplete="${kind === 'signup' ? 'new-password' : 'current-password'}"></label>${kind === 'signup' ? `<label>Confirm password<input id="${prefix}c" name="confirm" type="password" autocomplete="new-password"></label>` : ''}<button id="${prefix}go">${kind === 'signup' ? 'Register' : 'Log in'}</button></form>`;
const html = (title: string, body: string, script = '') => `<!doctype html><meta charset="utf-8"><title>${title}</title>${baseStyle}<main><h1>${title}</h1>${body}</main><script>${script}</script>`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  let body: string;
  if (path === '/signup' || path === '/generate') body = html('Create account', form('signup'), `f.addEventListener('submit',e=>{e.preventDefault();p.value='';c.value=''})`);
  else if (path === '/login') body = html('Sign in', form('login'), `f.addEventListener('submit',e=>e.preventDefault())`);
  else if (path === '/navigate') body = html('Create account', form('signup'), `go.addEventListener('click',e=>{e.preventDefault();p.value='';c.value='';location.assign('/done')})`);
  else if (path === '/done') body = html('Account created', '<p>The original form was cleared during navigation.</p>');
  else if (path === '/frame') body = `<!doctype html><title>Same-origin frame</title>${baseStyle}<iframe src="/signup"></iframe>`;
  else if (path === '/multiple') body = html('Independent accounts', form('login', 'a') + form('signup', 'b'), `af.addEventListener('submit',e=>e.preventDefault());bf.addEventListener('submit',e=>e.preventDefault())`);
  else if (path === '/spa') body = html('SPA account', '<button id="render">Continue</button><div id="route"></div>', `render.onclick=()=>{history.pushState({},'', '/spa/step');route.innerHTML='<section><label>Username<input id="u" autocomplete="username"></label><label>New password<input id="p" autocomplete="new-password" type="password"></label><label>Confirm password<input id="c" name="confirm" type="password"></label><button id="go" type="button">Register</button></section>';go.onclick=()=>{p.value='';c.value=''}}`);
  else body = html('Fixture', '<p>Local synthetic smoke fixture.</p>');
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
} });
// A non-localhost HTTP hostname exercises the actual insecure-document crypto path.
const site = `http://credential-smoke.test:${server.port}`;
let browser: Browser | undefined;
let trusted: Page;
let checks = 0;
const errors: string[] = [];
function check(name: string, ok: boolean): void { if (!ok) throw Error(name); checks++; console.log(`✓ ${name}`); }
async function until<T>(name: string, read: () => Promise<T>, accept: (value: T) => boolean, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() > deadline) throw Error(`Timed out: ${name}`); await new Promise(done => setTimeout(done, 100)); }
}
async function message<T = any>(request: unknown): Promise<T> {
  const result = await trusted.evaluate(request => chrome.runtime.sendMessage(request), request);
  if (result?.error) throw Error(result.error); return result as T;
}
async function pending(): Promise<any[]> { return message({ type: '1warden:credential-list' }); }
async function dismiss(): Promise<void> { for (const row of await pending()) await message({ type: '1warden:credential-dismiss', id: row.id }); }
async function capture(username: string, action: string): Promise<any> {
  const rows = await until(`capture ${username}`, pending, rows => rows.some(row => row.username === username));
  const row = rows.find(row => row.username === username); check(`${username}: ${action} classification`, row.action === action); return row;
}
async function typeInto(frame: Page | Frame, page: Page, selector: string, value: string): Promise<void> {
  await frame.focus(selector); await page.keyboard.type(value, { delay: 10 });
}
async function fillForm(page: Page, username: string, password: string, signup = true, frame: Page | Frame = page, prefix = ''): Promise<void> {
  await typeInto(frame, page, `#${prefix}u`, username); await typeInto(frame, page, `#${prefix}p`, password);
  if (signup) await typeInto(frame, page, `#${prefix}c`, password);
  await page.keyboard.press('Escape');
}
interface Node { nodeId: number; nodeName: string; nodeValue: string; attributes?: string[]; children?: Node[]; shadowRoots?: Node[] }
function nodes(root: Node): Node[] { return [root, ...(root.children ?? []).flatMap(nodes), ...(root.shadowRoots ?? []).flatMap(nodes)]; }
function text(root: Node): string { return [root.nodeValue ?? '', ...(root.children ?? []).map(text)].join(''); }
async function panelNode(page: Page, kind: string, tag: string, label?: string): Promise<{ nodeId: number; client: Awaited<ReturnType<Page['createCDPSession']>> }> {
  const client = await page.createCDPSession();
  const nodeId = await until('closed shadow panel control', async () => {
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = nodes(root as Node).find(node => {
      const attrs = node.attributes ?? [];
      if (kind === 'picker') return attrs.includes('data-onewarden-inline');
      const at = attrs.indexOf('data-onewarden-credentials'); return at >= 0 && attrs[at + 1] === kind;
    });
    if (!host) return 0;
    return nodes(host).find(node => node.nodeName === tag && (label === undefined || text(node).trim() === label))?.nodeId ?? 0;
  }, Boolean);
  return { nodeId, client };
}
async function panelClick(page: Page, label: string, kind = 'generator'): Promise<void> {
  const { nodeId, client } = await panelNode(page, kind, 'BUTTON', label);
  const { model } = await client.send('DOM.getBoxModel', { nodeId }); const q = model.content;
  await page.mouse.click((q[0]! + q[4]!) / 2, (q[1]! + q[5]!) / 2); await client.detach();
}
async function panelControlClick(page: Page, tag: string, label?: string): Promise<void> {
  const { nodeId, client } = await panelNode(page, 'generator', tag, label);
  const { model } = await client.send('DOM.getBoxModel', { nodeId }); const q = model.content;
  await page.mouse.click((q[0]! + q[4]!) / 2, (q[1]! + q[5]!) / 2); await client.detach();
}
async function panelControlVisible(page: Page, tag: string, label: string): Promise<boolean> {
  const { nodeId, client } = await panelNode(page, 'generator', tag, label);
  try { const { model } = await client.send('DOM.getBoxModel', { nodeId }); return model.width > 0 && model.height > 0; }
  catch { return false; } finally { await client.detach(); }
}
async function tabId(page: Page): Promise<number> {
  const url = page.url(); return trusted.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, url);
}
async function isolatedInfo(page: Page): Promise<any> {
  const id = await tabId(page);
  return trusted.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id }, func: () => ({
    secure: isSecureContext, subtle: !!crypto.subtle, randomUUID: typeof crypto.randomUUID,
    bridge: !!(globalThis as any).__onewardenCredential,
  }) }))[0]!.result, id);
}
async function grantInfo(page: Page): Promise<any> {
  const id = await tabId(page);
  return trusted.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id }, func: async () => {
    const bridge = (globalThis as any).__onewardenCredential;
    const reply = await chrome.runtime.sendMessage({ type: '1warden:credential-document', nonce: bridge?.nonce });
    return { url: location.href, unlocked: reply?.unlocked, error: reply?.error, noticeCount: reply?.notices?.length };
  } }))[0]!.result, id);
}
async function screenshot(page: Page, name: string): Promise<void> { await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true, timeout: 8000 }); }

try {
  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile,
    args: ['--disable-features=DisableLoadExtensionCommandLineSwitch', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
      '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP credential-smoke.test 127.0.0.1'],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  await browser.waitForTarget(target => target.type() === 'service_worker' && target.url().includes(extensionId), { timeout: 15_000 });
  trusted = await browser.newPage(); await trusted.goto(`chrome-extension://${extensionId}/popup.html`);
  const account = { serverUrl: site, email: 'synthetic-smoke@example.test', userId: 'synthetic-user', kdf: { kdf: 0, iterations: 1000 } };
  const key = { encKey: randomBytes(32).toString('base64'), macKey: randomBytes(32).toString('base64') };
  const item = { id: 'existing-smoke', type: 'login', rawType: 1, name: 'Existing smoke account', nameFailed: false, notes: null, notesFailed: false,
    folderId: null, favorite: false, reprompt: 0, createdAt: '', updatedAt: '2026-10-16T00:00:00.000Z', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { username: 'existing-user', password: 'old-known-secret', totp: null, uris: [{ uri: `${site}/login`, match: null }], passwordRevisionDate: null, fido2Credentials: [] },
    card: null, identity: null, secureNote: null, sshKey: null, customFields: [], passwordHistory: [], attachments: [] };
  await trusted.evaluate(async ({ account, key, item }) => {
    const stored = { account, userKey: key, items: [item], folders: [], token: { accessToken: 'synthetic-local-only' }, expiresAt: Date.now() + 15 * 60_000, sessionId: 'synthetic-smoke-session' };
    await chrome.storage.session.set({ '1warden.account': account, '1warden.session': stored, '1warden.sessions': { [JSON.stringify([account.serverUrl, account.email])]: stored } });
  }, { account, key, item });
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 960 });
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${site}/signup`); await page.bringToFront();
  const info = await until('isolated bridge', () => isolatedInfo(page), info => info.bridge);
  check('actual insecure HTTP content world lacks subtle and randomUUID', !info.secure && !info.subtle && info.randomUUID === 'undefined');
  await page.evaluate(() => { (document.querySelector('#u') as HTMLInputElement).value = 'script-only-user'; (document.querySelector('#p') as HTMLInputElement).value = 'script-only-password'; (document.querySelector('#c') as HTMLInputElement).value = 'script-only-password'; (document.querySelector('form') as HTMLFormElement).requestSubmit(); });
  await new Promise(done => setTimeout(done, 400)); check('scripted requestSubmit alone produces no credential capture', (await pending()).length === 0);
  await page.reload(); await fillForm(page, 'signup-user', 'typed-signup-secret'); await page.click('#go');
  await capture('signup-user', 'save'); await page.waitForSelector('[data-onewarden-credentials="notice"]'); await screenshot(page, 'signup-notice'); await dismiss();

  await page.goto(`${site}/generate`); await page.focus('#p'); await page.waitForSelector('[data-onewarden-credentials="generator"]');
  await panelClick(page, '生成并填充');
  const generated = await until('generated password and confirmation', () => page.evaluate(() => ({ password: (document.querySelector('#p') as HTMLInputElement).value, confirm: (document.querySelector('#c') as HTMLInputElement).value })), value => value.password.length === 20 && value.password === value.confirm);
  check('real generator fills primary and confirmation through native setters on insecure HTTP', generated.password.length === 20);
  check('generator panel remains available after disabling its focused action during fill', await page.evaluate(() => !!document.querySelector('[data-onewarden-credentials="generator"]')));
  check('manual replacement consent stays hidden for generator-owned values', !await panelControlVisible(page, 'LABEL', '替换我已输入的内容'));
  const history = await message<any[]>({ type: '1warden:credential-history' });
  check('generator persists recovery history', history.length === 1);
  const raw = await trusted.evaluate(() => chrome.storage.local.get(null));
  check('history is ciphertext in local storage', !JSON.stringify(raw).includes(generated.password) && Object.entries(raw).some(([key, value]) => key.startsWith('1warden.generated-passwords:') && Array.isArray(value) && typeof value[0] === 'string' && value[0].startsWith('2.')));
  check('trusted explicit history reveal recovers the generated password', await message({ type: '1warden:credential-reveal-history', id: history[0].id }) === generated.password);
  await panelClick(page, '重新生成并填充');
  const regenerated = await until('regeneration', () => page.$eval('#p', node => (node as HTMLInputElement).value), value => value !== generated.password && value.length === 20);
  check('regeneration replaces generator-owned values without manual overwrite consent', !!regenerated);
  await panelControlClick(page, 'INPUT'); await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); await page.keyboard.type('24');
  check('changing generator settings does not change page values before explicit fill', await page.$eval('#p', node => (node as HTMLInputElement).value) === regenerated);
  await panelClick(page, '重新生成并填充');
  await until('24 character explicit generation', () => page.$eval('#p', node => (node as HTMLInputElement).value.length), length => length === 24);
  await page.focus('#p'); await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); await page.keyboard.type('manually-edited-secret');
  await panelClick(page, '重新生成并填充');
  check('manual password overwrite requires a separate visible confirmation', await page.$eval('#p', node => (node as HTMLInputElement).value) === 'manually-edited-secret');
  await panelControlClick(page, 'LABEL', '替换我已输入的内容'); await panelClick(page, '重新生成并填充');
  await until('approved manual replacement', () => page.evaluate(() => ({ password: (document.querySelector('#p') as HTMLInputElement).value, confirm: (document.querySelector('#c') as HTMLInputElement).value })), value => value.password.length === 24 && value.password === value.confirm);
  check('explicit replacement fills both password controls', true);
  await screenshot(page, 'generator-success'); await page.keyboard.press('Escape');

  await page.goto(`${site}/login`); await page.focus('#p'); await panelClick(page, '生成新密码…', 'picker');
  await page.waitForSelector('[data-onewarden-credentials="generator"]');
  check('plain login offers a secondary generator and coordinates one overlay', await page.evaluate(() => !document.querySelector('[data-onewarden-inline]'))); await page.keyboard.press('Escape');
  await page.goto(`${site}/login`); await fillForm(page, 'existing-user', 'updated-known-secret', false); await page.click('#go');
  await capture('existing-user', 'update'); await screenshot(page, 'update-notice'); await dismiss();
  await page.goto(`${site}/login`); await fillForm(page, 'existing-user', 'old-known-secret', false); await page.click('#go');
  await new Promise(done => setTimeout(done, 400)); check('unchanged credentials suppress prompts', (await pending()).length === 0);

  await page.goto(`${site}/navigate`); await fillForm(page, 'navigation-user', 'navigation-password');
  await Promise.all([page.waitForNavigation(), page.click('#go')]); await capture('navigation-user', 'save');
  await page.waitForSelector('[data-onewarden-credentials="notice"]'); check('immediate clearing and navigation restore the same-origin notice', page.url().endsWith('/done')); await screenshot(page, 'navigation-restored'); await dismiss();

  await page.goto(`${site}/spa`); await page.click('#render'); await fillForm(page, 'spa-user', 'spa-password'); await page.click('#go');
  await capture('spa-user', 'save'); check('SPA route and semantic formless registration capture', page.url().endsWith('/spa/step')); await dismiss();

  await page.goto(`${site}/multiple`); await fillForm(page, 'second-form-user', 'second-form-password', true, page, 'b'); await page.click('#bgo');
  await capture('second-form-user', 'save'); check('multiple independent forms capture only the submitted signup', (await pending()).length === 1); await dismiss();

  await page.goto(`${site}/frame`); const frame = await until('same-origin fixture frame', async () => page.frames().find(frame => frame.url() === `${site}/signup`) ?? null, Boolean);
  await fillForm(page, 'frame-user', 'frame-password', true, frame!); await frame!.click('#go');
  await capture('frame-user', 'save'); check('same-origin iframe trusted interaction captures credentials', true); await screenshot(page, 'same-origin-frame');
  check('page has no unhandled script exceptions', errors.length === 0);
  console.log(`\n${checks} checks passed. Screenshots: ${artifacts}`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  if (browser) for (const [index, page] of (await browser.pages()).entries()) if (page.url().startsWith(site)) {
    console.error('fixture grant metadata', await grantInfo(page).catch(error => String(error)));
    await screenshot(page, `failure-${index}`).catch(() => {});
  }
  console.error(`Screenshots: ${artifacts}`); process.exitCode = 1;
} finally {
  const cleanupTimeout = setTimeout(() => browser?.process()?.kill(), 5000); cleanupTimeout.unref();
  await browser?.close().catch(() => {}); clearTimeout(cleanupTimeout); server.stop(true);
  // Delete only the verified, task-created profile directory; keep screenshots for review.
  if (resolve(profile).startsWith(resolve(tmpdir()) + '\\') || resolve(profile).startsWith(resolve(tmpdir()) + '/')) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
