#!/usr/bin/env bun
/** Failed login -> close popup document -> reopen, using a local fake server and fresh profile. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const product = process.argv[2];
if (product !== 'edge' && product !== 'zen') throw new Error('Usage: bun scripts/connection-smoke.ts edge|zen');
const firefox = product === 'zen';
const { default: puppeteer } = await import(process.env.COFFER_PUPPETEER
  ? pathToFileURL(resolve(process.env.COFFER_PUPPETEER)).href : 'puppeteer-core');
const profile = mkdtempSync(join(tmpdir(), `coffer-connection-${product}-`));
const uuid = '3791a0b1-2d30-4794-b5d0-b87bd6725ce6';
let requests = 0;
let holdFailure = false;
let releaseFailure: (() => void) | null = null;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (new URL(request.url).pathname === '/identity/accounts/prelogin') {
    requests++;
    if (holdFailure) await new Promise<void>((resolve) => { releaseFailure = resolve; });
    return Response.json({ message: 'Synthetic connection failure' }, { status: 503 });
  }
  return new Response('', { status: 404 });
} });
const serverUrl = `http://127.0.0.1:${server.port}`;
const email = 'reopen@example.invalid';
const password = 'Synthetic-Password-Not-To-Persist';
let browser: any;
let page: any;
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${product}: ${message}`);
}
try {
  browser = await puppeteer.launch({
    browser: firefox ? 'firefox' : 'chrome', headless: true, userDataDir: profile,
    executablePath: process.env[`COFFER_${product.toUpperCase()}`] ?? (firefox
      ? '/Applications/Zen.app/Contents/MacOS/zen' : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    defaultViewport: null, enableExtensions: true, protocolTimeout: 30_000,
    ...(firefox ? { args: ['--remote-allow-system-access'], extraPrefsFirefox: {
      'extensions.webextensions.uuids': JSON.stringify({ 'coffer@coffer.app': uuid }),
    } } : { pipe: true }),
  });
  const id = await browser.installExtension(resolve(import.meta.dir, '../apps/desktop', firefox ? 'dist-firefox' : 'dist-extension'));
  const url = `${firefox ? `moz-extension://${uuid}` : `chrome-extension://${id}`}/popup.html`;
  async function open(selector = 'input[type="email"]') {
    page = await browser.newPage();
    if (firefox) await page.mainFrame().browsingContext.navigate(url, 'interactive');
    else await page.goto(url);
    await page.waitForSelector(selector, { timeout: 10_000 });
  }
  await open();
  await page.evaluate((values: string[]) => {
    for (const [index, type] of ['url', 'email', 'password'].entries()) {
      const input = document.querySelector(`input[type="${type}"]`) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, values[index]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, [serverUrl, email, password]);
  await page.evaluate(() => (document.querySelector('button[type="submit"]') as HTMLButtonElement).click());
  await page.waitForSelector('[role="alert"]', { timeout: 10_000 });
  const error = await page.$eval('[role="alert"]', (node: Element) => node.textContent);
  check(requests === 1, 'login request reached the local fake server');
  check(Boolean(error) && !error.includes('Receiving end'), 'server failure returned through the background');
  await page.close();
  await open();
  const restored = await page.evaluate(() => ({
    serverUrl: (document.querySelector('input[type="url"]') as HTMLInputElement).value,
    email: (document.querySelector('input[type="email"]') as HTMLInputElement).value,
    password: (document.querySelector('input[type="password"]') as HTMLInputElement).value,
    error: document.querySelector('[role="alert"]')?.textContent,
  }));
  check(restored.serverUrl === serverUrl && restored.email === email, 'reopened form restores server and email');
  check(restored.error === error, 'reopened form preserves the failure');
  check(restored.password === '', 'reopened form clears the master password');
  const draft = await page.evaluate(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return JSON.stringify(await api.storage.session.get('coffer.connectionDraft'));
  });
  check(!draft.includes(password), 'draft does not retain the master password');
  await page.evaluate(() => {
    const input = document.querySelector('input[type="email"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'edited@example.invalid');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return (await api.storage.session.get('coffer.connectionDraft'))['coffer.connectionDraft']?.email === 'edited@example.invalid';
  });
  await page.close();
  await open();
  check(await page.$eval('input[type="email"]', (input: HTMLInputElement) => input.value) === 'edited@example.invalid',
    'unsubmitted edits also survive closing the popup');
  check(requests === 1, 'reopening never resubmits login automatically');
  await page.evaluate(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    await api.storage.session.remove('coffer.connectionDraft');
    await api.storage.local.set({ 'coffer.accounts': JSON.stringify([
      { serverUrl: 'https://first.example.invalid', email: 'first@example.invalid' },
      { serverUrl: 'https://second.example.invalid', email: 'second@example.invalid' },
    ]) });
  });
  await page.close();
  await open('h1');
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === '选择要连接的账户');
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
  check(await page.evaluate(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return !(await api.storage.session.get('coffer.connectionDraft'))['coffer.connectionDraft'];
  }), 'opening the account picker does not silently select or save its first account');
  await page.close();
  await open('h1');
  check(await page.$eval('h1', (node: Element) => node.textContent) === '选择要连接的账户',
    'reopening keeps the account picker until an account is chosen');
  async function back() {
    const button = await page.evaluateHandle(() => [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '返回'));
    check(Boolean(button.asElement()), 'full Add Account form has a Back action');
    if (firefox) await button.evaluate((node: HTMLButtonElement) => node.click());
    else await button.asElement()!.click();
    await button.dispose();
  }
  async function otherServer() {
    const button = await page.evaluateHandle(() => [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '连接其他服务器'));
    if (firefox) await button.evaluate((node: HTMLButtonElement) => node.click());
    else await button.asElement()!.click();
    await button.dispose();
    await page.waitForSelector('input[type="url"]');
  }
  await otherServer();
  await page.evaluate((values: string[]) => {
    for (const [index, type] of ['url', 'email', 'password'].entries()) {
      const input = document.querySelector(`input[type="${type}"]`) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, values[index]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, [serverUrl, email, password]);
  await page.evaluate(() => (document.querySelector('button[type="submit"]') as HTMLButtonElement).click());
  await page.waitForSelector('[role="alert"]');
  await back();
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === '选择要连接的账户');
  check(await page.$('[role="alert"]') === null, 'Back removes the abandoned login error');
  await page.waitForFunction(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return !(await api.storage.session.get('coffer.connectionDraft'))['coffer.connectionDraft'];
  });
  await otherServer();
  check(await page.$eval('input[type="password"]', (input: HTMLInputElement) => input.value) === '',
    'Back clears the master password before opening another form');
  await back();
  await page.close();
  await open('h1');
  const afterBackHeading = await page.$eval('h1', (node: Element) => node.textContent);
  if (afterBackHeading !== '选择要连接的账户') console.error(await page.evaluate(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return { heading: document.querySelector('h1')?.textContent,
      draft: (await api.storage.session.get('coffer.connectionDraft'))['coffer.connectionDraft'] };
  }));
  check(afterBackHeading === '选择要连接的账户',
    'Back clears the draft so a reopened popup returns to the picker');

  await otherServer();
  await page.evaluate((values: string[]) => {
    for (const [index, type] of ['url', 'email', 'password'].entries()) {
      const input = document.querySelector(`input[type="${type}"]`) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, values[index]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, [serverUrl, email, password]);
  holdFailure = true;
  await page.evaluate(() => (document.querySelector('button[type="submit"]') as HTMLButtonElement).click());
  const heldRequestDeadline = Date.now() + 5000;
  while (!releaseFailure && Date.now() < heldRequestDeadline) await Bun.sleep(10);
  check(Boolean(releaseFailure), 'login request is still pending when Back is pressed');
  await back();
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === '选择要连接的账户'
    && [...document.querySelectorAll('button')].every(button => !button.disabled));
  holdFailure = false;
  (releaseFailure as unknown as () => void)();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
  check(await page.$('[role="alert"]') === null, 'a late failed request cannot restore the abandoned error');
  check(await page.evaluate(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return !(await api.storage.session.get('coffer.connectionDraft'))['coffer.connectionDraft'];
  }), 'a late failed request cannot recreate the cleared draft');

  await page.evaluate(async () => {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    await api.storage.session.set({ 'coffer.connectionDraft': {
      serverUrl: '', email: '', error: null,
      returnAccount: { serverUrl: 'https://first.example.invalid', email: 'first@example.invalid' },
    } });
  });
  await page.close();
  await open();
  await back();
  await page.waitForSelector('input[type="password"]');
  check(await page.$('input[type="email"]') === null && await page.evaluate(() => document.body.textContent?.includes('first@example.invalid')),
    'Back from Add Account selects its original account rather than the generic picker');
} finally {
  await browser?.close();
  server.stop(true);
  rmSync(profile, { recursive: true, force: true });
}
