import type { Page } from 'puppeteer-core';

/** Login/registration defaults to a preset; local smoke servers opt into Custom. */
export async function selectCustomServer(page: Page): Promise<void> {
  await page.waitForSelector('[role="combobox"][aria-label="服务器"]');
  if (await page.$('input[type="url"]')) return;
  await page.$eval('[role="combobox"][aria-label="服务器"]', button => (button as HTMLButtonElement).click());
  await page.waitForSelector('[role="option"][data-value="custom"]');
  await page.$eval('[role="option"][data-value="custom"]', option => (option as HTMLElement).click());
  await page.waitForSelector('input[type="url"]');
}
