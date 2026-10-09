// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ItemEditor } from '../../../../packages/ui/src/ItemEditor';
import { blankCard, blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';

let root: Root;
let host: HTMLDivElement;
let outside: HTMLInputElement;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { if (root) await act(() => root.unmount()); host?.remove(); outside?.remove(); });
async function mount() {
  host = document.createElement('div'); document.body.append(host);
  outside = document.createElement('input'); document.body.append(outside);
  root = createRoot(host);
  const item = { ...blankEditorItem(), type: 'card' as const, rawType: 3, name: 'Card', login: null, card: blankCard() };
  await act(() => root.render(createElement(ItemEditor, {
    item, folders: [], open: true, onSave: async draft => ({ id: 'saved', name: draft.name }),
    onDone: () => {}, onCancel: () => {},
  })));
  await act(() => host.querySelector<HTMLButtonElement>('[data-editor-add-more]')!.click());
}

/** Safari buttons may blur the active control to the document before click.
 * Separate acts preserve that order, including React flushing the blur handler
 * before pointerup/click. HTMLElement.click alone never reproduces this bug.
 */
async function webkitPress(target: HTMLElement, focusTarget?: HTMLElement) {
  await act(() => {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await act(() => focusTarget ? focusTarget.focus() : (document.activeElement as HTMLElement).blur());
}
async function releaseAndClick(target: HTMLElement) {
  await act(() => {
    target.dispatchEvent(new Event('pointerup', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    target.click();
  });
}

describe('custom-field picker pointer and dismissal event order', () => {
  it('names the picker explicitly and only offers custom types while fixed card controls remain visible', async () => {
    await mount();
    expect(host.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('添加自定义字段');
    expect(host.querySelector('[data-editor-add-more]')?.textContent?.trim()).toBe('添加自定义字段');
    expect(host.querySelector('[data-add-field]')).toBeNull();
    expect(host.querySelector('[data-editor-field="card.brand"] select')).not.toBeNull();
    expect([...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(node => node.dataset.addCustom)).toEqual(['0', '1', '2', '3']);
  });
  it('adds and focuses the chosen custom field after a WebKit null-target blur', async () => {
    await mount();
    const choice = host.querySelector<HTMLButtonElement>('[data-add-custom="0"]')!;
    await webkitPress(choice);
    await releaseAndClick(choice);
    const control = host.querySelector<HTMLElement>('[aria-label="字段 1 名称"]');
    expect(control).not.toBeNull();
    expect(document.activeElement).toBe(control);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
  it('adds the chosen custom field when WebKit pointer focus moves to its FloatingPanel ancestor', async () => {
    await mount();
    const choice = host.querySelector<HTMLButtonElement>('[data-add-custom="0"]')!;
    const panel = host.querySelector<HTMLElement>('[role="dialog"]')!;
    let relatedTarget: EventTarget | null = null;
    document.activeElement!.addEventListener('focusout', event => { relatedTarget = (event as FocusEvent).relatedTarget; }, { once: true });
    await webkitPress(choice, panel);
    expect(relatedTarget).toBe(panel);
    await releaseAndClick(choice);
    const control = host.querySelector<HTMLElement>('[aria-label="字段 1 名称"]');
    expect(control).not.toBeNull();
    expect(document.activeElement).toBe(control);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
  it('does not add a field for a cancelled gesture that focused the FloatingPanel ancestor', async () => {
    await mount();
    const choice = host.querySelector<HTMLButtonElement>('[data-add-custom="0"]')!;
    const panel = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await webkitPress(choice, panel);
    await act(() => choice.dispatchEvent(new Event('pointercancel', { bubbles: true })));
    expect(host.querySelector('[data-editor-custom]')).toBeNull();
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
  });
  it('dismisses on sibling focus after a pointer press moved focus to the dialog ancestor', async () => {
    await mount();
    const choice = host.querySelector<HTMLButtonElement>('[data-add-custom="0"]')!;
    const panel = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await webkitPress(choice, panel);
    const sibling = host.querySelector<HTMLInputElement>('[aria-label="名称"]')!;
    await act(() => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      sibling.focus();
    });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(sibling);
    expect(host.querySelector('[data-editor-custom]')).toBeNull();
    await act(() => {
      document.body.dispatchEvent(new Event('pointerup', { bubbles: true }));
      document.body.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    });
    expect(document.activeElement).toBe(sibling);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
  it('restores keyboard focus after pointer cancellation so first Escape closes only the picker', async () => {
    await mount();
    const choice = host.querySelector<HTMLButtonElement>('[data-add-custom="0"]')!;
    const panel = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await webkitPress(choice, panel);
    await act(() => choice.dispatchEvent(new Event('pointercancel', { bubbles: true })));
    expect(host.querySelector('[role="menu"]')?.contains(document.activeElement)).toBe(true);
    await act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-editor-add-more]'));
    expect(host.querySelector('[data-editor-custom]')).toBeNull();
  });
  it('restores keyboard ownership when an inside press is dragged out and released without click', async () => {
    await mount();
    const choice = host.querySelector<HTMLButtonElement>('[data-add-custom="0"]')!;
    const panel = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await webkitPress(choice, panel);
    await act(() => {
      document.body.dispatchEvent(new Event('pointermove', { bubbles: true }));
      document.body.dispatchEvent(new Event('pointerup', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(host.querySelector('[data-editor-custom]')).toBeNull();
    expect(host.querySelector('[role="menu"]')?.contains(document.activeElement)).toBe(true);
    await act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-editor-add-more]'));
  });
  it('adds the actual custom type after a WebKit null-target blur', async () => {
    await mount();
    const hidden = host.querySelector<HTMLButtonElement>('[data-add-custom="1"]')!;
    await webkitPress(hidden); await releaseAndClick(hidden);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="字段 1 类型"]')?.value).toBe('1');
    expect(document.activeElement).toBe(host.querySelector('[aria-label="字段 1 名称"]'));
  });
  it('waits for click instead of selecting during a cancelled pointer or touch scroll gesture', async () => {
    await mount();
    const choice = host.querySelector<HTMLButtonElement>('[data-add-custom="0"]')!;
    await webkitPress(choice);
    await act(() => {
      choice.dispatchEvent(new Event('pointermove', { bubbles: true }));
      choice.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    });
    expect(host.querySelector('[data-editor-custom]')).toBeNull();
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
  });
  it('closes when clicking an outside nonfocusable surface even if focus stays inside', async () => {
    await mount();
    const surface = document.createElement('div'); document.body.append(surface);
    try {
      await act(() => surface.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(host.querySelector('[role="menu"]')).toBeNull();
      expect(host.querySelector('[data-editor-custom]')).toBeNull();
      await act(() => {
        outside.focus();
        surface.dispatchEvent(new Event('pointerup', { bubbles: true }));
        surface.dispatchEvent(new Event('pointercancel', { bubbles: true }));
      });
      expect(document.activeElement).toBe(outside);
      expect(host.querySelector('[role="menu"]')).toBeNull();
    } finally { surface.remove(); }
  });
  it('closes on Tab focus leaving the picker without choosing a field', async () => {
    await mount();
    const sibling = host.querySelector<HTMLInputElement>('[aria-label="名称"]')!;
    await act(() => {
      // Model the browser's Tab focus transfer. jsdom has no layout or
      // native Tab traversal for FloatingPanel's visibility-based focus trap.
      sibling.focus();
    });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(host.querySelector('[data-editor-custom]')).toBeNull();
    expect(document.activeElement).toBe(sibling);
  });
  it('keeps Escape dismissal and trigger focus restoration', async () => {
    await mount();
    await act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-editor-add-more]'));
    expect(host.querySelector('[data-editor-custom]')).toBeNull();
  });
  it('lets a WebKit pointer click on the trigger toggle an already open picker closed', async () => {
    await mount();
    const trigger = host.querySelector<HTMLButtonElement>('[data-editor-add-more]')!;
    await webkitPress(trigger); await releaseAndClick(trigger);
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
