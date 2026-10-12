// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Select, type SelectProps } from '../../../../packages/ui/src/Select';
import { FloatingPanel } from '../../../../packages/ui/src/FloatingPanel';

let host: HTMLDivElement;
let root: Root;
const options = [
  { value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta', disabled: true },
  { value: 'c', label: 'Charlie' }, { value: 'd', label: 'Delta' },
];
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { if (root) await act(() => root.unmount()); host?.remove(); vi.restoreAllMocks(); });
async function mount(props: Partial<SelectProps> = {}, dialog = false) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const onChange = vi.fn(); const onClose = vi.fn();
  const control = createElement(Select, { value: 'a', options, onChange, 'aria-label': 'Fixture choice', ...props });
  await act(() => root.render(dialog ? createElement(FloatingPanel, { open: true, onClose, labelledBy: 'heading', children: control }) : control));
  const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  await act(() => trigger.focus());
  return { trigger, onChange, onClose };
}
async function key(trigger: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(() => trigger.dispatchEvent(event)); return event;
}
function current() { return host.querySelector('[data-active="true"]')?.textContent; }

describe('application themed select', () => {
  it('uses one named combobox and a checked selected option, with no native select', async () => {
    const { trigger, onChange } = await mount();
    expect(host.querySelector('select')).toBeNull();
    expect(trigger.textContent).toBe('Alpha');
    await act(() => trigger.click());
    expect(trigger.getAttribute('aria-controls')).toBe(host.querySelector('[role="listbox"]')?.id);
    expect(host.querySelector('[aria-selected="true"]')?.getAttribute('data-value')).toBe('a');
    expect(document.activeElement).toBe(trigger);
    expect(onChange).not.toHaveBeenCalled();
  });
  it('navigates enabled options only, supports Home/End, and commits only on Enter', async () => {
    const { trigger, onChange } = await mount();
    await key(trigger, 'ArrowDown'); expect(current()).toBe('Alpha');
    await key(trigger, 'ArrowDown'); expect(current()).toBe('Charlie');
    await key(trigger, 'End'); expect(current()).toBe('Delta');
    await key(trigger, 'Home'); expect(current()).toBe('Alpha');
    await key(trigger, 'ArrowUp'); expect(current()).toBe('Delta');
    expect(onChange).not.toHaveBeenCalled();
    await key(trigger, 'Enter'); expect(onChange).toHaveBeenCalledExactlyOnceWith('d');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it('typeahead is case-insensitive and never selects disabled values', async () => {
    const { trigger, onChange } = await mount();
    await key(trigger, 'C'); await key(trigger, 'h'); expect(current()).toBe('Charlie');
    await key(trigger, 'Enter'); expect(onChange).toHaveBeenCalledExactlyOnceWith('c');
    await key(trigger, 'b'); expect(current()).toBe('Alpha');
    await act(() => host.querySelector<HTMLElement>('[data-value="b"]')!.click());
    expect(onChange).toHaveBeenCalledTimes(1); expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await key(trigger, 'Escape'); expect(onChange).toHaveBeenCalledTimes(1);
  });
  it('the first Escape dismisses only the nested select; the next closes its dialog', async () => {
    const { trigger, onClose } = await mount({}, true);
    await act(() => trigger.click());
    expect(host.querySelector('[role="dialog"] [data-select-popup]')).not.toBeNull();
    await key(trigger, 'Escape'); expect(onClose).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(trigger);
    await key(trigger, 'Escape'); expect(onClose).toHaveBeenCalledOnce();
  });
  it('Tab dismisses without suppressing natural focus movement; outside focus is not stolen', async () => {
    const { trigger } = await mount();
    await act(() => trigger.click());
    expect((await key(trigger, 'Tab')).defaultPrevented).toBe(false);
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    await act(() => trigger.click());
    const outside = document.createElement('button'); host.append(outside);
    await act(() => { outside.dispatchEvent(new Event('pointerdown', { bubbles: true })); outside.focus(); });
    expect(host.querySelector('[role="listbox"]')).toBeNull(); expect(document.activeElement).toBe(outside);
  });
  it('preserves unknown current values without silently normalizing or firing onChange', async () => {
    const { trigger, onChange } = await mount({ value: 'legacy' });
    expect(trigger.textContent).toBe('已保存：legacy'); expect(trigger.value).toBe('legacy');
    await act(() => trigger.click()); await key(trigger, 'Escape');
    expect(onChange).not.toHaveBeenCalled(); expect(trigger.value).toBe('legacy');
  });
  it('retains an explicitly disabled current value but never commits it', async () => {
    const { trigger, onChange } = await mount({ value: 'b' });
    expect(trigger.textContent).toBe('Beta');
    await act(() => trigger.click()); expect(current()).toBe('Alpha');
    await act(() => host.querySelector<HTMLElement>('[data-value="b"]')!.click());
    expect(onChange).not.toHaveBeenCalled();
  });
  it('does not open while disabled or inside a disabled fieldset', async () => {
    const { trigger, onChange } = await mount({ disabled: true });
    await act(() => trigger.click()); expect(host.querySelector('[role="listbox"]')).toBeNull();
    await act(() => root.render(createElement('fieldset', { disabled: true },
      createElement(Select, { value: 'a', options, onChange }))));
    await key(host.querySelector('button')!, 'ArrowDown');
    expect(host.querySelector('[role="listbox"]')).toBeNull(); expect(onChange).not.toHaveBeenCalled();
  });
  it('dismisses when its parent becomes inert without restoring focus into the background', async () => {
    const { trigger } = await mount();
    await act(() => trigger.click());
    await act(() => { host.setAttribute('inert', ''); });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    await key(trigger, 'ArrowDown'); expect(host.querySelector('[role="listbox"]')).toBeNull();
  });
  it('keeps option scrolling open but closes when its editor scrolls behind the popup', async () => {
    const { trigger } = await mount();
    host.style.overflowY = 'auto';
    const rect = { left: 20, right: 220, top: 300, bottom: 344, width: 200, height: 44, x: 20, y: 300, toJSON() {} };
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => ({ ...rect }));
    await act(() => trigger.click());
    const list = host.querySelector('[data-select-popup]')!;
    await act(() => list.dispatchEvent(new Event('scroll')));
    expect(host.querySelector('[data-select-popup]')).toBe(list);
    await act(() => host.dispatchEvent(new Event('scroll')));
    expect(host.querySelector('[data-select-popup]')).toBe(list);
    rect.top = 100;
    host.scrollTop = 200;
    await act(() => host.dispatchEvent(new Event('scroll')));
    expect(host.querySelector('[data-select-popup]')).toBeNull();
  });
  it('repositions instead of dismissing during a clipped modal entrance scroll correction', async () => {
    const { trigger } = await mount();
    host.style.overflowX = 'hidden'; host.scrollLeft = 420;
    const rect = { left: 40, right: 420, top: 199, bottom: 243, width: 380, height: 44, x: 40, y: 199, toJSON() {} };
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => ({ ...rect }));
    await act(() => trigger.click());
    const list = host.querySelector<HTMLElement>('[data-select-popup]')!;
    // Real Edge clamps a programmatically scrolled overflow:hidden container
    // back towards zero as its translated child enters. No user pane was scrolled.
    rect.left = 20; rect.right = 400; host.scrollLeft = 264;
    await act(() => host.dispatchEvent(new Event('scroll')));
    expect(host.querySelector('[data-select-popup]')).toBe(list);
    expect(list.style.left).toBe('20px');
  });
  it('follows an ancestor entrance animation and stops frame work once it finishes', async () => {
    const { trigger } = await mount();
    const animation = { playState: 'running', effect: { getComputedTiming: () => ({ iterations: 1 }) } };
    Object.defineProperty(host, 'getAnimations', { value: () => [animation], configurable: true });
    let nextFrame: FrameRequestCallback | undefined;
    const request = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { nextFrame = callback; return 77; });
    const rect = { left: 80, right: 280, top: 200, bottom: 244, width: 200, height: 44, x: 80, y: 200, toJSON() {} };
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => ({ ...rect }));
    await act(() => trigger.click());
    const list = host.querySelector<HTMLElement>('[data-select-popup]')!;
    expect(request).toHaveBeenCalledOnce();
    rect.left = 40; await act(() => nextFrame!(16));
    expect(list.style.left).toBe('40px'); expect(request).toHaveBeenCalledTimes(2);
    rect.left = 20; animation.playState = 'finished'; await act(() => nextFrame!(32));
    expect(list.style.left).toBe('20px'); expect(request).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-select-popup]')).toBe(list);
  });
  it('positions a constrained long list above a low-right anchor, and cleans up top-layer state', async () => {
    const show = vi.fn(), hide = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: show });
    Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value: hide });
    const { trigger } = await mount();
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ left: 950, right: 1020, top: 700, bottom: 744, width: 70, height: 44, x: 950, y: 700, toJSON() {} });
    await act(() => trigger.click());
    const list = host.querySelector<HTMLElement>('[data-select-popup]')!;
    expect(parseFloat(list.style.left) + parseFloat(list.style.width)).toBeLessThanOrEqual(innerWidth - 8);
    expect(parseFloat(list.style.top)).toBeLessThan(700);
    expect(show).toHaveBeenCalledOnce();
    await key(trigger, 'Escape'); expect(hide).toHaveBeenCalledOnce();
    delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
    delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
  });
});
