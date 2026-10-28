#!/usr/bin/env bun
/** The real shared Select in disposable Edge, using synthetic preview records.
 * No real account, clipboard, profile, server, or persistence writes are used. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dir, '..');
const output = resolve(process.env.ONEWARDEN_SELECT_OUTPUT ?? join(tmpdir(), `onewarden-select-${Date.now()}`));
mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(root, 'apps/desktop/dist-preview', path === '/' ? 'index.html' : path));
  return await file.exists() ? new Response(file) : new Response('', { status: 404 });
} });
// Puppeteer creates and removes its own temporary browser profile by default.
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.ONEWARDEN_EDGE
  ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const page = await browser.newPage(); page.setDefaultTimeout(5000);
const base = `http://127.0.0.1:${server.port}`;
const checks: string[] = [], errors: string[] = [], geometry: unknown[] = [];
page.on('pageerror', error => errors.push(String(error)));
await page.setRequestInterception(true);
page.on('request', request => {
  if (request.url().startsWith(base + '/') || request.url().startsWith('data:')) void request.continue();
  else void request.abort();
});
const picker = (label: string) => `[role="combobox"][aria-label="${label}"]`;
function check(label: string, pass: boolean, data?: unknown) {
  if (!pass) throw new Error(`${label}: ${JSON.stringify(data)}`);
  checks.push(label); console.log(`PASS ${label}`);
}
async function settle() {
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))));
}
async function visit(screen: string) { await page.goto(`${base}/?screen=${screen}`, { waitUntil: 'networkidle0' }); await settle(); }
async function clickText(text: string) {
  const handle = await page.evaluateHandle(text => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text), text);
  const button = handle.asElement(); if (!button) throw new Error(`Missing button: ${text}`);
  await button.click(); await handle.dispose();
}
async function select(label: string, value: string) {
  await page.click(picker(label));
  const choice = `[data-select-popup] [role="option"][data-value="${value}"]`;
  await page.$eval(choice, node => node.scrollIntoView({ block: 'center' }));
  await page.click(choice);
  check(`${label} commits ${value}`, await page.$eval(picker(label), (node, value) => (node as HTMLButtonElement).value === value, value));
}
async function inspectPopup(label: string, scenario: string, above = false) {
  const data = await page.evaluate(({ label }) => {
    const popup = document.querySelector<HTMLElement>('[data-select-popup]')!;
    const trigger = document.querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`)!;
    const rect = popup.getBoundingClientRect(), anchor = trigger.getBoundingClientRect();
    const expected = document.createElement('span'); expected.style.backgroundColor = 'var(--surface-overlay)'; document.body.append(expected);
    const background = getComputedStyle(expected).backgroundColor; expected.remove();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      anchorTop: anchor.top, anchorBottom: anchor.bottom, width: innerWidth, height: innerHeight,
      topLayer: popup.matches(':popover-open'), themed: getComputedStyle(popup).backgroundColor === background,
      readable: getComputedStyle(popup).color !== getComputedStyle(popup).backgroundColor,
      overflow: popup.scrollWidth > popup.clientWidth, modalOwner: popup.closest('[role="dialog"]') === trigger.closest('[role="dialog"]'),
      focused: document.activeElement === trigger, visible: document.elementFromPoint(rect.left + 12, rect.top + 12)?.closest('[data-select-popup]') === popup };
  }, { label });
  geometry.push({ scenario, ...data });
  check(`${scenario}: themed popup is top-layer, readable, inside viewport, and not clipped`, data.topLayer && data.themed && data.readable
    && data.left >= 0 && data.right <= data.width && data.top >= 0 && data.bottom <= data.height
    && !data.overflow && data.visible && data.modalOwner && data.focused, data);
  if (above) check(`${scenario}: low trigger flips popup upward`, data.bottom <= data.anchorTop + 1, data);
}

try {
  for (const mode of ['dark', 'light']) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }]);
    for (const width of [360, 1080]) {
      // The compact type selector shortens the form. Use a short viewport so
      // the card-brand trigger genuinely has insufficient room below it.
      await page.setViewport({ width, height: width < 900 ? 520 : 720 }); await visit('form');
      if (await page.$(picker('条目类型'))) await select('条目类型', 'card');
      else await clickText('信用卡');
      await page.$eval(picker('卡片品牌'), node => node.scrollIntoView({ block: 'end' }));
      await page.click(picker('卡片品牌'));
      await inspectPopup('卡片品牌', `card-${mode}-${width}`, true);
      await page.screenshot({ path: join(output, `card-${mode}-${width}.png`) });
      await page.keyboard.press('End'); await page.keyboard.press('Enter');
      check(`${mode}/${width}: keyboard commits without closing parent editor`, await page.$eval(picker('卡片品牌'), node => (node as HTMLButtonElement).value === 'Other') && !!await page.$('[role="dialog"]'));
      await page.click(picker('卡片品牌')); await page.keyboard.press('Escape');
      check(`${mode}/${width}: first Escape retains editor and trigger focus`, await page.evaluate(() => !document.querySelector('[data-select-popup]')
        && !!document.querySelector('[role="dialog"]') && document.activeElement?.getAttribute('role') === 'combobox'));
      await page.click(picker('卡片品牌')); await page.keyboard.press('Tab');
      check(`${mode}/${width}: real Tab dismisses and moves focus`, await page.evaluate(() => !document.querySelector('[data-select-popup]')
        && document.activeElement?.getAttribute('role') !== 'combobox'));
      await page.click(picker('卡片品牌')); await page.click('#editor-title');
      check(`${mode}/${width}: outside pointer dismisses only popup`, !await page.$('[data-select-popup]') && !!await page.$('[role="dialog"]'));
      await page.click(picker('卡片品牌')); await page.keyboard.type('Union'); await page.keyboard.press('Enter');
      check(`${mode}/${width}: actual keyboard typeahead selects UnionPay`, await page.$eval(picker('卡片品牌'), node => (node as HTMLButtonElement).value === 'UnionPay'));
      await page.click(picker('卡片品牌'));
      await page.$eval('[data-select-popup]', node => { node.scrollTop = node.scrollHeight; });
      check(`${mode}/${width}: option scrolling keeps picker open`, !!await page.$('[data-select-popup]'));
      await page.$eval('[role="dialog"] .overflow-y-auto', node => { node.scrollTop = 0; });
      await page.waitForSelector('[data-select-popup]', { hidden: true });
      check(`${mode}/${width}: editor scrolling dismisses detached popup`, true);
    }
  }
  await page.setViewport({ width: 360, height: 720 }); await visit('form');
  await page.click('[data-editor-url] summary');
  await select('网址 1 匹配方式', '4');
  await clickText('添加自定义字段'); await page.click('[data-add-custom="0"]');
  await select('字段 1 类型', '3'); await select('字段 1 关联目标', '101');
  await page.click(picker('字段 1 类型')); await inspectPopup('字段 1 类型', 'custom-field-360');
  await page.keyboard.press('Escape');
  await page.$eval(picker('文件夹'), node => node.closest('details')?.setAttribute('open', ''));
  await select('文件夹', 'f2');
  check('all editor pickers use shared controls, not native select menus', await page.$$eval('select', nodes => nodes.length === 0));

  await visit('vault'); await page.click('.vault-list li > button');
  await page.click('[aria-label="更改文件夹归类"]');
  await page.click(picker('更改文件夹')); await inspectPopup('更改文件夹', 'detail-folder-360');
  const currentFolder = await page.$eval(picker('更改文件夹'), node => (node as HTMLButtonElement).value);
  await page.keyboard.press('End'); await page.keyboard.press('Escape');
  check('folder preview cancellation leaves membership untouched', await page.$eval(picker('更改文件夹'), (node, value) => (node as HTMLButtonElement).value === value, currentFolder));
  await page.keyboard.press('Escape');
  check('second Escape closes folder editing, not item detail', !await page.$('[data-item-folder]') && !!await page.$('.vault-detail article'));

  await visit('import');
  await page.$eval('input[type="file"]', node => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['name,url,username,password\nFixture,https://fixture.example,synthetic,synthetic-password\n'], 'synthetic.csv', { type: 'text/csv' }));
    (node as HTMLInputElement).files = transfer.files; node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForSelector('#import-format'); await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')]
    .some(node => node.textContent?.includes('可导入 1 条记录')));
  await page.click('#import-format');
  const importGeometry = await page.$eval('[data-select-popup]', node => ({ width: node.getBoundingClientRect().width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
    wraps: [...node.querySelectorAll<HTMLElement>('[role="option"] > span:first-child')].some(label => label.getBoundingClientRect().height > 30) }));
  check('long import-format labels wrap without horizontal scrolling at 360px', importGeometry.wraps && importGeometry.scrollWidth <= importGeometry.clientWidth, importGeometry);
  await page.screenshot({ path: join(output, 'import-360.png') });
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(node => node.textContent?.includes('可导入 1 条记录')));
  check('import format choice reparses fixture and leaves the import confirmation pending', await page.$eval('#import-format', node => (node as HTMLButtonElement).value === 'csv')
    && await page.evaluate(() => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('导入这 1 条'))));
  check('no browser runtime errors', errors.length === 0, errors);
  writeFileSync(join(output, 'report.json'), JSON.stringify({ browser: await browser.version(), checks, geometry, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') });
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, geometry, errors, error: String(error) }, null, 2));
  throw error;
} finally { await browser.close(); server.stop(true); console.log(`Select evidence: ${output}`); }
