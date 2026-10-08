#!/usr/bin/env bun
/** Real React/Zustand lifecycle checks in a disposable headless browser. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const app = resolve(import.meta.dir, '../apps/desktop');
const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, 'fixtures/zustand-state.tsx')], target: 'browser', format: 'iife',
  plugins: [{ name: 'workspace-react', setup(build) {
    build.onResolve({ filter: /^(react|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime)$/ }, args => ({ path: Bun.resolveSync(args.path, app) }));
  } }],
  define: { __PLATFORM__: JSON.stringify('desktop'), 'process.env.NODE_ENV': JSON.stringify('development') } });
if (!built.success) throw new Error(built.logs.join('\n'));
const bundle = await built.outputs[0]!.text();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  return new URL(request.url).pathname === '/bundle.js'
    ? new Response(bundle, { headers: { 'Content-Type': 'text/javascript' } })
    : new Response('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>', { headers: { 'Content-Type': 'text/html' } });
} });
const { default: puppeteer } = await import(pathToFileURL(process.env.ONEWARDEN_PUPPETEER!).href);
let browser: any;
const errors: string[] = []; const checks: string[] = [];
function check(name: string, passed: boolean) { if (!passed) throw new Error(name); checks.push(name); console.log(`PASS ${name}`); }
try {
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.ONEWARDEN_EDGE, pipe: false });
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (message: any) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.waitForFunction(() => (window as any).fixture.mounted === 2);
  check('StrictMode subscriptions have one live owner', await page.evaluate(() => (window as any).fixture.listeners === 1));
  const before = await page.evaluate(() => (window as any).fixture.renders.a);
  await page.type('#a-secret', 'synthetic-password');
  check('unrelated selector does not rerender', await page.evaluate((count: number) => (window as any).fixture.renders.a === count, before));
  check('two mounted form stores remain isolated', await page.$eval('#b-secret', (e: HTMLInputElement) => e.value === ''));
  await page.evaluate(() => { const update = (window as any).fixture.setters.a.setCount; update((n: number) => n + 1); update((n: number) => n + 1); });
  await page.waitForFunction(() => document.getElementById('a-count')?.textContent === '2');
  check('functional updates use the latest state', true);
  await page.evaluate(() => { (window as any).oldStore = (window as any).fixture.stores.a; (window as any).oldSetter = (window as any).fixture.setters.a.setSecret; (window as any).mount('a', 100); });
  check('rerender does not rerun initial state', await page.$eval('#a-count', (e: HTMLElement) => e.textContent === '2'));
  await page.evaluate(() => (window as any).mount('new-account', 7));
  await page.waitForFunction(() => document.getElementById('a-count')?.textContent === '7');
  check('keyed account change discards visible secret state', await page.$eval('#a-secret', (e: HTMLInputElement) => e.value === ''));
  await page.evaluate(() => (window as any).oldSetter('late response'));
  check('late writes to the detached store cannot alter the new account', await page.$eval('#a-secret', (e: HTMLInputElement) => e.value === ''));
  await page.evaluate(() => (window as any).bump());
  await page.waitForFunction(() => document.getElementById('snapshot')?.textContent === '1');
  check('controller adapter receives live Zustand snapshots', true);
  await page.evaluate(() => (window as any).empty());
  await page.waitForFunction(() => (window as any).fixture.mounted === 0 && (window as any).fixture.listeners === 0);
  check('unmount detaches controller subscriptions', true);
  check('no React warnings or runtime errors in lifecycle checks', errors.length === 0);
  await page.evaluate(() => (window as any).boundary(true));
  await page.waitForFunction(() => document.body.textContent?.includes('界面出错了'));
  check('initial render exception shows a recoverable fallback', await page.$eval('pre', (e: HTMLElement) => e.textContent === 'synthetic render failure'));
  await page.evaluate(() => (window as any).empty());
  await page.waitForFunction(() => document.getElementById('root')?.childElementCount === 0);
  await page.evaluate(() => (window as any).boundary(false));
  await page.waitForFunction(() => document.body.textContent?.includes('Healthy'));
  await page.evaluate(() => (window as any).boundary(true));
  await page.waitForFunction(() => document.body.textContent?.includes('界面出错了'));
  check('update render exception also shows the fallback', true);
  check('only expected synthetic errors were logged', errors.every(message => message.includes('synthetic render failure') || message.includes('above error occurred in the <Thrower>')));
  console.log(JSON.stringify({ checks: checks.length, expectedRenderErrors: errors.length }));
} finally { await browser?.close(); server.stop(true); }
