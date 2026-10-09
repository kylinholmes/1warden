// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeneratorBody } from '../../../../packages/ui/src/Generator';
import { installNativeClipboardCopy } from '../../../../packages/ui/src/clipboard';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const write = vi.fn<(value: string) => Promise<void>>();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  write.mockReset();
  // Install the fake native boundary before rendering: no navigator/system clipboard access.
  installNativeClipboardCopy(write);
});
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  host?.remove(); root = undefined; host = undefined;
  installNativeClipboardCopy(null);
});
async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(createElement(GeneratorBody)));
}
async function click(label: string) {
  const node = [...host!.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
  if (!node) throw new Error(`Missing button ${label}`);
  await act(() => node.click());
}
describe('Generator clipboard feedback', () => {
  it('announces failed copy and clears the error only after a successful retry', async () => {
    write.mockRejectedValueOnce(new Error('clipboard busy')).mockResolvedValueOnce(undefined);
    await mount();
    const generated = host!.querySelector('.generator-result p')!.textContent!;
    expect(generated.length).toBe(20);
    await click('复制');
    expect(write).toHaveBeenCalledExactlyOnceWith(generated);
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain('复制失败');
    expect(host!.querySelector('[data-state="ok"]')).toBeNull();
    await click('复制');
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(generated);
    expect(host!.querySelector('[role="alert"]')).toBeNull();
    expect(host!.querySelector('[data-state="ok"]')?.textContent).toBe('已复制');
  });
  it('does not carry an old copy error into a newly generated value', async () => {
    write.mockRejectedValueOnce(new Error('clipboard busy'));
    await mount(); await click('复制');
    expect(host!.querySelector('[role="alert"]')).not.toBeNull();
    await click('换一个');
    expect(host!.querySelector('[role="alert"]')).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
