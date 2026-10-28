#!/usr/bin/env bun
import { launchSmokeBrowser, closeSmokeBrowser } from './smoke-processes.mjs';
/** Real update components/controller with an injected download, using a disposable headless Edge profile. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dir, '..');
const fixture = mkdtempSync(join(tmpdir(), '1warden-updater-ui-'));
const profile = mkdtempSync(join(tmpdir(), '1warden-updater-browser-'));
const output = process.env.ONEWARDEN_UPDATER_UI_OUTPUT ?? join(tmpdir(), '1warden-updater-ui-review');
mkdirSync(output, { recursive: true });
const entry = join(fixture, 'main.tsx');
writeFileSync(entry, `
import React from ${JSON.stringify(Bun.resolveSync('react', join(root, 'apps/desktop')))};
import { createRoot } from ${JSON.stringify(Bun.resolveSync('react-dom/client', join(root, 'apps/desktop')))};
import AppUpdates from ${JSON.stringify(join(root, 'apps/desktop/src/components/AppUpdates.tsx'))};
import AppUpdateNotice from ${JSON.stringify(join(root, 'apps/desktop/src/components/AppUpdateNotice.tsx'))};
import { createAppUpdater } from ${JSON.stringify(join(root, 'apps/desktop/src/updates/controller.ts'))};
const mode = new URLSearchParams(location.search).get('mode');
window.fixture = {available:false, checks:0, installs:0, closes:0, restarts:0, failRestart:true, finish:null, progress:null};
const updater = createAppUpdater({
 currentVersion:async()=> '0.1.0',
 check:async()=>{
  window.fixture.checks++;
  if(!window.fixture.available) return null;
  return {version:'0.2.0',
   ...(['manual','mobile'].includes(mode) ? {manual:mode==='mobile' ? '请通过原安装渠道（应用商店、测试分发或安装包）检查并更新移动端。' : '请通过原安装渠道更新，手动加载的扩展需下载新包并重新加载。'} : {}),
   ...(mode==='windows' ? {installOnRestart:async()=>{window.fixture.restarts++}} : {}),
   close:async()=>{window.fixture.closes++},downloadAndInstall:async(progress)=>{
   if(mode==='failure') throw Error('synthetic signature failure');
   window.fixture.installs++;window.fixture.progress=progress;
   progress({event:'Started',data:{contentLength:1000}});progress({event:'Progress',data:{chunkLength:400}});
   await new Promise(resolve=>window.fixture.finish=resolve);
  }};
 },
 restart:async()=>{window.fixture.restarts++;if(window.fixture.failRestart) throw new Error('Synthetic restart failure')}
});
window.fixture.check=()=>updater.check();window.fixture.dispose=()=>updater.dispose();
updater.start();
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,
 React.createElement(AppUpdates,{updater}),React.createElement(AppUpdateNotice,{updater})));
`);
const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife',
  alias: { 'react/jsx-runtime': Bun.resolveSync('react/jsx-runtime', join(root, 'apps/desktop')) },
  define: { __PLATFORM__: JSON.stringify('desktop'), 'process.env.NODE_ENV': JSON.stringify('production') } });
if (!built.success) throw Error(built.logs.join('\n'));
const bundle = await built.outputs[0]!.text();
const mobileBuilt = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife',
  alias: { 'react/jsx-runtime': Bun.resolveSync('react/jsx-runtime', join(root, 'apps/desktop')) },
  define: { __PLATFORM__: JSON.stringify('mobile'), 'process.env.NODE_ENV': JSON.stringify('production') } });
if (!mobileBuilt.success) throw Error(mobileBuilt.logs.join('\n'));
const mobileBundle = await mobileBuilt.outputs[0]!.text();
const assetDirectory = [join(root, 'apps/desktop/dist/assets'), join(root, 'apps/desktop/dist-preview/assets')]
  .find(directory => existsSync(directory)) ?? join(root, 'apps/desktop/dist/assets');
const css = existsSync(assetDirectory) ? readdirSync(assetDirectory).filter((file) => file.endsWith('.css'))
  .map((file) => readFileSync(join(assetDirectory, file), 'utf8')).join('\n') : '';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  if (new URL(request.url).pathname === '/bundle.js') return new Response(bundle, { headers: { 'Content-Type': 'text/javascript' } });
  if (new URL(request.url).pathname === '/mobile.js') return new Response(mobileBundle, { headers: { 'Content-Type': 'text/javascript' } });
  if (new URL(request.url).pathname === '/styles.css') return new Response(css, { headers: { 'Content-Type': 'text/css' } });
  const script = new URL(request.url).searchParams.get('mode') === 'mobile' ? '/mobile.js' : '/bundle.js';
  return new Response(`<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><style>body{padding:24px}#root{width:min(380px,100%)}#outside{margin-top:24px}</style><div id="root"></div><button class="btn btn-quiet" id="outside">继续工作</button><script src="${script}"></script></html>`, { headers: { 'Content-Type': 'text/html' } });
} });
const { default: puppeteer } = await import(pathToFileURL(resolve(process.env.ONEWARDEN_PUPPETEER
  ?? Bun.resolveSync('puppeteer-core', root))).href);
const checks: string[] = [];
const errors: string[] = [];
let browser: any;
function check(name: string, passed: boolean) {
  if (!passed) throw Error(name);
  checks.push(name); console.log(`PASS: ${name}`);
}
try {
  browser = await launchSmokeBrowser(puppeteer, { executablePath: process.env.ONEWARDEN_EDGE
    ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
      : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), headless: true, userDataDir: profile });
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  async function action(label: string, scope = '#root') {
    const handle = await page.evaluateHandle((text: string, selector: string) => Array.from(document.querySelectorAll(`${selector} button`))
      .find((button) => button.textContent?.trim() === text), label, scope);
    if (!handle.asElement()) throw Error(`Missing update action: ${label}`);
    await handle.asElement().click(); await handle.dispose();
  }
  await page.waitForFunction(() => document.getElementById('app-updates-heading')?.parentElement?.textContent?.includes('0.1.0'));
  check('settings shows the installed app version', true);
  await action('检查更新');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="status"]')).some((node) => node.textContent === '已是最新版本。'));
  check('manual check reports no available update without restarting or showing a popup', await page.evaluate(() =>
    (window as any).fixture.checks === 1 && (window as any).fixture.restarts === 0 && !document.querySelector('[data-app-update-notice]')));
  await page.evaluate(() => { (window as any).fixture.available = true; });
  await action('检查更新');
  await page.waitForSelector('[role="progressbar"]');
  check('download progress is presented accessibly', await page.$eval('[role="progressbar"]', (node: Element) => node.getAttribute('aria-valuenow') === '40'));
  check('duplicate checks are disabled during a download', await page.$$eval('section button', (buttons: HTMLButtonElement[]) => buttons.every((button) => button.disabled)));
  await page.evaluate(() => (window as any).fixture.progress({ event: 'Finished' }));
  check('finished downloading still waits for installation before the restart popup', await page.evaluate(() =>
    !document.querySelector('[data-app-update-notice]') && document.body.textContent?.includes('正在准备更新…')));
  await page.click('#outside');
  await page.evaluate(() => (window as any).fixture.finish());
  await page.waitForSelector('[data-app-update-notice]');
  check('ready popup uses a polite announcement and leaves focus in the existing workflow', await page.evaluate(() =>
    document.querySelector('[data-app-update-notice] [role="status"]')?.getAttribute('aria-live') === 'polite'
    && document.activeElement?.id === 'outside'));
  check('ready popup offers later and restart without automatically restarting', await page.evaluate(() => {
    const notice = document.querySelector('[data-app-update-notice]')!;
    return notice.textContent?.includes('新版本已准备好') && notice.textContent.includes('稍后')
      && notice.textContent.includes('重启更新') && (window as any).fixture.restarts === 0;
  }));
  if (css) await page.screenshot({ path: join(output, 'restart-ready.png') });
  await action('重启更新', '[data-app-update-notice]');
  await page.waitForSelector('[data-app-update-notice] [role="alert"]');
  check('failed popup restart explains the failure and keeps its retry action', await page.evaluate(() =>
    document.querySelector('[data-app-update-notice] [role="alert"]')?.textContent === '无法重启，请稍后再试。'
    && (window as any).fixture.restarts === 1
    && Array.from(document.querySelectorAll('[data-app-update-notice] button'))
      .some((button) => button.textContent?.trim() === '重启更新' && !(button as HTMLButtonElement).disabled)));
  await action('稍后', '[data-app-update-notice]');
  check('later dismisses the popup and retains settings restart action', await page.evaluate(() =>
    !document.querySelector('[data-app-update-notice]')
    && Array.from(document.querySelectorAll('section button')).some((button) => button.textContent?.trim() === '重启更新')));
  await page.evaluate(() => (window as any).fixture.check());
  check('a ready bundle is not downloaded again and its dismissed popup does not reappear', await page.evaluate(() =>
    (window as any).fixture.checks === 2 && (window as any).fixture.installs === 1 && (window as any).fixture.closes === 1
    && !document.querySelector('[data-app-update-notice]')));
  await action('重启更新', 'section');
  await page.waitForSelector('[role="alert"]');
  check('failed explicit restart retains the prepared update and allows retry', await page.evaluate(() =>
    (window as any).fixture.restarts === 2 && Array.from(document.querySelectorAll('section button'))
      .some((button) => button.textContent?.trim() === '重启更新' && !(button as HTMLButtonElement).disabled)));
  await page.evaluate(() => { (window as any).fixture.failRestart = false; });
  await action('重启更新', 'section');
  check('only an explicit retry requests restart and disables repeated clicks', await page.evaluate(() =>
    (window as any).fixture.restarts === 3 && Array.from(document.querySelectorAll('section button')).every((button) => (button as HTMLButtonElement).disabled)));
  await page.evaluate(() => (window as any).fixture.dispose());
  for (const mode of ['manual', 'failure', 'windows', 'mobile']) {
    await page.setViewport({ width: mode === 'windows' ? 1080 : 390, height: 720 });
    await page.goto(`http://127.0.0.1:${server.port}/?mode=${mode}`);
    await page.waitForFunction(() => Boolean((window as any).fixture));
    await page.evaluate(() => { (window as any).fixture.available = true; void (window as any).fixture.check(); });
    if (mode === 'windows') {
      await page.waitForSelector('[role="progressbar"]');
      await page.evaluate(() => (window as any).fixture.finish());
    }
    await page.waitForSelector('[data-app-update-notice]');
    check(`${mode} shows the appropriate actionable notice without closing the application`, await page.evaluate((mode: string) => {
      const notice = document.querySelector('[data-app-update-notice]')!;
      return (window as any).fixture.restarts === 0 && (mode === 'windows'
        ? notice.textContent?.includes('安装并重启') && !notice.textContent.includes('等下次打开')
        : notice.textContent?.includes('请更新') && notice.textContent.includes(mode === 'mobile' ? '原安装渠道' : '前往更新') && !notice.textContent.includes('重启更新'));
    }, mode));
    check(`${mode} notice fits a narrow viewport`, await page.$eval('[data-app-update-notice]', (node: Element) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    }));
    if (css) await page.screenshot({ path: join(output, `${mode}-notice.png`) });
    if (mode === 'windows') {
      await action('安装并重启', '[data-app-update-notice]');
      await page.waitForFunction(() => (window as any).fixture.restarts === 1);
    } else if (mode === 'mobile') {
      check('mobile offers distribution guidance and a selectable release address', await page.evaluate(() =>
        document.querySelector('[data-app-update-notice] .select-text')?.textContent?.includes('github.com/kylinholmes/1warden/releases/latest')));
      await action('稍后', '[data-app-update-notice]');
      check('mobile retains distribution guidance in settings after dismissal', await page.evaluate(() =>
        !document.querySelector('[data-app-update-notice]') && document.querySelector('section')?.textContent?.includes('原安装渠道')));
    } else {
      // Intercept browser opening: this test never contacts the release site.
      await page.evaluate(() => { window.open = ((url: string) => { (window as any).openedRelease = url; return null; }) as any; });
      await action('前往更新', '[data-app-update-notice]');
      check(`${mode} opens only the trusted release page`, await page.evaluate(() =>
        (window as any).openedRelease === 'https://github.com/kylinholmes/1warden/releases/latest'));
      await action('稍后', '[data-app-update-notice]');
      check(`${mode} keeps the manual update action in settings after dismissal`, await page.evaluate(() =>
        !document.querySelector('[data-app-update-notice]') && document.querySelector('section')?.textContent?.includes('前往更新')));
    }
    await page.evaluate(() => (window as any).fixture.dispose());
  }
  check('no browser runtime errors', errors.length === 0);
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(`${checks.length} updater UI checks passed. Report: ${join(output, 'report.json')}`);
} finally {
  await closeSmokeBrowser(browser); server.stop(true);
  for (const directory of [fixture, profile]) {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw Error('Unsafe temporary directory cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
}
