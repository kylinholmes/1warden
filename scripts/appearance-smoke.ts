#!/usr/bin/env bun
/** Real shared UI, synthetic vault, isolated headless Edge. No personal storage. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dir, '..');
const output = process.env.ONEWARDEN_APPEARANCE_OUTPUT ?? join(tmpdir(), '1warden-appearance');
mkdirSync(output, { recursive: true });
const { default: puppeteer } = await import(pathToFileURL(process.env.ONEWARDEN_PUPPETEER!).href);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(root, 'apps/desktop/dist-preview', path === '/' ? 'index.html' : path));
  return await file.exists() ? new Response(file) : new Response('', { status: 404 });
} });
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.ONEWARDEN_EDGE
  ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const page = await browser.newPage(); page.setDefaultTimeout(5000);
const checks: string[] = []; const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
const base = `http://127.0.0.1:${server.port}/`;
function check(label: string, pass: boolean, data?: unknown) {
  if (!pass) throw Error(`${label}: ${JSON.stringify(data)}`); checks.push(label); console.log(`PASS ${label}`);
}
async function settle() { await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))); }
async function appearance(width: number, height: number) {
  await page.setViewport({ width, height }); await page.goto(base + '?screen=settings', { waitUntil: 'networkidle0' });
  await page.click(width < 900 ? '#settings-link-appearance' : '#settings-tab-appearance'); await settle();
}
try {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await appearance(1080, 720);
  await page.click('.palette-trigger');
  check('all nine palettes exist', await page.$$eval('[role="option"]', (nodes: Element[]) => nodes.length === 9));
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  check('keyboard chooses the last palette', await page.evaluate(() => document.documentElement.dataset.palette === 'linear'));
  await page.click('.palette-trigger'); await page.keyboard.press('Escape');
  check('Escape closes only the palette picker and restores focus', await page.evaluate(() => !document.querySelector('[role="listbox"]') && !!document.querySelector('[role="dialog"]') && document.activeElement?.classList.contains('palette-trigger')));
  for (const mode of ['light', 'dark']) {
    await page.click(`.appearance-mode:has(.mode-${mode})`);
    for (const id of ['original', 'graphite', 'ayu', 'catppuccin', 'dracula', 'everforest', 'github', 'gruvbox', 'linear']) {
      await page.click('.palette-trigger'); await page.click(`[role="option"][id$="-${id}"]`);
      check(`${id}/${mode}: palette and mode remain independent`, await page.evaluate(({ id, mode }: any) =>
        document.documentElement.dataset.palette === id && document.documentElement.dataset.theme === mode
        && localStorage.getItem('1warden.palette') === id && localStorage.getItem('1warden.theme') === mode, { id, mode }));
    }
  }
  await page.click('.palette-trigger'); await page.click('[role="option"][id$="-graphite"]');
  await page.screenshot({ path: join(output, 'appearance-wide.png') });
  await page.reload({ waitUntil: 'networkidle0' });
  check('mode and palette survive reload', await page.evaluate(() => document.documentElement.dataset.palette === 'graphite' && document.documentElement.dataset.theme === 'dark'));
  const second = await browser.newPage(); second.setDefaultTimeout(5000);
  await second.goto(base + '?screen=quick', { waitUntil: 'domcontentloaded', timeout: 5000 });
  await page.bringToFront();
  await page.click('#settings-tab-appearance'); await page.click('.appearance-mode:has(.mode-light)');
  await second.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  check('other same-origin windows update live', true); await second.close(); await page.bringToFront();
  await page.click('.appearance-mode:has(.mode-system)');
  const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface-paper'));
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.waitForFunction((before: string) => getComputedStyle(document.documentElement).getPropertyValue('--surface-paper') !== before, {}, before);
  check('system theme changes also change palette surfaces', true);
  for (const [width, height] of [[360,640], [440,600], [550,750], [844,390], [900,600], [1024,1366]]) {
    await appearance(width!, height!);
    check(`${width}x${height}: no content overflow`, await page.$eval('#settings-panel-appearance', (node: HTMLElement) => node.scrollWidth <= node.clientWidth));
    await page.click('.palette-trigger');
    check(`${width}x${height}: dropdown and trigger are not clipped`, await page.evaluate(() => {
      const list = document.querySelector('[role="listbox"]')!.getBoundingClientRect();
      const trigger = document.querySelector('.palette-trigger')!.getBoundingClientRect();
      const content = document.querySelector('#settings-panel-appearance')!.getBoundingClientRect();
      const hit = document.elementFromPoint(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2);
      return list.top >= content.top && list.bottom <= content.bottom && !!hit?.closest('.palette-trigger');
    }));
    await page.keyboard.press('End'); await page.keyboard.press('Enter');
    check(`${width}x${height}: last palette reachable`, await page.evaluate(() => document.documentElement.dataset.palette === 'linear'));
    if (width === 440) {
      await page.click('.appearance-mode:has(.mode-dark)'); await page.click('.palette-trigger');
      await page.screenshot({ path: join(output, 'appearance-compact-menu.png') }); await page.keyboard.press('Escape');
    }
  }
  await page.setViewport({ width: 1080, height: 720 }); await page.goto(base + '?screen=vault&accounts=1', { waitUntil: 'networkidle0' });
  await page.hover('[aria-label="账户菜单"]');
  check('hover does not open the account menu', await page.$('#profile-account-menu') === null);
  await page.click('[aria-label="账户菜单"]'); await page.waitForSelector('.account-menu-current');
  const geometry = await page.$eval('.account-menu-current', (node: HTMLElement) => ({ height: node.getBoundingClientRect().height, background: getComputedStyle(node).backgroundColor }));
  check('current identity uses a compact neutral row', geometry.height < 100 && geometry.background === 'rgba(0, 0, 0, 0)', geometry);
  await page.screenshot({ path: join(output, 'account-menu.png') });
  check('no runtime errors', errors.length === 0, errors);
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(`PASS appearance: ${checks.length} checks; ${output}`);
} finally { await browser.close(); server.stop(true); }
