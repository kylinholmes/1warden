import { describe, expect, it } from 'vitest';
import css from './components.css?raw';

// Source-only guard: all shipped React targets must share the themed picker.
// Fixtures and test harnesses may intentionally render native controls.
const sources = import.meta.glob('../../*/src/**/*.{tsx,jsx}', { query: '?raw', eager: true, import: 'default' });
const appSources = import.meta.glob('../../../apps/*/{src,extension}/**/*.{tsx,jsx}', { query: '?raw', eager: true, import: 'default' });
describe('shared select adoption', () => {
  it('does not ship operating-system-native select menus in production React views', () => {
    const files = { ...sources, ...appSources };
    const production = Object.entries(files).filter(([path]) => !/\.(test|spec)\.|(?:fixture|preview)/i.test(path));
    expect(production.length).toBeGreaterThan(20);
    expect(production.filter(([, source]) => /<select\b|\bcreateElement\(\s*['"]select['"]/.test(String(source))).map(([path]) => path)).toEqual([]);
  });
  it('uses palette tokens for popup colors and visible active/selected states', () => {
    expect(css).toContain('.select-popup');
    expect(css).toContain('background: var(--surface-overlay); color: var(--ink-primary)');
    expect(css).toContain(".select-option[data-active='true']");
    expect(css).toContain(".select-option[aria-selected='true']");
    expect(css).toContain('@media (forced-colors: active)');
  });
});
