#!/usr/bin/env bun
/** Shared-screen motion checks against an isolated preview build and disposable headless browser. */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const preview = resolve(process.env.ONEWARDEN_PANEL_PREVIEW ?? '/tmp/onewarden-panel-preview');
const output = resolve(process.env.ONEWARDEN_PANEL_OUTPUT ?? '/tmp/onewarden-panel-motion');
mkdirSync(output, { recursive: true });
const { default: puppeteer } = await import(pathToFileURL(resolve(process.env.ONEWARDEN_PUPPETEER
  ?? '/tmp/onewarden-browser-tools/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).href);
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const file = Bun.file(join(preview, pathname === '/' ? 'index.html' : pathname));
    return await file.exists() ? new Response(file) : new Response('', { status: 404 });
  },
});
let browser: any;
try { browser = await puppeteer.launch({
  executablePath: process.env.ONEWARDEN_EDGE
    ?? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  headless: true,
}); } catch (error) { server.stop(true); throw error; }
const page = await browser.newPage();
const checks: string[] = [];
const errors: string[] = [];
page.on('pageerror', (error: Error) => errors.push(error.message));
function check(label: string, passed: boolean, diagnostic?: unknown) {
  if (!passed) throw new Error(`${label}: ${JSON.stringify(diagnostic)}`);
  checks.push(label);
  console.log(`✓ ${label}`);
}
async function settle() {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map((animation) => animation.finished.catch(() => {}))));
}
async function clickButton(label: string) {
  const handle = await page.evaluateHandle((name: string) => Array.from(document.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name && button.offsetParent !== null), label);
  const button = handle.asElement();
  if (!button) throw new Error(`No visible button: ${label}`);
  await button.click();
  await handle.dispose();
}
async function visit(screen: string, width = 440, height = 600) {
  await page.setViewport({ width, height });
  await page.goto(`http://127.0.0.1:${server.port}/?screen=${screen}`, { waitUntil: 'networkidle0' });
  await settle();
}
async function geometry(selector: string) {
  return page.$eval(selector, (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      animation: style.animationName, radius: style.borderRadius,
      overflow: document.documentElement.scrollWidth > innerWidth };
  });
}
async function closePanel(selector: string, label: string, narrow: boolean) {
  await page.click(selector);
  await page.waitForSelector('.panel-out');
  const exit = await page.$eval('.panel-out', (element: HTMLElement) => ({
    name: getComputedStyle(element).animationName,
    inactive: element.closest('[inert]') !== null,
    pointerEvents: getComputedStyle(element.parentElement!).pointerEvents,
  }));
  check(`${label}: outgoing card remains mounted and inactive`, exit.inactive && exit.pointerEvents === 'none', exit);
  check(`${label}: close animation direction`, exit.name === (narrow ? 'onewarden-card-out' : 'onewarden-panel-out'), exit);
  await page.waitForSelector('[role="dialog"]', { hidden: true });
  check(`${label}: overlay removed after close`, await page.$('.floating-layer') === null);
}

try {
  await visit('generator');
  await page.evaluate(() => { document.documentElement.dataset.os = 'mac'; });
  check('native narrow header clears the 28px titlebar', await page.$eval('.panel-head', (element: HTMLElement) => element.getBoundingClientRect().top >= 28));
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34 } });
  await page.evaluate(() => { document.documentElement.dataset.os = 'ios'; });
  check('mobile narrow header clears the emulated notch', await page.$eval('.panel-head', (element: HTMLElement) => element.getBoundingClientRect().top >= 47));
  check('mobile narrow footer clears the home indicator', await page.$eval('.panel-foot', (element: HTMLElement) => element.getBoundingClientRect().bottom <= innerHeight - 34));
  const mobileBounds = await geometry('[role="dialog"]');
  check('safe-area spacing keeps the whole card covering the window', mobileBounds.x === 0 && mobileBounds.y === 0 && mobileBounds.width === 440 && mobileBounds.height === 600, mobileBounds);
  await page.screenshot({ path: join(output, 'generator-mobile-safe-area.png') });
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0 } });
  await page.evaluate(() => { delete document.documentElement.dataset.os; });
  check('extension header has no native titlebar gap', await page.$eval('.panel-head', (element: HTMLElement) => element.getBoundingClientRect().top === 0));
  check('extension footer keeps the complete viewport height', await page.$eval('.panel-foot', (element: HTMLElement) => element.getBoundingClientRect().bottom === innerHeight));
  await cdp.detach();
  for (const width of [440, 1280]) {
    const height = width === 440 ? 600 : 800;
    for (const [screen, close] of [['generator', '[aria-labelledby="generator-title"] [data-page-back]'], ['settings', '[aria-labelledby="settings-title"] [data-page-back]'], ['form', '.panel-foot .btn-quiet']]) {
      await visit(screen!, width, height);
      const bounds = await geometry('[role="dialog"]');
      const narrow = width === 440;
      check(`${screen} ${width}: card bounds`, narrow
        ? bounds.x === 0 && bounds.y === 0 && bounds.width === width && bounds.height === height && bounds.radius === '0px'
        : bounds.x > 0 && bounds.y > 0 && bounds.width < width && bounds.height < height, bounds);
      check(`${screen} ${width}: entrance animation`, bounds.animation === (narrow ? 'onewarden-card-in' : 'onewarden-panel-in'), bounds);
      check(`${screen} ${width}: no horizontal document overflow`, !bounds.overflow, bounds);
      await page.screenshot({ path: join(output, `${screen}-${width}.png`) });
      await closePanel(close!, `${screen} ${width}`, narrow);
    }
  }
  await visit('generator');
  await page.click('[aria-labelledby="generator-title"] [data-page-back]');
  await page.waitForSelector('.panel-out');
  await page.click('button.fixed');
  await page.waitForSelector('.panel-in');
  await settle();
  await new Promise((done) => setTimeout(done, 450));
  check('reopening during exit cancels unmount', await page.$('[role="dialog"]') !== null);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"]', { hidden: true });
  check('disconnected opener does not trap focus in the removed panel', await page.evaluate(() => document.activeElement?.closest('.floating-layer') === null));

  for (const width of [440, 1280]) {
    await visit('form', width, 800);
    check(`editor ${width}: no duplicate header close`, await page.$('.panel-head [aria-label="关闭"]') === null);
    await page.type('input[placeholder="例如 GitHub"]', 'Synthetic unsaved draft');
    await clickButton('取消');
    await page.waitForFunction(() => document.querySelector('.panel-foot')?.textContent?.includes('放弃改动'));
    check(`editor ${width}: cancel asks before discarding`, await page.$('[role="dialog"]') !== null);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.panel-foot')?.textContent?.includes('放弃改动'));
    check(`editor ${width}: Escape cancels confirmation and preserves draft`, await page.$eval('input[placeholder="例如 GitHub"]', (input: HTMLInputElement) => input.value === 'Synthetic unsaved draft'));
    await clickButton('取消'); await clickButton('继续编辑');
    check(`editor ${width}: continue editing preserves draft`, await page.$eval('input[placeholder="例如 GitHub"]', (input: HTMLInputElement) => input.value === 'Synthetic unsaved draft'));
    await clickButton('取消'); await clickButton('放弃改动');
    await page.waitForSelector('[role="dialog"]', { hidden: true });
    check(`editor ${width}: only explicit discard closes dirty form`, true);
  }

  await visit('vault');
  await page.focus('[aria-label="搜索条目"]');
  await page.keyboard.down('Meta');
  await page.keyboard.press(',');
  await page.keyboard.up('Meta');
  await page.waitForSelector('[aria-labelledby="settings-title"]');
  await settle();
  check('opening settings transfers focus into the panel', await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null));
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"]', { hidden: true });
  check('Escape restores focus to the connected opener', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '搜索条目'));
  await page.click('.vault-list li button');
  await page.waitForSelector('.vault-detail article');
  await settle();
  const detail = await geometry('.vault-detail');
  check('narrow detail covers window', detail.x === 0 && detail.y === 0 && detail.width === 440 && detail.height === 600, detail);
  check('narrow detail uses right-slide entrance', detail.animation === 'onewarden-card-in', detail);
  check('list cannot receive focus behind detail', await page.$eval('.vault-list', (element: HTMLElement) => element.inert));
  check('underlying list controls cannot paint above the detail', await page.$eval('.vault-list', (element: HTMLElement) => getComputedStyle(element).isolation === 'isolate'));
  check('detail uses the shared back control', await page.$('[aria-label="返回列表"][data-page-back]') !== null);
  await page.screenshot({ path: join(output, 'detail-440.png') });
  await page.click('[aria-label="返回列表"]');
  await page.waitForSelector('.vault-detail[data-state="closing"] article');
  check('detail content retained while sliding out', (await geometry('.vault-detail')).animation === 'onewarden-card-out');
  await page.waitForSelector('.vault-detail article', { hidden: true });
  check('back restores selected row focus', await page.evaluate(() => document.activeElement?.closest('.vault-list') !== null));
  check('list stacking is restored after detail exits', await page.$eval('.vault-list', (element: HTMLElement) => getComputedStyle(element).isolation === 'auto'));

  await page.click('.vault-list li button');
  await page.waitForSelector('.vault-detail article');
  await settle();
  await clickButton('删除');
  await page.waitForSelector('[aria-labelledby="delete-title"]');
  await settle();
  check('delete confirmation also covers narrow window', (await geometry('[aria-labelledby="delete-title"]')).height === 600);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.panel-out');
  check('delete confirmation retains title during exit', await page.$eval('#delete-title', (element: HTMLElement) => Boolean(element.textContent?.includes('删除'))));
  await page.waitForSelector('[role="dialog"]', { hidden: true });
  check('closing confirmation does not close underlying detail', await page.$('.vault-detail article') !== null);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.vault-detail article', { hidden: true });

  await visit('vault', 1280, 800);
  await page.click('.vault-list li button');
  await page.waitForSelector('.vault-detail article');
  await settle();
  check('wide detail remains an unanimated adjacent column', (await geometry('.vault-detail')).animation === 'none');
  check('wide list remains interactive', await page.$eval('.vault-list', (element: HTMLElement) => !element.inert));
  await page.screenshot({ path: join(output, 'detail-1280.png') });
  // The wide column deliberately has no Escape-to-back handler. Return from
  // the actual full-width user page instead; an Escape here tested no transition.
  await page.click('[aria-label="账户菜单"]');
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('#profile-account-menu button')]
    .find(button => button.textContent?.trim() === '用户详情')!.click());
  await page.waitForSelector('[aria-label="返回保险库"]');
  await page.evaluate(() => { document.documentElement.dataset.nativeTitlebar = 'windows'; });
  const frames = await page.evaluate(async () => {
    const samples: { scroll: number; height: number }[] = [];
    document.querySelector<HTMLButtonElement>('[aria-label="返回保险库"]')!.click();
    const start = performance.now();
    while (performance.now() - start < 450) {
      const pane = document.querySelector('.vault-detail') as HTMLElement | null;
      if (pane) samples.push({ scroll: pane.scrollHeight, height: pane.clientHeight });
      await new Promise(requestAnimationFrame);
    }
    return samples;
  });
  check('returning to wide empty detail never creates a transient scrollbar', frames.length > 0 && frames.every(f => f.scroll <= f.height), frames);
  await page.evaluate(() => { delete document.documentElement.dataset.nativeTitlebar; });

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await visit('generator');
  check('reduced motion uses negligible duration', await page.$eval('.panel', (element: HTMLElement) => parseFloat(getComputedStyle(element).animationDuration) < 0.001));
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"]', { hidden: true });
  check('no browser runtime errors', errors.length === 0, errors);
  console.log(JSON.stringify({ checks, screenshots: output }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') });
  throw error;
} finally {
  await browser.close();
  server.stop(true);
}
