#!/usr/bin/env bun
/** Real shared-header/navigation checks against synthetic preview data in an isolated Edge. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dir, '..');
const preview = resolve(process.env.ONEWARDEN_HEADER_PREVIEW ?? join(root, 'apps/desktop/dist-preview'));
const output = resolve(process.env.ONEWARDEN_HEADER_OUTPUT ?? join(tmpdir(), `onewarden-navigation-header-${Date.now()}`));
mkdirSync(output, { recursive: true });
const { default: puppeteer } = await import(process.env.ONEWARDEN_PUPPETEER
  ? pathToFileURL(resolve(process.env.ONEWARDEN_PUPPETEER)).href : 'puppeteer-core');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const pathname = new URL(request.url).pathname;
  const file = Bun.file(join(preview, pathname === '/' ? 'index.html' : pathname));
  return await file.exists() ? new Response(file) : new Response('', { status: 404 });
} });
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.ONEWARDEN_EDGE
  ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge') });
const page = await browser.newPage();
page.setDefaultTimeout(8000);
const checks: string[] = [], errors: string[] = [];
page.on('pageerror', (error: Error) => errors.push(error.message));
let size = '';
function check(name: string, condition: boolean, detail?: unknown) {
  if (!condition) throw new Error(`${size}: ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  checks.push(`${size}: ${name}`);
}
async function settle() {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
    await new Promise<void>(done => requestAnimationFrame(() => done()));
  });
}
async function visit(width: number, height: number) {
  size = `${width}x${height}`;
  await page.setViewport({ width, height });
  await page.goto(`http://127.0.0.1:${server.port}/?screen=vault`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.vault-list li > button');
  await settle();
}
async function navigation() {
  if (await page.$eval('.nav-drawer-panel', (element: HTMLElement) => element.inert)) {
    await page.click('[aria-label="导航"]');
    await settle();
  }
}
async function accountAction(label: string) {
  await navigation();
  await page.click('[aria-label="账户菜单"]');
  const handle = await page.evaluateHandle((text: string) => [...document.querySelectorAll<HTMLButtonElement>('#profile-account-menu button')]
    .find(button => button.textContent?.trim() === text), label);
  const button = handle.asElement();
  if (!button) throw new Error(`Missing account action: ${label}`);
  await button.click();
  await handle.dispose();
  await settle();
}
async function crumb(label: string) {
  const handle = await page.evaluateHandle((text: string) => [...document.querySelectorAll<HTMLButtonElement>('.page-header nav button')]
    .find(button => button.textContent?.trim() === text), label);
  const button = handle.asElement();
  if (!button) throw new Error(`Missing actionable ancestor: ${label}`);
  await button.click(); await handle.dispose(); await settle();
}
async function header(title: string, current: string, width: number) {
  const shape = await page.$eval('.page-header', (element: HTMLElement) => {
    const back = element.querySelector<HTMLButtonElement>('[data-page-back]')!;
    const current = element.querySelector('[aria-current="page"]');
    const rect = back.getBoundingClientRect(), box = element.getBoundingClientRect();
    return {
      backCount: element.querySelectorAll('[data-page-back]').length,
      backLabel: back.getAttribute('aria-label'), backWidth: rect.width, backHeight: rect.height,
      left: box.left, right: box.right, current: current?.textContent, currentTag: current?.tagName,
      ordered: Boolean(element.querySelector('nav[aria-label] > ol')),
      currentCount: element.querySelectorAll('[aria-current="page"]').length,
      hiddenDecorations: [...element.querySelectorAll('svg')].every(svg => svg.getAttribute('aria-hidden') === 'true'),
      duplicateClose: [...element.querySelectorAll('button[aria-label]')].some(button => button.getAttribute('aria-label')?.startsWith('关闭')),
      overflow: element.scrollWidth > element.clientWidth,
    };
  });
  check(`${title} uses one shared labelled back button`, shape.backCount === 1 && Boolean(shape.backLabel), shape);
  check(`${title} has no redundant close action beside its back button`, !shape.duplicateClose, shape);
  check(`${title} back target is at least 44 px`, shape.backWidth >= 44 && shape.backHeight >= 44, shape);
  check(`${title} exposes an ordered breadcrumb with one current page`, shape.ordered && shape.currentCount === 1
    && shape.current === current && shape.currentTag === 'SPAN', shape);
  check(`${title} hides decorative icons from accessibility tree`, shape.hiddenDecorations);
  check(`${title} header fits available width`, shape.left >= 0 && shape.right <= width && !shape.overflow, shape);
  check(`${title} does not create document horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}
try {
  for (const [width, height] of [[320, 640], [440, 740], [899, 700], [900, 700], [1280, 850]] as const) {
    const compact = width < 900;
    await visit(width, height);
    await accountAction('设置');
    await page.waitForSelector('[aria-labelledby="settings-title"]');
    await header('settings root', compact ? '设置' : '外观', width);
    if (compact) {
      await page.click('#settings-link-appearance'); await settle();
      await header('settings appearance', '外观', width);
      await crumb('设置');
      check('settings ancestor returns directory and restores source focus', await page.evaluate(() =>
        document.activeElement?.id === 'settings-link-appearance' && Boolean(document.querySelector('[aria-label="设置目录"]'))));
      await page.click('#settings-link-security');
      await page.focus('[aria-label="返回设置目录"]'); await page.keyboard.press('Enter'); await settle();
      check('keyboard back returns settings focus to visited section', await page.evaluate(() => document.activeElement?.id === 'settings-link-security'));
      await page.click('#settings-link-about'); await page.keyboard.press('Escape'); await settle();
      check('Escape follows the same settings parent level', await page.evaluate(() => document.activeElement?.id === 'settings-link-about'));
    } else {
      await page.focus('#settings-tab-appearance'); await page.keyboard.press('ArrowDown');
      check('wide settings retains vertical tab keyboard navigation', await page.evaluate(() => document.activeElement?.id === 'settings-tab-autofill'));
    }
    await page.screenshot({ path: join(output, `settings-${size}.png`) });
    await page.click('[aria-labelledby="settings-title"] [data-page-back]'); await page.waitForSelector('[role="dialog"]', { hidden: true });
    check('closing settings restores invoking control focus', await page.evaluate((isCompact: boolean) =>
      document.activeElement?.getAttribute('aria-label') === (isCompact ? '导航' : '账户菜单'), compact));

    await navigation(); await page.click('[data-key="generator"]'); await settle();
    await header('generator', '生成器', width);
    await crumb('保险库'); await page.waitForSelector('[role="dialog"]', { hidden: true });
    check('generator breadcrumb closes to previous context and restores focus', await page.evaluate((isCompact: boolean) =>
      isCompact ? document.activeElement?.getAttribute('aria-label') === '导航' : document.activeElement?.getAttribute('data-key') === 'generator', compact));
    await navigation(); await page.click('[data-key="generator"]'); await settle();
    await page.focus('.page-header [data-page-back]'); await page.keyboard.press('Enter');
    await page.waitForSelector('[role="dialog"]', { hidden: true });
    check('generator shared back supports keyboard activation', !await page.$('[role="dialog"]'));

    await accountAction('用户详情'); await page.waitForSelector('#profile-link-edit');
    await header('profile overview', '用户详情', width);
    await page.click('#profile-link-edit'); await page.waitForSelector('#profile-name'); await settle();
    await header('profile edit', '个人资料', width);
    await page.screenshot({ path: join(output, `profile-${size}.png`) });
    await crumb('用户详情');
    check('profile ancestor returns directory with source focus', await page.evaluate(() => document.activeElement?.id === 'profile-link-edit'));
    await page.click('#profile-link-devices'); await settle();
    await header('profile devices', '登录设备', width);
    await page.click('[aria-label="返回用户详情"]');
    check('profile shared back restores devices source focus', await page.evaluate(() => document.activeElement?.id === 'profile-link-devices'));
    await crumb('保险库'); await page.waitForSelector('.vault-list li > button');

    for (const [key, title] of [['security', '安全报告'], ['import', '导入']] as const) {
      await navigation(); await page.click(`[data-key="${key}"]`); await settle();
      await header(title, title, width);
      // Exercise the layout with translated/long labels without changing the rendered component structure.
      await page.$eval('.page-header nav', (element: HTMLElement) => {
        const ancestor = element.querySelector('button span');
        const current = element.querySelector('[aria-current="page"]');
        if (ancestor) ancestor.textContent = 'VeryLongTranslatedVaultDestinationWithoutSpaces';
        if (current) current.textContent = '极长的当前页面名称用于验证窄屏文本截断';
      });
      check(`${title} long breadcrumbs remain contained`, await page.$eval('.page-header', (element: HTMLElement) =>
        element.scrollWidth <= element.clientWidth && document.documentElement.scrollWidth <= innerWidth));
      await page.click('[aria-label="返回保险库"]'); await page.waitForSelector('.vault-list li > button');
    }
    await page.click('.vault-list li > button'); await page.waitForSelector('.vault-detail article'); await settle();
    check('item detail uses shared back without a competing navigation trigger', await page.$eval('.vault-detail article', (element: HTMLElement) =>
      element.querySelectorAll('[data-page-back]').length === 1 && !element.querySelector('[aria-label="导航"]')));
    if (compact) { await page.click('[aria-label="返回列表"]'); await settle(); }
    console.log(`PASS ${size}: shared back, actionable ancestors, focus, keyboard and overflow`);
  }
  check('no uncaught UI errors', errors.length === 0, errors);
  console.log(`PASS ${checks.length} checks; screenshots and report: ${output}`);
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') });
  throw error;
} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
  await browser.close(); server.stop(true);
}
