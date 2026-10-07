#!/usr/bin/env bun
/** Real browser action popup geometry. Never emulate or set the popup viewport. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const product = process.argv[2];
if (product !== 'edge' && product !== 'zen') throw new Error('Usage: bun scripts/toolbar-popup-smoke.ts edge|zen');
const engine = product === 'edge' ? 'chrome' : 'firefox';
const headless = process.env.COFFER_SMOKE_HEADED !== '1';
const executable = process.env[`COFFER_${product.toUpperCase()}`] ?? (product === 'edge'
  ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '/Applications/Zen.app/Contents/MacOS/zen');
if (!existsSync(executable)) throw new Error(`Browser not found: ${executable}`);
const modulePath = process.env.COFFER_PUPPETEER;
const { default: puppeteer } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'puppeteer-core');
const dist = resolve(process.env.COFFER_TOOLBAR_DIST ?? join(import.meta.dir, '../apps/desktop', product === 'edge' ? 'dist-extension' : 'dist-firefox'));
const output = resolve(process.env.COFFER_SMOKE_OUT ?? join(tmpdir(), 'coffer-toolbar-smoke'));
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), `coffer-toolbar-${product}-`));
const uuid = '47bf0b27-4904-4824-8456-6619fc76c3a1';
function files(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(join(directory, entry.name), join(prefix, entry.name))
    : entry.isFile() && !entry.name.endsWith('.map') ? [join(prefix, entry.name)] : []);
}
const buildHashes = Object.fromEntries(files(dist).sort().map((file) => [file,
  createHash('sha256').update(readFileSync(join(dist, file))).digest('hex')]));
const observations: unknown[] = [];
let browser: any;
let failure = '';
let version = '';
let browserEnvironment: unknown;
try {
  browser = await puppeteer.launch({
    browser: engine, executablePath: executable, userDataDir: profile,
    headless,
    // Puppeteer must not resize a newly discovered native action popup.
    defaultViewport: null, enableExtensions: true, protocolTimeout: 60_000,
    // Chromium's default headless display is 800×600 even when its window is
    // larger. A native action popup is clamped to that display's work area.
    // Configure the virtual screen, never the extension popup's viewport.
    ...(engine === 'chrome' ? { pipe: true, args: ['--window-size=1200,900',
      ...(headless ? ['--screen-info={1600x1200}'] : [])] } : {
      args: ['--remote-allow-system-access', '--width=1200', '--height=900'],
      extraPrefsFirefox: { 'extensions.webextensions.uuids': JSON.stringify({ 'coffer@coffer.app': uuid }) },
    }),
  });
  version = await browser.version();
  console.log(`${product}: ${version}; PID ${browser.process()?.pid}; build ${dist}`);
  const extensionId = await browser.installExtension(dist);
  const origin = engine === 'chrome' ? `chrome-extension://${extensionId}` : `moz-extension://${uuid}`;
  // Firefox may include a non-tab extension context in browser.pages(). Its
  // tabs.getCurrent() has id -1, so create a real tab for the trusted controller.
  const control = await browser.newPage();
  if (engine === 'firefox') await control.mainFrame().browsingContext.navigate(`${origin}/popup.html`, 'interactive');
  else await control.goto(`${origin}/popup.html`, { waitUntil: 'domcontentloaded' });
  await control.waitForSelector('input[type="email"]');
  browserEnvironment = await control.evaluate(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return { screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth,
      availHeight: screen.availHeight, pixelRatio: devicePixelRatio },
      controllerWindow: { outerWidth, outerHeight, innerWidth, innerHeight },
      browserWindows: (await api.windows.getAll({ windowTypes: ['normal'] })).map((window: any) => ({
        width: window.width, height: window.height, left: window.left, top: window.top,
      })) };
  });
  console.log(JSON.stringify({ browserEnvironment }));
  console.log('Trusted control tab ready; opening actual browser action');
  const measure = async (state: string) => {
    await control.evaluate(async () => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      const tab = await api.tabs.getCurrent();
      if (tab?.id >= 0 && tab.windowId >= 0) {
        await api.windows.update(tab.windowId, { focused: true });
        await api.tabs.update(tab.id, { active: true });
        return;
      }
      // Zen can report a synthetic tab id for privileged BiDi contexts. Focus
      // an actual normal window in this isolated profile instead of passing -1.
      const windows = await api.windows.getAll({ windowTypes: ['normal'] });
      const window = windows.find((candidate: any) => candidate.focused) ?? windows[0];
      if (!window || window.id < 0) throw new Error('No normal browser window available for toolbar popup');
      await api.windows.update(window.id, { focused: true });
      const tabs = await api.tabs.query({ windowId: window.id });
      const target = tabs.find((candidate: any) => candidate.url === location.href)
        ?? tabs.find((candidate: any) => candidate.active);
      if (target?.id >= 0) await api.tabs.update(target.id, { active: true });
    });
    // Puppeteer's CDP/BiDi evaluation sets user activation for this call.
    await control.evaluate(() => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      // A collapsed native popup can prevent openPopup's Promise from settling.
      // Observe its registered view directly rather than awaiting that promise.
      void api.action.openPopup().catch((error: Error) => { (globalThis as any).__toolbarOpenError = error.message; });
    });
    await control.waitForFunction((expected: string) => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      const view = api.extension.getViews({ type: 'popup' })[0];
      return view?.document.querySelector(expected === 'connect' ? 'input[type="email"]' : '[aria-label="搜索条目"]');
    }, { timeout: 15_000 }, state);
    // Native popup sizing happens after layout and can involve multiple paints.
    await control.evaluate(async () => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      const view = api.extension.getViews({ type: 'popup' })[0];
      await new Promise((resolve) => view.setTimeout(resolve, 700));
    });
    const geometry = await control.evaluate(() => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      const views = api.extension.getViews({ type: 'popup' });
      const view = views[0];
      const box = (node: Element | null) => {
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight };
      };
      return { popupViewCount: views.length, url: view.location.href, innerWidth: view.innerWidth,
        innerHeight: view.innerHeight, html: box(view.document.documentElement), body: box(view.document.body),
        root: box(view.document.querySelector('#root')), text: view.document.body.innerText.slice(0, 150) };
    });
    observations.push({ state, ...geometry });
    console.log(JSON.stringify({ state, ...geometry }));
    await control.evaluate(() => {
      const api = (globalThis as any).browser ?? (globalThis as any).chrome;
      for (const view of api.extension.getViews({ type: 'popup' })) view.close();
    });
  };
  await measure('connect');
  await control.evaluate(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    const account = { serverUrl: 'https://synthetic.invalid', email: 'toolbar@example.invalid',
      userId: 'toolbar-smoke', kdf: { kdf: 0, iterations: 600000 } };
    const item = { id: 'toolbar-item', name: 'Toolbar smoke item', type: 'secureNote', rawType: 2,
      nameFailed: false, notes: 'Synthetic only', notesFailed: false, folderId: null, favorite: false,
      reprompt: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      deletedAt: null, archivedAt: null, wrappedKey: null, login: null, card: null, identity: null,
      secureNote: { type: 0 }, sshKey: null, customFields: [], passwordHistory: [], attachments: [] };
    await api.storage.session.set({ 'coffer.account': account, 'coffer.session': { account,
      userKey: { encKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(17))),
        macKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(23))) },
      items: [item], folders: [], token: null, expiresAt: Date.now() + 900000 } });
  });
  await measure('unlocked');
  for (const observation of observations as any[]) {
    if (observation.popupViewCount !== 1 || observation.innerWidth !== 440 || observation.innerHeight !== 600
      || observation.body.width !== 440 || observation.body.height !== 600
      || observation.root.width !== 440 || observation.root.height !== 600
      || observation.root.scrollWidth > 440 || observation.root.scrollHeight > 600) {
      throw new Error(`${observation.state}: native popup must be 440×600 without overflow; got ${JSON.stringify(observation)}`);
    }
  }
  console.log(`PASS ${product}: real toolbar popup is 440×600 in connect and unlocked states`);
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(failure);
} finally {
  await browser?.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
  writeFileSync(join(output, `${product}-toolbar-report.json`), JSON.stringify({ product, version, executable,
    extension: dist, buildHashes, headless, viewportOverridden: false, browserEnvironment, observations, passed: !failure, failure,
    timestamp: new Date().toISOString() }, null, 2) + '\n');
}
if (failure) process.exitCode = 1;
