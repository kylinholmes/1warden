#!/usr/bin/env bun
/** Shared navigation and stacked-field checks against synthetic data in an isolated Edge. */
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
let size = '', activeTheme = 'dark';
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
  size = `${width}x${height}-${activeTheme}`;
  await page.setViewport({ width, height });
  await page.goto(`http://127.0.0.1:${server.port}/?screen=vault&theme=${activeTheme}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.vault-list li > button');
  await settle();
  check('requested theme is active in the rendered application', await page.evaluate((theme: string) =>
    document.documentElement.dataset.theme === theme, activeTheme));
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
async function formType(label: string) {
  const handle = await page.evaluateHandle((text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find(button => button.textContent?.trim() === text), label);
  const button = handle.asElement();
  if (!button) throw new Error(`Missing item type: ${label}`);
  await button.click(); await handle.dispose(); await settle();
}
/** Measure the rendered contract, not Tailwind classes or the old monospace selector.
 * Independent fields occupy the card width; compound cells may share one row.
 * Native inputs may scroll long values, but detail text must remain visible.
 */
async function stackedGeometry(scope: string, editor: boolean) {
  return await page.evaluate(({ scope, editor }: { scope: string; editor: boolean }) => {
    const root = document.querySelector<HTMLElement>(scope)!;
    const inner = (node: HTMLElement) => {
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      const leftInset = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      const rightInset = parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight);
      const cssOuterWidth = parseFloat(style.width) + (style.boxSizing === 'border-box' ? 0 : leftInset + rightInset);
      const scale = box.width / cssOuterWidth;
      return { left: box.left + leftInset * scale, right: box.right - rightInset * scale,
        cssWidth: cssOuterWidth - leftInset - rightInset };
    };
    const fields = [...root.querySelectorAll<HTMLElement>('[data-field-label]')].flatMap(label => {
      const content = label.closest<HTMLElement>('[data-field-content]') ?? label.parentElement!;
      const row = editor ? label.parentElement! : label.closest<HTMLElement>('[data-field-layout]')!;
      const value = row.querySelector<HTMLElement>('[data-field-value]');
      if (!value) return [];
      const l = label.getBoundingClientRect(), v = value.getBoundingClientRect(), r = row.getBoundingClientRect();
      const parent = inner(row.parentElement!);
      const actions = row.querySelector<HTMLElement>('[data-field-actions]');
      const c = content.getBoundingClientRect(), a = actions?.getBoundingClientRect();
      const compound = row.closest<HTMLElement>('[data-compound-field]');
      return [{ label: label.textContent?.trim(), labelAbove: l.bottom <= v.top + 1,
        leftAligned: Math.abs(l.left - v.left) < 1 && Math.abs(l.left - c.left) < 1,
        fullRow: Math.abs(r.left - parent.left) < 1 && Math.abs(r.right - parent.right) < 1,
        compound: compound?.getAttribute('data-compound-field') ?? null,
        actionsCentered: editor || !a || Boolean(a && Math.abs(a.top + a.height / 2 - c.top - c.height / 2) < 1),
        actionsBeside: editor || !a || Boolean(a && a.left >= c.right - 1 && a.right <= r.right + 1),
        contained: r.left >= 0 && r.right <= innerWidth && row.scrollWidth <= row.clientWidth,
        valueContained: editor || value.scrollWidth <= value.clientWidth,
        contentPresent: editor || Boolean(value.textContent?.trim()),
        valueVisible: editor || (getComputedStyle(value).overflowX === 'visible'
          && getComputedStyle(value).textOverflow !== 'ellipsis' && getComputedStyle(value).visibility === 'visible'),
        left: l.left, top: r.top, width: r.width }];
    });
    const compounds = ['identity.name', 'identity.region'].map(id => {
      const group = root.querySelector<HTMLElement>(`[data-compound-field="${id}"]`)!;
      const grid = group.querySelector<HTMLElement>('[data-compound-cells]')!;
      const inside = inner(grid), container = inner(group);
      const cells = [...grid.children].map(cell => cell.getBoundingClientRect());
      const labels = [...grid.querySelectorAll('[data-field-label]')].map(label => label.getBoundingClientRect());
      const sameRow = cells.every(cell => Math.abs(cell.top - cells[0]!.top) < 1);
      const stacked = cells.every((cell, index) => (index === 0 || cell.top >= cells[index - 1]!.bottom - 1)
        && Math.abs(cell.left - inside.left) < 1 && Math.abs(cell.right - inside.right) < 1);
      // Bounding boxes include CSS zoom; container queries use unscaled CSS px.
      const width = container.cssWidth;
      const shouldShare = cells.length === 1 || width >= (cells.length === 2 ? 240 : 360);
      return { id, count: cells.length,
        atomic: sameRow || stacked, expectedMode: shouldShare ? sameRow : stacked,
        labelsTopAligned: !sameRow || labels.every(label => Math.abs(label.top - labels[0]!.top) < 1),
        equalColumns: !sameRow || (Math.max(...cells.map(cell => cell.width)) - Math.min(...cells.map(cell => cell.width)) < 1
          && cells.every((cell, index) => index === 0 || cell.left >= cells[index - 1]!.right - 1)),
        start: inside.left, width, sameRow, stacked,
        contained: group.scrollWidth <= group.clientWidth && grid.scrollWidth <= grid.clientWidth };
    });
    return { fields, compounds, documentContained: document.documentElement.scrollWidth <= innerWidth };
  }, { scope, editor });
}
async function assertStacked(scope: string, editor: boolean, context: string) {
  const geometry = await stackedGeometry(scope, editor);
  check(`${context} exposes label/value geometry for ordinary and compound fields`, geometry.fields.length >= (editor ? 6 : 5), geometry);
  check(`${context} every label is above its left-aligned content`, geometry.fields.every(field => field.labelAbove && field.leftAligned), geometry.fields);
  const ordinary = geometry.fields.filter(field => !field.compound);
  check(`${context} independent fields use the complete card content width`, ordinary.length > 0 && ordinary.every(field => field.fullRow), geometry.fields);
  check(`${context} ordinary fields and compound groups share one left origin`, ordinary.every(field => Math.abs(field.left - ordinary[0]!.left) < 1)
    && geometry.compounds.every(group => Math.abs(group.start - ordinary[0]!.left) < 1), geometry);
  check(`${context} long content stays present, visible and contained`, geometry.fields.every(field => field.contained && field.valueContained && field.contentPresent && field.valueVisible) && geometry.documentContained, geometry.fields);
  check(`${context} field actions sit beside and vertically centered on their complete label/value content`, geometry.fields.every(field => field.actionsCentered && field.actionsBeside), geometry.fields);
  for (const group of geometry.compounds) {
    check(`${context} ${group.id} is one complete equal-column row or a whole stacked group, never 2+1`, group.count > 0 && group.atomic && group.expectedMode && group.equalColumns && group.labelsTopAligned && group.contained, group);
  }
}
async function alignedFields(width: number) {
  await page.click('button[title^="新建条目"]'); await page.waitForSelector('#editor-title');
  const longUrl = 'https://example.invalid/' + 'SyntheticLongPathWithoutSpaces'.repeat(6);
  await page.focus('[aria-label="网址 1"]'); await page.keyboard.sendCharacter(longUrl); await settle();
  const url = await page.$eval('[data-editor-url="0"]', (node: HTMLElement) => {
    const input = node.querySelector<HTMLInputElement>('[aria-label="网址 1"]')!;
    const line = node.querySelector<HTMLElement>('[data-editor-url-label-row]')!;
    const label = line.querySelector<HTMLLabelElement>('label')!;
    const remove = line.querySelector<HTMLButtonElement>('[aria-label="删除网址 1"]')!;
    const i = input.getBoundingClientRect(), r = line.getBoundingClientRect();
    const l = label.getBoundingClientRect(), d = remove.getBoundingClientRect();
    return { labelAbove: r.bottom <= i.top + 1 && l.bottom <= i.top + 1,
      sharedRow: l.top < d.bottom && l.bottom > d.top && l.right <= d.left,
      fullWidth: Math.abs(r.left - i.left) < 1 && Math.abs(r.right - i.right) < 1,
      associated: label.htmlFor === input.id, deletable: !remove.disabled && remove.tabIndex >= 0,
      contained: node.scrollWidth <= node.clientWidth && i.left >= 0 && i.right <= innerWidth,
      retained: input.value };
  });
  check('URL label and keyboard-accessible deletion share one row above the complete-width long URL',
    url.labelAbove && url.sharedRow && url.fullWidth && url.associated && url.deletable && url.contained && url.retained === longUrl, url);
  await page.$eval('[data-editor-url="0"]', node => node.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: join(output, `editor-url-${size}.png`) });
  await formType('身份信息');
  await assertStacked('[role="dialog"]', true, 'new identity editor');
  await page.$eval('[data-compound-field="identity.name"]', node => node.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: join(output, `aligned-names-${size}.png`) });
  await formType('护照');
  await page.$eval('[aria-label="出生日期"]', node => node.scrollIntoView({ block: 'center' }));
  check('narrow date frame fits its stacked field', await page.$eval('[aria-label="出生日期"]', (node: HTMLElement) =>
    node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().right <= innerWidth));
  await page.focus('[aria-label="出生日期年份"]'); await page.keyboard.sendCharacter('2026-10-09');
  check('a full pasted date populates all three slots', JSON.stringify(await page.$$eval('[aria-label="出生日期"] input', nodes =>
    nodes.map(node => (node as HTMLInputElement).value))) === JSON.stringify(['2026', '10', '09']));
  const frame = await page.$eval('[aria-label="出生日期"]', node => node.getBoundingClientRect().toJSON());
  await page.click('#editor-title'); await page.mouse.click(frame.right - 10, frame.top + frame.height / 2);
  check('date trailing padding is an input hit target', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '出生日期日期'));
  check('editing form does not create document overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
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
async function alignedDetails(width: number, height: number) {
  for (const fixture of ['identity-partial', 'identity-complete', 'identity-short', 'identity-partial-two']) {
    await page.goto(`http://127.0.0.1:${server.port}/?screen=vault&fixture=${fixture}&theme=${activeTheme}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.vault-list li > button');
    await page.click('.vault-list li > button'); await page.waitForSelector('[data-compound-field="identity.name"]'); await settle();
    await assertStacked('.vault-detail', false, fixture + ' detail');
    const counts = await page.evaluate(() => ['identity.name', 'identity.region'].map(id =>
      document.querySelector(`[data-compound-field="${id}"] [data-compound-cells]`)!.children.length));
    check(`${fixture} detail omits empty compound fields instead of reserving slots`,
      JSON.stringify(counts) === JSON.stringify(fixture === 'identity-partial' ? [1, 1] : fixture === 'identity-partial-two' ? [2, 1] : [3, 2]), counts);
    if (fixture === 'identity-short') {
      const values = await page.$$eval('.vault-detail [data-compound-cells] [data-field-value]', nodes => nodes.map(node => node.textContent));
      check('short identity preserves all three names and both region fields', JSON.stringify(values) === JSON.stringify(['Herzog', 'Werner', 'Werner Herzog', 'Alaska', 'Anchorage']), values);
    }
    check(`${fixture} renders unbroken long ordinary and custom values without truncating data`, await page.$$eval('.vault-detail [data-field-value]', nodes =>
      ['SyntheticCompanyWithoutSpaces'.repeat(6), 'SyntheticCustomValueWithoutSpaces'.repeat(6)]
        .every(value => nodes.some(node => node.textContent === value))));
    await page.screenshot({ path: join(output, `detail-${fixture}-${size}.png`) });
    await page.$eval('.vault-detail [data-compound-field="identity.region"]', node => node.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: join(output, `detail-region-${fixture}-${size}.png`) });
    const handle = await page.evaluateHandle(() => [...document.querySelectorAll<HTMLButtonElement>('.vault-detail button')]
      .find(button => button.textContent?.trim() === '编辑'));
    const button = handle.asElement();
    if (!button) throw new Error('Missing fixture edit action');
    await button.click(); await handle.dispose();
    await page.waitForSelector('[data-editor-field="identity.company"] input'); await settle();
    await assertStacked('[role="dialog"]', true, fixture + ' editor');
    check(`${fixture} editing retains the complete long source value`, await page.$eval('[data-editor-field="identity.company"] input', node =>
      (node as HTMLInputElement).value === 'SyntheticCompanyWithoutSpaces'.repeat(6)));
    const custom = await page.$eval('[data-editor-custom="0"]', (node: HTMLElement) => {
      const name = node.querySelector<HTMLInputElement>('[aria-label="字段 1 名称"]')!;
      const value = node.querySelector<HTMLInputElement>('[aria-label="字段 1 值"]')!;
      const type = node.querySelector<HTMLSelectElement>('[aria-label="字段 1 类型"]')!;
      const remove = node.querySelector<HTMLButtonElement>('[aria-label="删除字段 1"]')!;
      const nameRow = node.querySelector<HTMLElement>('[data-editor-custom-name-row]')!;
      const label = type.parentElement!.querySelector('span')!;
      const n = name.getBoundingClientRect(), v = value.getBoundingClientRect(), t = type.getBoundingClientRect();
      const d = remove.getBoundingClientRect(), row = nameRow.getBoundingClientRect();
      const l = label.getBoundingClientRect(), box = node.getBoundingClientRect(), style = getComputedStyle(node);
      const left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      const right = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
      return { nameAboveValue: row.bottom <= v.top + 1, typeLabelAbove: l.bottom <= t.top + 1,
        fullWidth: [row, v, t].every(rect => Math.abs(rect.left - left) < 1 && Math.abs(rect.right - right) < 1)
          && Math.abs(n.left - left) < 1,
        deleteBesideName: n.right <= d.left && d.top < n.bottom && d.bottom > n.top
          && Math.abs(d.right - right) < 1 && !remove.disabled && remove.tabIndex >= 0,
        contained: node.scrollWidth <= node.clientWidth && box.left >= 0 && box.right <= innerWidth,
        retained: value.value === 'SyntheticCustomValueWithoutSpaces'.repeat(6) };
    });
    check(`${fixture} custom name and deletion share one full row above full-width value and type`,
      custom.nameAboveValue && custom.typeLabelAbove && custom.fullWidth && custom.deleteBesideName && custom.contained && custom.retained, custom);
    await page.$eval('[data-compound-field="identity.name"]', node => node.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: join(output, `editor-${fixture}-${size}.png`) });
    await page.$eval('[role="dialog"] [data-compound-field="identity.region"]', node => node.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: join(output, `editor-region-${fixture}-${size}.png`) });
    await page.$eval('[data-editor-custom="0"]', node => node.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: join(output, `editor-custom-${fixture}-${size}.png`) });
  }
}
/** Genuine CSS zoom changes available layout width. DPR alone does not.
 * These middle bands were stacked by the former 320/480px breakpoints.
 */
async function compoundZoomCases() {
  const cases = [
    { width: 500, zoom: 1, fixture: 'identity-short', min: 360, max: 480, sameRow: true },
    { width: 400, zoom: 1, fixture: 'identity-partial-two', min: 240, max: 320, sameRow: true },
    { width: 600, zoom: 1.25, fixture: 'identity-short', min: 360, max: 480, sameRow: true },
    { width: 600, zoom: 1.5, fixture: 'identity-partial-two', min: 240, max: 320, sameRow: true },
    { width: 600, zoom: 1.5, fixture: 'identity-short', min: 0, max: 360, sameRow: false },
    { width: 400, zoom: 1.5, fixture: 'identity-partial-two', min: 0, max: 240, sameRow: false },
  ];
  for (const theme of ['dark', 'light']) {
    for (const scenario of cases) {
      size = `compound-${scenario.fixture}-${scenario.width}x900-zoom${scenario.zoom * 100}-${theme}`;
      await page.setViewport({ width: scenario.width, height: 900, deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:${server.port}/?screen=vault&fixture=${scenario.fixture}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
      await page.evaluate((zoom: number) => { document.documentElement.style.zoom = String(zoom); }, scenario.zoom);
      await page.waitForSelector('.vault-list li > button'); await page.click('.vault-list li > button');
      await page.waitForSelector('.vault-detail [data-compound-cells]'); await settle();
      check('CSS zoom, not device pixel ratio, is applied', await page.evaluate((zoom: number) =>
        Math.abs(parseFloat(getComputedStyle(document.documentElement).zoom) - zoom) < 0.001
        && devicePixelRatio === 1, scenario.zoom));
      const geometry = await stackedGeometry('.vault-detail', false);
      const name = geometry.compounds.find(group => group.id === 'identity.name')!;
      check('name group exercises the intended unscaled CSS-width band', name.width >= scenario.min && name.width < scenario.max, name);
      check('middle widths share one complete row; insufficient widths stack the whole group',
        scenario.sameRow ? name.sameRow : name.stacked && !name.sameRow, name);
      await assertStacked('.vault-detail', false, size);
      const values = await page.$$eval('.vault-detail [data-compound-field="identity.name"] [data-field-value]', nodes => nodes.map(node => node.textContent));
      check('zoom retains every populated name and omits empty slots', JSON.stringify(values) === JSON.stringify(scenario.fixture === 'identity-short'
        ? ['Herzog', 'Werner', 'Werner Herzog'] : ['Herzog', 'Werner']), values);
      await page.screenshot({ path: join(output, `${size}.png`) });
    }
  }
}
/** Exercise inline copying through real pointer/keyboard actions. The browser
 * clipboard boundary is replaced before load; the OS clipboard is untouched.
 */
async function fieldActionCases() {
  const copy = '.vault-detail [data-field-copy]';
  const hint = `${copy} [data-copy-feedback]`;
  await page.evaluateOnNewDocument(() => {
    const writes: string[] = [];
    Object.assign(window, { __fieldWrites: writes });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { writes.push(value); },
      readText: async () => writes.at(-1) ?? '',
    } });
  });
  const writeCount = () => page.evaluate(() => (window as unknown as { __fieldWrites: string[] }).__fieldWrites.length);
  const opacity = (node: Element) => {
    let value = 1;
    for (let current: Element | null = node; current; current = current.parentElement) value *= parseFloat(getComputedStyle(current).opacity);
    return value;
  };
  for (const theme of ['dark', 'light']) {
    size = `field-actions-mouse-600x900-zoom125-${theme}`;
    await page.setViewport({ width: 600, height: 900, deviceScaleFactor: 1, hasTouch: false, isMobile: false });
    await page.goto(`http://127.0.0.1:${server.port}/?screen=vault&fixture=identity-short&theme=${theme}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { document.documentElement.style.zoom = '1.25'; });
    await page.waitForSelector('.vault-list li > button'); await page.click('.vault-list li > button'); await page.waitForSelector(copy); await settle();
    check('mouse test uses a fine pointer with hover support', await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches));
    await page.mouse.move(2, 2); await settle();
    const before = await page.$eval(copy, node => node.getBoundingClientRect().toJSON());
    check('field values remain visible while the idle copy hint is quiet', await page.$eval(copy, opacity) > 0.99 && await page.$eval(hint, opacity) < 0.01);
    check('field labels and full values do not expose redundant native title tooltips', await page.$$eval('.vault-detail [data-field-label], .vault-detail [data-field-value]', nodes =>
      nodes.every(node => !node.hasAttribute('title'))));
    await page.screenshot({ path: join(output, `${size}-idle.png`) });
    const label = await page.$eval('.vault-detail [data-field-label]', node => node.getBoundingClientRect().toJSON());
    await page.mouse.move(label.left + 2, label.top + 2); await settle();
    check('hovering the field exposes its inline copy hint', await page.$eval(hint, opacity) > 0.99);
    const hover = await page.$eval(copy, node => node.getBoundingClientRect().toJSON());
    check('hover does not move or resize the clickable field', ['left', 'top', 'width', 'height'].every(key => Math.abs(before[key] - hover[key]) < 1), { before, hover });
    await page.screenshot({ path: join(output, `${size}-hover.png`) });
    await page.mouse.move(2, 2); await page.focus('.vault-detail [data-page-back]');
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      if (await page.$eval(copy, node => document.activeElement === node)) break;
    }
    await settle();
    check('Tab focuses the field and shows its copy hint and focus outline', await page.$eval(copy, node => document.activeElement === node && getComputedStyle(node).outlineStyle !== 'none')
      && await page.$eval(hint, opacity) > 0.99);
    const focused = await page.$eval(copy, node => node.getBoundingClientRect().toJSON());
    check('keyboard focus leaves field geometry unchanged', ['left', 'top', 'width', 'height'].every(key => Math.abs(before[key] - focused[key]) < 1), { before, focused });
    await page.screenshot({ path: join(output, `${size}-focus.png`) });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window as unknown as { __fieldWrites: string[] }).__fieldWrites.length === 1);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => (window as unknown as { __fieldWrites: string[] }).__fieldWrites.length === 2);
    check('Enter and Space copy the focused field with inline success feedback',
      await page.$eval(copy, node => node.getAttribute('data-state') === 'ok')
      && await page.evaluate(() => (window as unknown as { __fieldWrites: string[] }).__fieldWrites.every(value => value === 'Herzog')));
    await page.click(`${copy} [data-field-value]`);
    check('clicking the displayed text copies without a separate copy button', await writeCount() === 3);

    size = `field-actions-touch-${theme}`;
    await page.setViewport({ width: 600, height: 900, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
    await page.goto(`http://127.0.0.1:${server.port}/?screen=vault&fixture=identity-short&theme=${theme}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.vault-list li > button'); await page.click('.vault-list li > button'); await page.waitForSelector(copy); await settle();
    check('touch test uses coarse pointer media without hover', await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches));
    const copies = await page.$$(hint);
    check('touch field copy actions remain continuously discoverable', (await Promise.all(copies.map((node: any) => node.evaluate(opacity)))).every(value => value > 0.99));
    await page.tap(copy);
    await page.waitForFunction(() => (window as unknown as { __fieldWrites: string[] }).__fieldWrites.length === 1);
    check('tapping field content copies once', await writeCount() === 1);
    await page.screenshot({ path: join(output, `${size}.png`) });

    size = `totp-actions-${theme}`;
    await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 1, hasTouch: false, isMobile: false });
    await page.goto(`http://127.0.0.1:${server.port}/?screen=detail&theme=${theme}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-field-layout="totp"] [role="timer"]'); await settle(); await page.mouse.move(2, 2); await settle();
    check('TOTP countdown is visible even while its inline copy hint is quiet', await page.$eval('[data-field-layout="totp"] [role="timer"]', opacity) > 0.99
      && await page.$eval('[data-field-layout="totp"] [data-copy-feedback]', opacity) < 0.01);
    check('TOTP countdown still has a named, nonzero visible timer surface', await page.$eval('[data-field-layout="totp"] [role="timer"]', (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      return Boolean(node.getAttribute('aria-label')) && rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility === 'visible';
    }));
    const digits = await page.$eval('[aria-label="复制验证码"] [data-field-value]', node => node.textContent!.replace(/\s/g, ''));
    await page.click('[aria-label="复制验证码"] [data-field-value]');
    await page.waitForSelector('[aria-label="复制验证码"][data-state="ok"]');
    check('OTP content copies digits without display spacing', await page.evaluate(() =>
      (window as unknown as { __fieldWrites: string[] }).__fieldWrites.at(-1)) === digits);
    await page.screenshot({ path: join(output, `${size}.png`) });
  }
}
try {
  await compoundZoomCases();
  await fieldActionCases();
  for (const theme of ['dark', 'light']) {
  activeTheme = theme;
  for (const [width, height] of [[320, 640], [440, 740], [600, 740], [899, 700], [900, 700], [1280, 850]] as const) {
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

    for (const [key, title] of [['security', '安全报告'], ['organization', '整理与分析'], ['import', '导入']] as const) {
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
    await alignedFields(width);
    await alignedDetails(width, height);
    console.log(`PASS ${size}: shared back, actionable ancestors, focus, keyboard and overflow`);
  }
  }
  // A launcher already has a full-width search surface: it must not gain a
  // second rounded focus frame from the application's global focus rule.
  for (const theme of ['light', 'dark']) {
    size = `quick-${theme}`;
    await page.setViewport({ width: 780, height: 500 });
    await page.goto(`http://127.0.0.1:${server.port}/?screen=quick&theme=${theme}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.quick-search-input'); await settle();
    const focus = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('.quick-search-input')!;
      const head = input.closest('.quick-search-head')!;
      const style = getComputedStyle(input);
      return { focused: document.activeElement === input, outline: style.outlineStyle,
        border: style.borderWidth, radius: style.borderRadius, shadow: style.boxShadow,
        headShadow: getComputedStyle(head).boxShadow };
    });
    check('quick search focuses without an inner frame', focus.focused && focus.outline === 'none'
      && focus.border === '0px' && focus.radius === '0px' && focus.shadow === 'none', focus);
    check('quick search surface retains a visible keyboard focus indicator', focus.headShadow !== 'none', focus);
    await page.screenshot({ path: join(output, `${size}.png`) });
    await page.keyboard.press('Tab');
    check('quick result buttons retain their own keyboard focus indicator', await page.evaluate(() =>
      document.activeElement?.tagName === 'BUTTON' && getComputedStyle(document.activeElement!).outlineStyle !== 'none'));
    check('leaving search removes its focus indicator', await page.$eval('.quick-search-head', node => getComputedStyle(node).boxShadow === 'none'));
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
