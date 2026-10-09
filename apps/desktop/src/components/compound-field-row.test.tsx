// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CompoundFieldRow } from '../../../../packages/ui/src/CompoundFieldRow';

const cell = (key: string) => createElement('div', { key, 'data-test-cell': key }, key);
function render(children: Parameters<typeof CompoundFieldRow>[0]['children']) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(createElement(CompoundFieldRow, { label: '姓名', fieldId: 'identity.name', children }));
  return host;
}

describe('compound groups use all-or-nothing responsive columns', () => {
  it.each([
    [1, []], [2, ['@[240px]:grid-cols-2']], [3, ['@[360px]:grid-cols-3']],
  ] as const)('uses only the populated %i-column breakpoint and no 2+1 intermediate layout', (count, breakpoints) => {
    const host = render(Array.from({ length: count }, (_, index) => cell(String(index))));
    const outer = host.querySelector<HTMLElement>('[data-compound-field]')!;
    const grid = outer.querySelector<HTMLElement>(':scope > [data-compound-cells]')!;
    expect(grid).not.toBeNull();
    expect(grid.children).toHaveLength(count);
    expect(grid.classList.contains('grid-cols-1')).toBe(true);
    expect([...grid.classList].filter(token => token.includes(':grid-cols-'))).toEqual(breakpoints);
    expect(outer.classList.contains('@container')).toBe(true);
    expect(outer.classList.contains('border-b')).toBe(true);
    expect(grid.style.gridTemplateColumns).toBe('');
    expect(grid.classList.contains('py-3')).toBe(false);
    expect(grid.classList.contains('border-b')).toBe(false);
    expect(host.innerHTML).not.toContain('auto-fit');
  });
  it('counts only surviving children, so missing detail fields do not reserve columns', () => {
    const grid = render([null, false, cell('given'), undefined]).querySelector<HTMLElement>('[data-compound-cells]')!;
    expect(grid.children).toHaveLength(1);
    expect([...grid.classList].some(token => token.includes(':grid-cols-'))).toBe(false);
    expect(grid.firstElementChild?.getAttribute('data-test-cell')).toBe('given');
  });
  it('does not leave a divider or group when no detail children survive', () => {
    expect(render([null, false, undefined]).innerHTML).toBe('');
  });
});
