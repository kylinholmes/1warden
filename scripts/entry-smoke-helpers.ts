import type { Page } from 'puppeteer-core';

/** Compact login forms keep the server controls behind the visible disclosure. */
export async function openServerOptions(page: Page): Promise<void> {
  // Navigation can still be restoring its draft when this helper is called.
  await page.waitForSelector('[role="combobox"][aria-label="服务器"]');
  const summary = await page.$('.auth-server-details:not([open]) > summary');
  if (summary) {
    await summary.evaluate(node => (node as HTMLElement).click());
    await page.waitForSelector('.auth-server-details[open]');
  }
  await page.waitForSelector('[role="combobox"][aria-label="服务器"]', { visible: true });
}

/** Login/registration defaults to a preset; local smoke servers opt into Custom. */
export async function selectCustomServer(page: Page): Promise<void> {
  await openServerOptions(page);
  if (await page.$('input[type="url"]')) return;
  await page.$eval('[role="combobox"][aria-label="服务器"]', button => (button as HTMLButtonElement).click());
  await page.waitForSelector('[role="option"][data-value="custom"]');
  await page.$eval('[role="option"][data-value="custom"]', option => (option as HTMLElement).click());
  await page.waitForSelector('input[type="url"]');
}
