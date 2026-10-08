#!/usr/bin/env bun
/** Cross-build available-width checks using synthetic preview data and isolated Edge. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const root = resolve(import.meta.dir, '..');
const output = resolve(process.env.ONEWARDEN_LAYOUT_OUTPUT ?? join(tmpdir(), `onewarden-layout-${Date.now()}`));
mkdirSync(output, { recursive: true });
const { default: puppeteer } = await import(process.env.ONEWARDEN_PUPPETEER
  ? pathToFileURL(resolve(process.env.ONEWARDEN_PUPPETEER)).href : 'puppeteer-core');
let build = 'desktop';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(root, 'apps/desktop', build === 'desktop' ? 'dist-preview' : `dist-preview-${build}`, path === '/' ? 'index.html' : path));
  return await file.exists() ? new Response(file) : new Response('', { status:404 });
} });
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.ONEWARDEN_EDGE
  ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge') });
const page = await browser.newPage();
const errors: string[] = [];
const checks: string[] = [];
page.on('pageerror', (error: Error) => errors.push(error.message));
const url = `http://127.0.0.1:${server.port}`;
function check(label: string, valid: boolean) { if (!valid) throw Error(`${build}: ${label}`); checks.push(`${build}: ${label}`); }
async function settle() { await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))); }
async function visit(screen: string, width: number, height: number) {
  await page.setViewport({ width, height });
  await page.goto(`${url}/?screen=${screen}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.vault-shell, [role="dialog"]');
  await settle();
}
async function bounds() { return page.$eval('[role="dialog"]', (node: HTMLElement) => {
  const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height };
}); }
try {
  for (build of ['desktop', 'mobile', 'extension']) {
    for (const [width, height] of [[390,844], [550,750], [820,1180], [1024,1366], [800,800], [1180,820], [844,390], [600,400], [899,600], [900,600], [900,1200], [899,1200], [1000,320]]) {
      const compact = width! < 900;
      const size = `${width}x${height}`;
      await visit('settings', width!, height!);
      check(`${size} settings navigation follows width`, Boolean(await page.$('[aria-label="设置目录"]')) === compact);
      check(`${size} sidebar follows width`, Boolean(await page.$('[aria-label="设置分组"]')) === !compact);
      const box = await bounds();
      check(`${size} panel follows width`, compact ? box.width === width && box.height === height && box.x === 0 && box.y === 0 : box.width < width! && box.height < height!);
      await page.click(compact ? '#settings-link-appearance' : '#settings-tab-appearance');
      await page.waitForSelector('#settings-panel-appearance');
      if (compact) {
        await page.click('[aria-label="返回设置目录"]');
        await page.waitForSelector('[aria-label="设置目录"]');
        check(`${size} back restores focus`, await page.evaluate(() => document.activeElement?.id === 'settings-link-appearance'));
      }
      check(`${size} no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (build === 'desktop' && [550,844,899,900,1024,1180].includes(width!)) await page.screenshot({ path: join(output, `settings-${size}.png`) });
      await visit('vault', width!, height!);
      await page.click('.vault-list li > button');
      await page.waitForSelector('.vault-detail article');
      await settle();
      const detail = await page.$eval('.vault-detail', (node: HTMLElement) => ({ position: getComputedStyle(node).position, width: node.getBoundingClientRect().width }));
      check(`${size} details follow width`, compact ? detail.position === 'absolute' && detail.width === width : detail.position === 'static');
      check(`${size} list focus protection follows width`, await page.$eval('.vault-list', (node: HTMLElement) => node.inert) === compact);
      check(`${size} list does not overflow`, await page.$eval('.vault-list', (node: HTMLElement) => node.scrollWidth <= node.clientWidth));
      check(`${size} detail does not overflow`, await page.$eval('.vault-detail', (node: HTMLElement) => node.scrollWidth <= node.clientWidth));
      check(`${size} nav follows width`, await page.$eval('.nav-drawer-panel', (node: HTMLElement) => getComputedStyle(node).position) === (compact ? 'absolute' : 'static'));
      for (const screen of ['generator', 'form']) {
        await visit(screen, width!, height!);
        const panel = await bounds();
        check(`${size} ${screen} follows width`, compact ? panel.width === width && panel.height === height : panel.width < width! && panel.height < height!);
      }
    }
    // Crossing the width breakpoint must not navigate away or remount the editor.
    await visit('vault', 1180, 820);
    await page.click('[aria-label="账户菜单"]');
    await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('#profile-account-menu button')].find(button => button.textContent?.trim() === '用户详情')!.click());
    await page.waitForSelector('#profile-link-edit'); await page.click('#profile-link-edit');
    await page.waitForSelector('#profile-name');
    await page.type('#profile-name', ' - unsaved layout check');
    const draft = await page.$eval('#profile-name', (node: HTMLInputElement) => node.value);
    await page.setViewport({ width:820, height:1180 });
    await page.waitForSelector('[aria-label="返回用户详情"]');
    check('narrowing keeps unsaved profile', await page.$eval('#profile-name', (node: HTMLInputElement) => node.value) === draft);
    await page.setViewport({ width:1180, height:820 });
    await page.waitForSelector('[aria-label="返回用户详情"]');
    check('widening keeps unsaved profile', await page.$eval('#profile-name', (node: HTMLInputElement) => node.value) === draft);
    // Height changes alone must never switch navigation or discard a form draft.
    await page.setViewport({ width:1180, height:1400 });
    await settle();
    check('wide portrait retains desktop sidebar', await page.$eval('.nav-drawer-panel', (node: HTMLElement) => getComputedStyle(node).position === 'static'));
    check('height-only resize keeps unsaved profile', await page.$eval('#profile-name', (node: HTMLInputElement) => node.value) === draft);
    await visit('vault', 900, 1200);
    await page.click('.vault-list li > button');
    await page.waitForSelector('.vault-detail article');
    await page.setViewport({ width:899, height:1200 });
    await settle();
    check('narrowing keeps selected detail and guards list focus', await page.$eval('.vault-list', (node: HTMLElement) => node.inert) && Boolean(await page.$('.vault-detail article')));
    await page.setViewport({ width:900, height:1200 });
    await settle();
    check('widening releases list focus guard', !await page.$eval('.vault-list', (node: HTMLElement) => node.inert));
    await visit('vault', 820,1180);
    await page.hover('[aria-label="导航"]');
    await new Promise(resolve => setTimeout(resolve,300));
    check('hover does not open navigation', await page.$eval('.nav-drawer-panel', (node: HTMLElement) => node.inert));
    await page.click('[aria-label="导航"]');
    await settle();
    check('click opens navigation', await page.$eval('[aria-label="导航"]', (node: HTMLElement) => node.getAttribute('aria-expanded') === 'true'));
    await page.mouse.move(700,900);
    check('moving away keeps navigation open', await page.$eval('.nav-drawer-panel', (node: HTMLElement) => !node.inert));
    await page.click('[aria-label="导航"]');
    check('second click closes navigation', await page.$eval('.nav-drawer-panel', (node: HTMLElement) => node.inert));
    await page.click('[aria-label="导航"]');
    await settle();
    await page.mouse.click(700,900);
    check('outside click closes navigation', await page.$eval('.nav-drawer-panel', (node: HTMLElement) => node.inert));
    await page.focus('[aria-label="导航"]');
    await page.keyboard.press('Enter');
    await settle();
    await page.keyboard.press('Escape');
    check('keyboard close restores trigger', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '导航'));
    console.log(`PASS ${build}: width boundaries, height independence, editor state, pointer and keyboard navigation`);
  }
  check('no uncaught UI errors', errors.length === 0);
  console.log(`PASS ${checks.length} checks; screenshots: ${output}`);
} catch (error) {
  await page.screenshot({ path:join(output,'failure.png') });
  throw error;
} finally {
  writeFileSync(join(output,'report.json'),JSON.stringify({checks,errors},null,2));
  await browser.close();server.stop(true);
}
