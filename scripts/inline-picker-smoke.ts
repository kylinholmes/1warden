#!/usr/bin/env bun
/** Headless, disposable-profile UI checks for the real content bundle.
 * Build content to a temporary outDir, then pass its content.js path.
 * ONEWARDEN_PUPPETEER points to an external puppeteer-core module when needed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const product = process.argv[2];
const bundlePath = process.argv[3];
if ((product !== 'edge' && product !== 'zen') || !bundlePath) {
  throw new Error('Usage: bun scripts/inline-picker-smoke.ts edge|zen /path/to/content.js');
}
const executable = process.env[`ONEWARDEN_${product.toUpperCase()}`] ?? (product === 'edge'
  ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '/Applications/Zen.app/Contents/MacOS/zen');
if (!existsSync(executable)) throw new Error(`Browser unavailable: ${executable}`);
const { default: puppeteer } = await import(process.env.ONEWARDEN_PUPPETEER
  ? pathToFileURL(resolve(process.env.ONEWARDEN_PUPPETEER)).href : 'puppeteer-core');
const profile = mkdtempSync(join(tmpdir(), `onewarden-inline-ui-${product}-`));
const artifacts = process.env.ONEWARDEN_SMOKE_OUT ?? mkdtempSync(join(tmpdir(), 'onewarden-inline-ui-artifacts-'));
mkdirSync(artifacts, { recursive: true });
const bundle = readFileSync(resolve(bundlePath), 'utf8');
const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  if (new URL(request.url).pathname === '/content.js') return new Response(bundle, { headers: { 'Content-Type': 'text/javascript' } });
  return new Response(`<!doctype html><meta charset="utf-8"><title>Inline chooser UI fixture</title>
    <style>body{font:16px sans-serif;padding:50px}input{display:block;width:300px;padding:12px;margin:8px 0 24px}button{margin:10px}#outside{position:fixed;bottom:16px;right:16px}</style>
    <form><label>Email<input id="email" autocomplete="username"></label>
    <label>Password<input id="password" type="password" autocomplete="current-password"></label>
    <button id="outside" type="button">Outside</button></form>
    <script>
      window.fixture={locked:false,selected:null,unlockRequests:0,submissions:0,requests:[],focus:[],accountErrorOnce:null,pendingUnlock:false};
      document.addEventListener('focusout',()=>fixture.focus.push(document.activeElement?.tagName),true);
      const accounts=[{id:'a',title:'Personal account',username:'personal@example.invalid'},
        {id:'b',title:'Work account',username:'work@example.invalid'}];
      window.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async(message)=>{
        fixture.requests.push(message.type);
        if(message.type==='1warden:inline-accounts'){if(fixture.accountErrorOnce){const error=fixture.accountErrorOnce;fixture.accountErrorOnce=null;return{error}};return {unlocked:!fixture.locked,accounts:fixture.locked?[]:accounts}};
        if(message.type==='1warden:inline-fill'){fixture.selected=message.itemId;document.querySelector('#email').value=accounts.find(a=>a.id===message.itemId).username;return{ok:true}};
        if(message.type==='1warden:inline-unlock'){fixture.unlockRequests++;if(fixture.pendingUnlock)return new Promise(()=>{});return{error:'请点击浏览器工具栏中的 1Warden 图标解锁，然后回到此输入框选择账号。'}};
        if(message.type==='1warden:submitted')fixture.submissions++;
      }}};
      document.querySelector('form').onsubmit=e=>e.preventDefault();
    </script><script src="/content.js"></script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
} });
let browser: any;
let page: any;
let failure = '';
const checks: string[] = [];
function check(label: string, ok: boolean): void {
  if (!ok) throw new Error(label);
  checks.push(label);
  console.log(`✓ ${label}`);
}
try {
  browser = await puppeteer.launch({ browser: product === 'edge' ? 'chrome' : 'firefox',
    executablePath: executable, headless: true, userDataDir: profile });
  page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.setViewport({ width: 720, height: 580 });
  page.setDefaultTimeout(5000);
  await page.goto(`http://127.0.0.1:${site.port}/login`);
  await page.click('#email');
  await page.waitForSelector('[data-onewarden-inline]', { visible: true });
  check('chooser opens on username focus with a closed shadow root', await page.$eval('[data-onewarden-inline]', (host: HTMLElement) => host.shadowRoot === null));
  await page.screenshot({ path: join(artifacts, `${product}-accounts.png`) });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as any).fixture.selected === 'b');
  check('keyboard selects the second account and dismisses the chooser', await page.$('[data-onewarden-inline]') === null);
  check('chooser Enter does not signal a submitted password form', await page.evaluate(() => (window as any).fixture.submissions === 0));

  await page.click('#password');
  await page.waitForSelector('[data-onewarden-inline]', { visible: true });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-onewarden-inline]') === null);
  check('Escape dismisses and restores the original input focus', await page.evaluate(() => document.activeElement?.id === 'password'));
  await page.click('#password');
  await page.waitForSelector('[data-onewarden-inline]', { visible: true });
  await page.click('#outside');
  check('outside click dismisses', await page.$('[data-onewarden-inline]') === null);

  await page.evaluate(() => {
    const fixture = (window as any).fixture;
    fixture.locked = true; fixture.selected = null;
    fixture.accountErrorOnce = '请求已取消，保险库已锁定';
  });
  await page.click('#email');
  await page.waitForSelector('[data-onewarden-inline][data-state="error"]', { visible: true });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-onewarden-inline][data-state="locked"]', { visible: true });
  check('an expiry-cancelled account request can retry into the locked chooser', true);
  await page.screenshot({ path: join(artifacts, `${product}-locked.png`) });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as any).fixture.unlockRequests === 1);
  check('locked chooser requests trusted-popup unlock', true);
  await page.evaluate(() => { (window as any).fixture.locked = false; });
  // Allow the bounded visible-chooser refresh to observe the completed unlock.
  await page.waitForFunction(() => document.querySelector('[data-onewarden-inline]')?.getAttribute('data-state') === 'accounts');
  check('unlock refreshes account choices without automatically filling', await page.evaluate(() => (window as any).fixture.selected === null));
  await page.click('#email');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as any).fixture.selected === 'a');
  check('account selection resumes after unlock', true);

  await page.evaluate(() => { (window as any).fixture.locked = true; (window as any).fixture.pendingUnlock = true; });
  await page.click('#email');
  await page.waitForSelector('[data-onewarden-inline][data-state="locked"]', { visible: true });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as any).fixture.unlockRequests === 2);
  await page.evaluate(() => { (window as any).fixture.locked = false; });
  await page.waitForSelector('[data-onewarden-inline][data-state="accounts"]', { visible: true });
  check('unlock refresh resumes even if the popup-open reply remains pending', true);
  await page.keyboard.press('Escape');

  await page.setViewport({ width: 360, height: 480 });
  await page.click('#password');
  await page.waitForSelector('[data-onewarden-inline]', { visible: true });
  check('chooser stays within the narrow viewport', await page.$eval('[data-onewarden-inline]', (host: HTMLElement) => {
    const rect = host.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
  }));
  check('no uncaught page errors', errors.length === 0);
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(failure);
  if (page) console.error(await page.evaluate(() => ({ fixture: (window as any).fixture,
    active: { tag: document.activeElement?.tagName, id: document.activeElement?.id },
    chooserState: document.querySelector('[data-onewarden-inline]')?.getAttribute('data-state') })).catch(() => ({})));
} finally {
  await browser?.close().catch(() => {});
  site.stop(true);
  rmSync(profile, { recursive: true, force: true });
  writeFileSync(join(artifacts, `${product}-inline-ui-report.json`), JSON.stringify({
    product, executable, bundlePath: resolve(bundlePath), headless: true, disposableProfile: profile,
    passed: !failure, checks, failure, fixture: 'UI transport double; background security is covered separately',
  }, null, 2));
  console.log(`Artifacts: ${artifacts}`);
}
if (failure) process.exitCode = 1;
