// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImportView, type ImportPreview } from '@1warden/ui';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); host.remove(); });
const preview: ImportPreview = { fileName: 'synthetic.csv', format: 'bitwarden-csv', formatLabel: 'CSV', total: 3,
  byType: { login: 3 }, folders: 1, skipped: [] };
const defaults = { preview: null, progress: null, result: null, error: null, hasFile: false, autoFormat: null,
  onPick: vi.fn(), onFormatChange: vi.fn(), onRun: vi.fn(), onReset: vi.fn() };
const render = async (props: Partial<Parameters<typeof ImportView>[0]>) => {
  await act(() => root.render(createElement(ImportView, { ...defaults, ...props })));
};

it('focuses semantic stage headings, announces only concise counts and returns to the picker on reset', async () => {
  await render({});
  const help = host.querySelector('details')!;
  expect(help.open).toBe(false);
  expect(host.textContent).toContain('最大 50 MiB');
  await render({ preview, hasFile: true });
  expect(document.activeElement?.textContent).toBe('导入预览');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('可导入 3 条记录、1 个文件夹');
  await render({ preview, hasFile: true, progress: { done: 1, total: 3 } });
  const heading = document.activeElement;
  expect(heading?.textContent).toBe('正在导入');
  await render({ preview, hasFile: true, progress: { done: 2, total: 3 } });
  expect(document.activeElement).toBe(heading);
  await render({ preview, hasFile: true, result: { created: 2, skippedExisting: 0, failed: [{ name: 'Synthetic login', reason: '离线，请重试' }] } });
  expect(document.activeElement?.textContent).toBe('导入部分完成');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('1 项未完成或未能确认');
  expect(host.querySelector('[role="status"]')?.textContent).not.toContain('Synthetic login');
  expect(host.textContent).toContain('Synthetic login');
  await render({});
  expect(document.activeElement).toBe(host.querySelector('[data-import-pick]'));
});

it('keeps all skipped row numbers and failure reasons accessible through delayed batches', async () => {
  const skipped = Array.from({ length: 123 }, (_, index) => ({ rowNumber: index + 1, reason: `Synthetic reason ${index + 1}` }));
  await render({ preview: { ...preview, skipped }, hasFile: true });
  expect(host.querySelectorAll('li')).toHaveLength(8);
  expect(host.textContent).toContain('123 行不会被导入');
  const details = host.querySelectorAll('details')[1]!;
  await act(() => { details.open = true; details.dispatchEvent(new Event('toggle')); });
  expect(host.querySelectorAll('li')).toHaveLength(58);
  for (let i = 0; i < 2; i++) {
    const more = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('再显示'))!;
    await act(() => { more.focus(); more.click(); });
    if (i === 0) expect(document.activeElement).toBe(more);
  }
  expect(host.querySelectorAll('li')).toHaveLength(123);
  expect(document.activeElement).toBe(details.querySelector('summary'));
  expect(host.textContent).toContain('Synthetic reason 123');
  const failed = skipped.map(row => ({ name: `Synthetic ${row.rowNumber}`, reason: row.reason }));
  await render({ result: { created: 0, failed }, hasFile: true });
  expect(host.querySelectorAll('li')).toHaveLength(8);
  expect(host.textContent).toContain('有 123 项未完成或未能确认');
  expect(host.querySelector('[role="status"]')?.textContent).not.toContain('Synthetic reason');
});

it('focuses recoverable import errors after a failed operation', async () => {
  await render({ preview, hasFile: true, progress: { done: null, total: 3 } });
  await render({ preview, hasFile: true, error: 'Synthetic network failure' });
  expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));
  expect([...host.querySelectorAll('button')].some(button => button.textContent === '导入这 3 条' && !button.disabled)).toBe(true);
});
