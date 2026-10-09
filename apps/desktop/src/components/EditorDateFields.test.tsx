// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorCardExpiry, EditorDateField } from '../../../../packages/ui/src/EditorDateFields';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  host?.remove(); root = undefined; host = undefined;
});

function inputs(): HTMLInputElement[] { return [...host!.querySelectorAll('input')]; }
async function input(control: HTMLInputElement, value: string, inserted?: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(inserted === undefined ? new Event('input', { bubbles: true })
      : new InputEvent('input', { bubbles: true, inputType: 'insertText', data: inserted }));
  });
}
async function paste(control: HTMLInputElement, value: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => value } });
  await act(() => control.dispatchEvent(event));
  return event;
}
async function blurOutside(control: HTMLInputElement) {
  const outside = document.createElement('input'); document.body.append(outside);
  try { await act(() => { control.focus(); outside.focus(); }); }
  finally { outside.remove(); }
}
function container() {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
}
async function mountDate(initial: string) {
  container();
  let value = initial;
  const onChange = vi.fn((next: string) => { value = next; render(); });
  const render = () => root!.render(createElement(EditorDateField, { value, label: '签发日期', onChange }));
  await act(render);
  return { onChange, value: () => value };
}
async function mountExpiry(initialMonth: string, initialYear: string) {
  container();
  let month = initialMonth;
  let year = initialYear;
  const onChange = vi.fn((nextMonth: string, nextYear: string) => {
    month = nextMonth; year = nextYear; render();
  });
  const render = () => root!.render(createElement(EditorCardExpiry, { month, year, onChange }));
  await act(render);
  return { onChange, value: () => ({ month, year }) };
}

describe('segmented date input presentation and controlled editing', () => {
  it.each(['2026-10-09', '2026/10/09'])('assigns the complete pasted date %j from any slot', async value => {
    const control = await mountDate('2025-01-01');
    const slots = inputs();
    await act(() => slots[1]!.focus());
    expect((await paste(slots[1]!, value)).defaultPrevented).toBe(true);
    expect(control.value()).toBe('2026-10-09');
    expect(inputs().map(node => node.value)).toEqual(['2026', '10', '09']);
    expect(inputs()).toEqual(slots);
    expect(document.activeElement).toBe(slots[1]);
    expect(control.onChange).toHaveBeenCalledTimes(1);
  });
  it('accepts complete dates from one multi-character input before any native truncation', async () => {
    const control = await mountDate('');
    expect(inputs().every(node => !node.hasAttribute('maxlength'))).toBe(true);
    await input(inputs()[0]!, '2026/10/09');
    expect(control.value()).toBe('2026-10-09');
  });
  it('uses a complete insertText payload instead of mixing it with the existing slot', async () => {
    const control = await mountDate('2025-01-01');
    await input(inputs()[1]!, '012026-10-09', '2026-10-09');
    expect(control.value()).toBe('2026-10-09');
    expect(inputs().map(node => node.value)).toEqual(['2026', '10', '09']);
  });
  it('leaves a single-segment paste to native editing and retains the other date parts', async () => {
    const control = await mountDate('2025-01-01');
    expect((await paste(inputs()[1]!, '12')).defaultPrevented).toBe(false);
    await input(inputs()[1]!, '12');
    expect(control.value()).toBe('2025-12-01');
  });
  it.each(['09/10/2026', '2026/10-09', '20261009'])('does not turn ambiguous or oversized input %j into a partial date', async value => {
    const control = await mountDate('2025-01-01');
    await input(inputs()[0]!, value);
    expect(control.value()).toBe('2025-01-01');
    expect(inputs().map(node => node.value)).toEqual(['2025', '01', '01']);
    expect(control.onChange).not.toHaveBeenCalled();
  });
  it('retains invalid complete pasted dates and normalizes only valid edited dates on blur', async () => {
    const control = await mountDate('');
    await paste(inputs()[0]!, '2026/2/31');
    expect(control.value()).toBe('2026-2-31');
    expect(inputs()[0]!.getAttribute('aria-invalid')).toBe('true');
    await blurOutside(inputs()[0]!);
    expect(control.value()).toBe('2026-2-31');
    await paste(inputs()[2]!, '2026/1/9');
    expect(control.value()).toBe('2026-1-9');
    await blurOutside(inputs()[2]!);
    expect(control.value()).toBe('2026-01-09');
  });
  it('focuses the first empty slot when the shared frame is clicked without changing the value', async () => {
    const control = await mountDate('2026--');
    const frame = host!.querySelector<HTMLElement>('.segmented-date-field')!;
    await act(() => frame.click());
    expect(document.activeElement).toBe(inputs()[1]);
    expect(control.value()).toBe('2026--');
    expect(control.onChange).not.toHaveBeenCalled();
    expect(inputs().every(slot => slot.classList.contains('date-segment'))).toBe(true);
  });
  it('preserves an active slot when clicking frame padding and does not steal a direct slot click', async () => {
    const control = await mountDate('2026-1-9');
    const [year, month, day] = inputs();
    const frame = host!.querySelector<HTMLElement>('.segmented-date-field')!;
    await act(() => {
      month!.focus();
      frame.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      frame.click();
    });
    expect(document.activeElement).toBe(month);
    await act(() => { year!.focus(); year!.click(); });
    expect(document.activeElement).toBe(year);
    await blurOutside(day!);
    await act(() => frame.click());
    expect(document.activeElement).toBe(day);
    expect(control.onChange).not.toHaveBeenCalled();
  });
  it.each([
    ['', ['', '', '']], ['2026-10-09', ['2026', '10', '09']], ['2024-02-29', ['2024', '02', '29']],
    ['2026--31', ['2026', '', '31']], ['2--', ['2', '', '']],
  ] as const)('renders %j as three text slots without modifying its source', async (value, expected) => {
    const control = await mountDate(value);
    expect(inputs().map(node => node.value)).toEqual(expected);
    expect(host!.querySelector('input[type="date"],input[type="month"],select')).toBeNull();
    expect(inputs().map(node => node.getAttribute('aria-label'))).toEqual(['签发日期年份', '签发日期月份', '签发日期日期']);
    expect(control.value()).toBe(value);
    expect(control.onChange).not.toHaveBeenCalled();
  });
  it('keeps year/month/day intermediate input mounted through parent updates', async () => {
    const control = await mountDate('');
    const [year, month, day] = inputs();
    await input(year!, '2');
    expect(inputs()[0]).toBe(year);
    expect(year!.value).toBe('2');
    expect(control.value()).toBe('2--');
    await input(year!, '2026');
    await input(month!, '1');
    expect(control.value()).toBe('2026-1-');
    expect(month!.value).toBe('1');
    expect(year!.value).toBe('2026');
    await input(month!, '12');
    await input(day!, '3');
    expect(day!.value).toBe('3');
    await input(day!, '31');
    expect(control.value()).toBe('2026-12-31');
    expect(inputs()).toEqual([year, month, day]);
  });
  it('clears each slot independently without discarding the other date parts', async () => {
    const control = await mountDate('2026-12-31');
    const [year, month, day] = inputs();
    await input(month!, '');
    expect(control.value()).toBe('2026--31');
    expect(inputs().map(node => node.value)).toEqual(['2026', '', '31']);
    await input(year!, '');
    expect(inputs().map(node => node.value)).toEqual(['', '', '31']);
    await input(day!, '');
    expect(inputs().map(node => node.value)).toEqual(['', '', '']);
    expect(control.value()).toBe('');
  });
  it('pads a complete calendar date on leaving the group only after an actual edit', async () => {
    const control = await mountDate('2026-1-9');
    const [year, month, day] = inputs();
    expect(control.onChange).not.toHaveBeenCalled();
    await act(() => { year!.focus(); month!.focus(); });
    expect(control.value()).toBe('2026-1-9');
    expect(control.onChange).not.toHaveBeenCalled();
    await blurOutside(day!);
    expect(control.value()).toBe('2026-1-9');
    expect(control.onChange).not.toHaveBeenCalled();
    await input(day!, '8');
    expect(control.value()).toBe('2026-1-8');
    await blurOutside(day!);
    expect(control.value()).toBe('2026-01-08');
    expect(inputs().map(node => node.value)).toEqual(['2026', '01', '08']);
  });
  it.each(['2026-02-31', '2026-02-29', '0000-01-01', '2026-1-'])('does not correct an invalid or incomplete stored date %j', async value => {
    const control = await mountDate(value);
    expect(inputs().map(node => node.value).join('-')).toBe(value);
    expect(control.onChange).not.toHaveBeenCalled();
    await blurOutside(inputs()[0]!);
    expect(control.value()).toBe(value);
    expect(control.onChange).not.toHaveBeenCalled();
  });
  it('preserves an unparseable legacy date as a single editable string', async () => {
    const control = await mountDate('12/2030');
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]!.value).toBe('12/2030');
    expect(control.onChange).not.toHaveBeenCalled();
    await input(inputs()[0]!, '11/2031');
    expect(control.value()).toBe('11/2031');
  });
  it('keeps a legacy textbox and its focus while clearing and typing a replacement date', async () => {
    const control = await mountDate('2026/10/09');
    const textbox = inputs()[0]!;
    await act(() => textbox.focus());
    await input(textbox, '');
    expect(inputs()).toEqual([textbox]);
    expect(document.activeElement).toBe(textbox);
    for (const next of ['2', '2027', '2027-', '2027-01-', '2027-01-02']) {
      await input(textbox, next);
      expect(inputs()).toEqual([textbox]);
      expect(document.activeElement).toBe(textbox);
      expect(control.value()).toBe(next);
    }
    await blurOutside(textbox);
    expect(control.value()).toBe('2027-01-02');
    expect(inputs()).toEqual([textbox]);
  });
  it.each(['2026-10-09', '2026-02-31', '2026-1-'])('retains raw editing when a legacy date becomes %j', async value => {
    const control = await mountDate('legacy-date');
    const textbox = inputs()[0]!;
    await act(() => textbox.focus());
    await input(textbox, value);
    expect(inputs()).toEqual([textbox]);
    expect(document.activeElement).toBe(textbox);
    expect(control.value()).toBe(value);
    await blurOutside(textbox);
    expect(control.value()).toBe(value);
  });
});

describe('segmented card expiry preserves the native month/year contract', () => {
  it.each([0, 1])('assigns a complete MM/YY paste from expiry slot %i without changing focus', async index => {
    const control = await mountExpiry('02', '1930');
    const slots = inputs();
    await act(() => slots[index]!.focus());
    expect((await paste(slots[index]!, '12/30')).defaultPrevented).toBe(true);
    expect(control.value()).toEqual({ month: '12', year: '2030' });
    expect(inputs()).toEqual(slots);
    expect(document.activeElement).toBe(slots[index]);
    expect(control.onChange).toHaveBeenCalledTimes(1);
  });
  it('accepts full expiry from multi-character input and refuses oversized numeric segments', async () => {
    const control = await mountExpiry('', '');
    expect(inputs().every(node => !node.hasAttribute('maxlength'))).toBe(true);
    await input(inputs()[0]!, '12/30');
    expect(control.value()).toEqual({ month: '12', year: '2030' });
    await input(inputs()[0]!, '1230');
    await input(inputs()[1]!, '2031');
    expect(control.value()).toEqual({ month: '12', year: '2030' });
  });
  it('replaces both expiry parts from a complete insertText payload appended to an existing slot', async () => {
    const control = await mountExpiry('02', '1930');
    await input(inputs()[1]!, '193012/30', '12/30');
    expect(control.value()).toEqual({ month: '12', year: '2030' });
  });
  it('retains a non-20xx year when pasting only the month', async () => {
    const control = await mountExpiry('02', '1930');
    expect((await paste(inputs()[0]!, '12')).defaultPrevented).toBe(false);
    await input(inputs()[0]!, '12');
    expect(control.value()).toEqual({ month: '12', year: '1930' });
  });
  it('allows an explicitly pasted four-digit expiry year without guessing its century', async () => {
    const control = await mountExpiry('02', '2030');
    await paste(inputs()[1]!, '1/1931');
    expect(control.value()).toEqual({ month: '1', year: '1931' });
    await blurOutside(inputs()[1]!);
    expect(control.value()).toEqual({ month: '01', year: '1931' });
  });
  it('makes the whole expiry frame clickable, including its empty trailing area', async () => {
    const control = await mountExpiry('02', '');
    await act(() => host!.querySelector<HTMLElement>('.segmented-date-field')!.click());
    expect(document.activeElement).toBe(inputs()[1]);
    expect(control.onChange).not.toHaveBeenCalled();
  });
  it('displays a four-digit year as YY but changing only the month retains the original year', async () => {
    const control = await mountExpiry('12', '2030');
    const [month, year] = inputs();
    expect(inputs().map(node => node.value)).toEqual(['12', '30']);
    expect(inputs().map(node => node.getAttribute('aria-label'))).toEqual(['有效期月份', '有效期年份']);
    expect(host!.querySelector('input[type="date"],input[type="month"],select')).toBeNull();
    expect(control.onChange).not.toHaveBeenCalled();
    await input(month!, '11');
    expect(control.value()).toEqual({ month: '11', year: '2030' });
    expect(year!.value).toBe('30');
  });
  it('writes YY as a four-digit native year while keeping one-digit typing visible', async () => {
    const control = await mountExpiry('02', '');
    const year = inputs()[1]!;
    await input(year, '3');
    expect(control.value()).toEqual({ month: '02', year: '3' });
    expect(inputs()[1]).toBe(year);
    expect(year.value).toBe('3');
    await input(year, '30');
    expect(control.value()).toEqual({ month: '02', year: '2030' });
    expect(year.value).toBe('30');
  });
  it('clears month and year independently without normalizing the untouched source', async () => {
    const control = await mountExpiry('02', '2030');
    const [month, year] = inputs();
    await input(year!, '');
    expect(control.value()).toEqual({ month: '02', year: '' });
    expect(inputs().map(node => node.value)).toEqual(['02', '']);
    await input(month!, '');
    expect(control.value()).toEqual({ month: '', year: '' });
    expect(inputs().map(node => node.value)).toEqual(['', '']);
  });
  it.each(['1930', '123', 'legacy-year'])('keeps legacy year %j intact when editing only its month', async year => {
    const control = await mountExpiry('13', year);
    expect(inputs().map(node => node.value)).toEqual(['13', year]);
    expect(control.onChange).not.toHaveBeenCalled();
    await input(inputs()[0]!, '11');
    expect(control.value()).toEqual({ month: '11', year });
    expect(inputs()[1]!.value).toBe(year);
  });
});
