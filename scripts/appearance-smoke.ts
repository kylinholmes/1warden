#!/usr/bin/env bun
import { launchSmokeBrowser, closeSmokeBrowser } from './smoke-processes.mjs';
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
const browser = await launchSmokeBrowser(puppeteer, { headless: true, executablePath: process.env.ONEWARDEN_EDGE
  ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const page = await browser.newPage(); page.setDefaultTimeout(5000);
const checks: string[] = []; const errors: string[] = []; const dropdownGeometry: unknown[] = [];
const noteGeometry: unknown[] = [];
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
  check('all thirteen palettes exist', await page.$$eval('[role="option"]', (nodes: Element[]) => nodes.length === 13));
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  check('keyboard chooses the last palette', await page.evaluate(() => document.documentElement.dataset.palette === 'linear'));
  await page.click('.palette-trigger'); await page.keyboard.press('Escape');
  check('Escape closes only the palette picker and restores focus', await page.evaluate(() => !document.querySelector('[role="listbox"]') && !!document.querySelector('[role="dialog"]') && document.activeElement?.classList.contains('palette-trigger')));
  for (const mode of ['light', 'dark']) {
    await page.click(`.appearance-mode:has(.mode-${mode})`);
    for (const id of ['original', 'jade', 'clear-blue', 'whale', 'brass', 'graphite', 'ayu', 'catppuccin', 'dracula', 'everforest', 'github', 'gruvbox', 'linear']) {
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
  second.on('pageerror', (e: Error) => errors.push(`second window: ${e.message}`));
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
    const samples = await page.evaluate(async () => {
      function measure() {
        const node = document.querySelector<HTMLElement>('[role="listbox"]')!;
        const list = node.getBoundingClientRect();
        const trigger = document.querySelector('.palette-trigger')!.getBoundingClientRect();
        const content = document.querySelector('#settings-panel-appearance')!.getBoundingClientRect();
        const hit = document.elementFromPoint(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2);
        return { list: list.toJSON(), trigger: trigger.toJSON(), content: content.toJSON(),
          maxHeight: node.style.maxHeight, triggerHit: !!hit?.closest('.palette-trigger') };
      }
      const immediate = measure();
      // Edge 152 can expose the initial 224px box before committing the layout
      // effect's constrained height. Hosted failure screenshots showed the
      // correct 183px box. Measure after a paint, not a protocol-timing race;
      // keep both samples and the exact original clipping assertion.
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      return { immediate, rendered: measure() };
    });
    dropdownGeometry.push({ width, height, ...samples });
    const bounds = samples.rendered;
    check(`${width}x${height}: dropdown and trigger are not clipped`, bounds.list.top >= bounds.content.top && bounds.list.bottom <= bounds.content.bottom && bounds.triggerHit, bounds);
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
  for (const mode of ['light', 'dark']) for (const palette of ['original', 'jade', 'clear-blue', 'whale', 'brass', 'graphite', 'ayu', 'catppuccin', 'dracula', 'everforest', 'github', 'gruvbox', 'linear']) {
    await page.setViewport({ width: 1080, height: 720 });
    await page.goto(base + `?screen=vault&fixture=note-icons&palette=${palette}&theme=${mode}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tile-note');
    await settle();
    const metrics = await page.$$eval('.vault-list .tile-note', (nodes: HTMLElement[]) => {
      const context = document.createElement('canvas').getContext('2d')!;
      function luminance(color: string) {
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        const [r, g, b] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(n => {
          const value = n / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
        });
        return r! * .2126 + g! * .7152 + b! * .0722;
      }
      function contrast(a: string, b: string) { const values = [luminance(a), luminance(b)].sort((a, b) => a - b); return (values[1]! + .05) / (values[0]! + .05); }
      return nodes.map(node => {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        const text = node.querySelector('.tile-note-text')!.getBoundingClientRect(), mark = node.querySelector('.tile-note-mark')!.getBoundingClientRect();
        return { width: rect.width, height: rect.height, textContrast: contrast(style.color, style.backgroundColor),
          markerContrast: contrast(style.color, getComputedStyle(node.querySelector('.tile-note-mark')!).backgroundColor),
          overlap: Math.min(text.right, mark.right) - Math.max(text.left, mark.left) > .1 && Math.min(text.bottom, mark.bottom) - Math.max(text.top, mark.top) > .1 };
      });
    });
    noteGeometry.push({ mode, palette, metrics });
    check(`${palette}/${mode}: note abbreviations and type markers stay readable without overlap`, metrics.length === 9
      && metrics.every((entry: any) => Math.abs(entry.width - 34) < .05 && Math.abs(entry.height - 34) < .05 && entry.textContrast >= 4.5 && entry.markerContrast >= 3 && !entry.overlap), metrics);
    if (palette === 'original' || palette === 'whale') await page.screenshot({ path: join(output, `note-icons-${palette}-${mode}.png`) });
    await page.setViewport({ width: 360, height: 720 });
    await page.click('.vault-list li > button'); await page.waitForSelector('.item-detail .tile-note'); await settle();
    const header = await page.$eval('.item-detail .tile-note', (node: HTMLElement) => {
      const rect = node.getBoundingClientRect(), text = node.querySelector('.tile-note-text')!.getBoundingClientRect(), mark = node.querySelector('.tile-note-mark')!.getBoundingClientRect();
      const detail = node.closest('.vault-detail')!;
      return { width: rect.width, height: rect.height, fits: detail.scrollWidth <= detail.clientWidth + 1,
        overlap: Math.min(text.right, mark.right) - Math.max(text.left, mark.left) > .1 && Math.min(text.bottom, mark.bottom) - Math.max(text.top, mark.top) > .1 };
    });
    check(`${palette}/${mode}: 360px note detail retains its 36px icon and readable marker`, Math.abs(header.width - 36) < .05 && Math.abs(header.height - 36) < .05 && header.fits && !header.overlap, header);
    if (palette === 'original' || palette === 'whale') await page.screenshot({ path: join(output, `note-detail-${palette}-${mode}.png`) });
  }
  for (const width of [360, 720, 1080]) for (const mode of ['light', 'dark']) {
    await page.setViewport({ width, height: 720 });
    await page.goto(base + `?screen=vault&fixture=passkey-visibility&theme=${mode}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.vault-list li > button');
    for (const saved of [false, true]) {
      if (await page.$('.item-detail') && width < 900) { await page.click('.detail-back'); await settle(); }
      const label = saved ? '已保存通行密钥的登录' : '未保存通行密钥的登录';
      const row = await page.evaluateHandle((label: string) => [...document.querySelectorAll('.vault-list li > button')].find(node => node.textContent?.includes(label)), label);
      await row.asElement().click(); await row.dispose(); await page.waitForFunction((label: string) => document.querySelector('.item-detail h2')?.textContent?.trim() === label, {}, label);
      await settle();
      check(`${width}/${mode}: ${saved ? 'saved passkey shows metadata' : 'missing passkey has no empty row'}`, await page.$eval('.item-detail', (node: Element, saved: boolean) => {
        const row = node.querySelector('[data-login-passkeys]');
        return saved ? !!row?.textContent?.includes('已保存 1 个') && row.textContent.includes('Synthetic website') && row.textContent.includes('fixture@example.invalid')
          : !row;
      }, saved));
      check(`${width}/${mode}: passkey detail does not overflow`, await page.$eval('.vault-detail', (node: HTMLElement) => node.scrollWidth <= node.clientWidth + 1));
      if (width === 360) await page.screenshot({ path: join(output, `passkey-${saved ? 'saved' : 'absent'}-${mode}.png`) });
    }
  }
  check('no runtime errors', errors.length === 0, errors);
  console.log(`PASS appearance: ${checks.length} checks; ${output}`);
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') });
  throw error;
} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, errors, dropdownGeometry, noteGeometry, browser: await browser.version() }, null, 2));
  await closeSmokeBrowser(browser); server.stop(true);
}
