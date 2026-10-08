#!/usr/bin/env bun
/** Exercise the real account-menu component with disposable storage and a headless browser. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dir, '..');
const fixture = mkdtempSync(join(tmpdir(), 'onewarden-account-menu-'));
const output = process.env.ONEWARDEN_ACCOUNT_MENU_OUTPUT ?? '/tmp/onewarden-account-menu-review';
mkdirSync(output, { recursive: true });
const entry = join(fixture, 'main.tsx');
writeFileSync(entry, `
import React from ${JSON.stringify(Bun.resolveSync('react', join(root, 'apps/desktop')))};
import { createRoot } from ${JSON.stringify(Bun.resolveSync('react-dom/client', join(root, 'apps/desktop')))};
import { ProfileAccountMenu } from ${JSON.stringify(join(root, 'apps/desktop/src/components/ProfileAccountMenu.tsx'))};
import { installHost } from ${JSON.stringify(join(root, 'packages/ui/src/host.ts'))};
const current = {serverUrl:'https://personal.example',email:'same@example.com',profile:{displayName:'Personal',avatarDataUrl:null}};
const other = {serverUrl:'https://work.example/team',email:'same@example.com'};
const locked = {serverUrl:'https://locked.example',email:'locked@example.com'};
const values = new Map([
 ['1warden.accounts', JSON.stringify([current,other,{...other,serverUrl:other.serverUrl+'/'},locked])],
 ['profile.v1.'+JSON.stringify([other.serverUrl,other.email]),JSON.stringify({displayName:'Work',avatarDataUrl:null})]
]);
window.fixture = {calls:[],writes:0,pending:false,reject:false,finish:null,focus:[]};
document.addEventListener('focusout',event=>window.fixture.focus.push({tag:event.target.tagName,disabled:event.target.disabled,to:event.relatedTarget?.tagName,busy:document.querySelector('[role="menu"]')?.getAttribute('aria-busy')}));
installHost({fetch:window.fetch.bind(window),storage:{
 get:async(key)=>values.get(key)??null,
 set:async(key,value)=>{window.fixture.writes++;values.set(key,value)},
 remove:async(key)=>{window.fixture.writes++;values.delete(key)}
}});
async function act(action,target) {
 window.fixture.calls.push({action,target});
 if(window.fixture.pending) await new Promise(resolve=>window.fixture.finish=resolve);
 if(window.fixture.reject) throw new Error('切换失败，请重试');
}
createRoot(document.getElementById('root')).render(React.createElement(ProfileAccountMenu, {
 account:current, syncing:false, unlockedAccounts:[JSON.stringify([other.serverUrl,other.email])],
 onProfile:()=>{window.fixture.calls.push({action:'profile'})},
 onSettings:()=>{window.fixture.calls.push({action:'settings'})},
 onLogout:()=>act('logout'),
 onSwitch:(account)=>act('switch',account)
}));
`);
const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife',
  alias: { 'react/jsx-runtime': Bun.resolveSync('react/jsx-runtime', join(root, 'apps/desktop')) },
  define: { __PLATFORM__: JSON.stringify('desktop'), 'process.env.NODE_ENV': JSON.stringify('production') } });
if (!built.success) throw new Error(built.logs.join('\n'));
const bundle = await built.outputs[0]!.text();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  if (new URL(request.url).pathname === '/bundle.js') return new Response(bundle, { headers: { 'Content-Type': 'text/javascript' } });
  return new Response('<!doctype html><meta charset="utf-8"><style>body{font:14px sans-serif;padding:24px}button{display:block;margin:6px;padding:8px}svg{width:16px;height:16px}#root{width:300px}</style><div id="root"></div><button id="outside">Outside</button><script src="/bundle.js"></script>', { headers: { 'Content-Type': 'text/html' } });
} });
const { default: puppeteer } = await import(pathToFileURL(resolve(process.env.ONEWARDEN_PUPPETEER
  ?? '/tmp/onewarden-browser-tools/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).href);
const checks: string[] = [];
const errors: string[] = [];
let browser: any;
function check(name: string, passed: boolean, data?: unknown) {
  if (!passed) throw new Error(`${name}: ${JSON.stringify(data)}`);
  checks.push(name); console.log(`✓ ${name}`);
}
try {
  browser = await puppeteer.launch({ executablePath: process.env.ONEWARDEN_EDGE
    ?? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: true });
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  async function open() {
    await page.click('[aria-label="账户菜单"]');
    await page.waitForFunction(() => document.getElementById('profile-account-menu')?.textContent?.includes('Work'));
  }
  async function action(text: string) {
    const handle = await page.evaluateHandle((label: string) => [...document.querySelectorAll('#profile-account-menu button')]
      .find(button => button.textContent?.trim() === label), text);
    const button = handle.asElement();
    if (!button) throw new Error(`Missing account-menu action: ${text}`);
    await button.click(); await handle.dispose();
  }
  await page.click('[aria-label="账户菜单"]');
  const menuText = await page.$eval('#profile-account-menu', (menu: HTMLElement) => menu.textContent);
  check('current account summary does not repeat the trigger avatar', await page.$eval('.account-menu-current', (row: Element) =>
    !row.querySelector('img, :scope > [aria-hidden="true"]')));
  check('avatar menu has one logout action labelled 登出 and no manual locking action',
    Boolean(menuText?.includes('设置')) && await page.$$eval('#profile-account-menu button', (buttons: Element[]) =>
      buttons.filter(button => button.textContent?.trim() === '登出').length === 1
      && buttons.every(button => !button.textContent?.includes('锁定') && !button.textContent?.includes('退出登录'))), menuText);
  await page.waitForFunction(() => document.getElementById('profile-account-menu')?.textContent?.includes('Work'));
  check('saved accounts distinguish identical emails on different servers', await page.$eval('#profile-account-menu', (menu: HTMLElement) =>
    menu.textContent?.includes('https://personal.example') && menu.textContent.includes('https://work.example/team')));
  check('equivalent saved server addresses do not create duplicate entries', await page.$$eval('[data-switch-account]', (items: Element[]) => items.length === 2));
  check('saved accounts show whether switching can reuse their unlocked session', await page.$$eval('[data-switch-account]', (items: Element[]) =>
    items[0]?.textContent?.includes('已解锁') && items[1]?.textContent?.includes('需要验证')));
  check('opening the menu only reads cached accounts and profiles', await page.evaluate(() => (window as any).fixture.writes === 0));
  await page.keyboard.press('Escape');
  check('Escape returns focus to avatar trigger', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '账户菜单'));
  await page.keyboard.press('ArrowDown');
  await page.waitForSelector('[role="menu"]');
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
  check('ArrowDown opens and focuses a menu action', await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'));
  await page.keyboard.press('End');
  check('End moves to logout', await page.evaluate(() => document.activeElement?.textContent?.includes('登出')));
  await page.keyboard.press('Home');
  check('Home returns to first enabled action', await page.evaluate(() => document.activeElement === document.querySelector('[role="menuitem"]:not(:disabled)')));
  await page.keyboard.press('Escape');
  await open(); await page.click('#outside');
  check('outside click closes the menu', await page.$('#profile-account-menu') === null);
  await open();
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  check('Tab leaves the menu without trapping focus', await page.evaluate(() => document.activeElement?.id === 'outside'
    && document.getElementById('profile-account-menu') === null));

  await open();
  await page.evaluate(() => { (window as any).fixture.pending = true; });
  await page.click('[data-switch-account]');
  check('switching disables every menu action while pending', await page.$$eval('#profile-account-menu button', (buttons: HTMLButtonElement[]) => buttons.length > 0 && buttons.every(button => button.disabled)));
  check('switch callback receives full server and email identity', await page.evaluate(() => {
    const call = (window as any).fixture.calls.at(-1);
    return call.action === 'switch' && call.target.serverUrl === 'https://work.example/team' && call.target.email === 'same@example.com';
  }));
  await page.evaluate(() => { (window as any).fixture.reject = true; (window as any).fixture.finish(); });
  await page.waitForSelector('[role="alert"]').catch(async (error: unknown) => {
    console.error(JSON.stringify(await page.evaluate(() => ({
      menu: document.getElementById('profile-account-menu')?.outerHTML,
      trigger: document.querySelector('[aria-label="账户菜单"]')?.outerHTML,
      active: document.activeElement?.outerHTML,
      fixture: (window as any).fixture,
    })), null, 2));
    throw error;
  });
  check('failed switch stays open, announces the error and restores actions', await page.$eval('[data-switch-account]', (button: HTMLButtonElement) => !button.disabled));
  await page.evaluate(() => { (window as any).fixture.pending = false; (window as any).fixture.reject = false; });
  await page.click('[data-switch-account]');
  await page.waitForSelector('#profile-account-menu', { hidden: true });
  check('successful switch closes the menu', true);
  await open(); await action('添加账户');
  check('adding an account starts an empty switch target', await page.evaluate(() => (window as any).fixture.calls.at(-1).target === null));
  check('account menu does not expose a redundant home action', !menuText?.includes('返回账户首页'));
  for (const [label, expected] of [['用户详情', 'profile'], ['设置', 'settings'], ['登出', 'logout']]) {
    await open(); await action(label!);
    check(`${label} invokes its own action`, await page.evaluate((name: string) => (window as any).fixture.calls.at(-1).action === name, expected));
  }
  check('no browser runtime errors', errors.length === 0, errors);
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser?.close(); server.stop(true); rmSync(fixture, { recursive: true, force: true });
}
