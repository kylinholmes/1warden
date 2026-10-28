import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PALETTES, paletteTokens } from './theme-palettes';
import themeCss from '../../../packages/ui/src/theme.css?raw';
import componentsCss from '../../../packages/ui/src/components.css?raw';

function resolvedTokens(id: typeof PALETTES[number]['id'], mode: 'light' | 'dark') {
  const block = mode === 'light' ? themeCss.split(':root {')[1]!.split('}')[0]!
    : themeCss.split(":root[data-theme='dark'] {")[1]!.split('}')[0]!;
  const fallback = Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/gi)].map(m => [m[1], m[2]]));
  return { ...fallback, ...paletteTokens(id, mode) };
}

function luminance(hex: string) {
  const values = hex.slice(1).match(/../g)!.map(n => parseInt(n, 16) / 255)
    .map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
  return values[0]! * .2126 + values[1]! * .7152 + values[2]! * .0722;
}
function contrast(a: string, b: string) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + .05) / (low! + .05);
}

describe('complete light and dark palettes', () => {
  it('has unique stable identifiers and retains the original palette', () => {
    expect(new Set(PALETTES.map(p => p.id)).size).toBe(PALETTES.length);
    expect(paletteTokens('original', 'dark')).toEqual({});
  });
  for (const palette of PALETTES) for (const mode of ['light', 'dark'] as const) {
    it(`${palette.id} ${mode}: necessary controls and focus contrast with adjacent surfaces`, () => {
      const tokens = resolvedTokens(palette.id, mode);
      for (const surface of ['canvas', 'chrome', 'content', 'paper', 'overlay', 'well', 'hover']) {
        expect(contrast(tokens['--border-control']!, tokens[`--surface-${surface}`]!), `${surface} control`).toBeGreaterThanOrEqual(3);
        expect(contrast(tokens['--accent-ring']!, tokens[`--surface-${surface}`]!), `${surface} focus`).toBeGreaterThanOrEqual(3);
      }
    });
  }
  for (const mode of ['light', 'dark'] as const) {
    it(`蓝色大肥鱼 ${mode}: controls, focus and actions stay legible on blue selection`, () => {
      const tokens = paletteTokens('whale', mode);
      expect(contrast(tokens['--border-control']!, tokens['--surface-selected']!)).toBeGreaterThanOrEqual(3);
      expect(contrast(tokens['--accent-ring']!, tokens['--surface-selected']!)).toBeGreaterThanOrEqual(3);
      expect(contrast(tokens['--accent']!, tokens['--surface-selected']!)).toBeGreaterThanOrEqual(4.5);
    });
  }
  it('keeps navigation text, category icons, controls and focus legible across its black zone', () => {
    const block = componentsCss.split(":root[data-palette='whale'] .nav-drawer-panel {")[1]!.split('}')[0]!;
    const tokens = Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/gi)].map(m => [m[1], m[2]]));
    for (const surface of ['canvas', 'chrome', 'content', 'paper', 'overlay', 'well', 'hover', 'selected']) {
      for (const ink of ['primary', 'secondary', 'tertiary']) {
        expect(contrast(tokens[`--ink-${ink}`]!, tokens[`--surface-${surface}`]!), `${surface} ${ink}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const role of ['accent', 'accent-ring', 'violet', 'teal', 'rose', 'favorite', 'border-control']) {
        expect(contrast(tokens[`--${role}`]!, tokens[`--surface-${surface}`]!), `${surface} ${role}`).toBeGreaterThanOrEqual(3);
      }
      for (const role of ['safe', 'caution', 'risk']) {
        expect(contrast(tokens[`--${role}`]!, tokens[`--surface-${surface}`]!), `${surface} ${role}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(tokens['--accent-ink']!, tokens['--accent']!)).toBeGreaterThanOrEqual(4.5);
  });
  for (const palette of PALETTES.filter(p => p.id !== 'original')) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${palette.id} ${mode}: readable text and action labels`, () => {
        const tokens = paletteTokens(palette.id, mode);
        for (const surface of ['chrome', 'content', 'paper', 'overlay', 'hover', 'selected', 'well']) {
          for (const ink of ['primary', 'secondary', 'tertiary']) {
            expect(contrast(tokens[`--ink-${ink}`]!, tokens[`--surface-${surface}`]!)).toBeGreaterThanOrEqual(4.5);
          }
        }
        expect(contrast(tokens['--accent']!, tokens['--surface-paper']!)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens['--accent-ink']!, tokens['--accent']!)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe('appearance persistence and system mode', () => {
  let values: Map<string, string>;
  let dataset: Record<string, string>;
  let styles: Map<string, string>;
  let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn> };
  let events: Map<string, (event: any) => void>;
  beforeEach(() => {
    vi.resetModules(); values = new Map(); dataset = {}; styles = new Map(); events = new Map();
    media = { matches: false, addEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', () => media);
    vi.stubGlobal('window', { addEventListener: (name: string, fn: (e: any) => void) => events.set(name, fn) });
    vi.stubGlobal('document', { documentElement: { dataset, style: {
      setProperty: (k: string, v: string) => styles.set(k, v), removeProperty: (k: string) => styles.delete(k),
    } } });
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each(['system', 'light', 'dark'] as const)('defaults to clear-blue while preserving %s mode', async mode => {
    if (mode !== 'system') values.set('1warden.theme', mode);
    const theme = await import('./theme'); theme.initTheme();
    expect(theme.getThemeMode()).toBe(mode); expect(theme.getThemePalette()).toBe('clear-blue');
    expect(dataset.theme).toBe(mode === 'system' ? undefined : mode);
    expect(styles.get('--surface-chrome')).toBe(paletteTokens('clear-blue', mode === 'dark' ? 'dark' : 'light')['--surface-chrome']);
  });
  it.each(['original', 'jade', 'clear-blue', 'whale', 'brass'] as const)('restores and persists %s independently of the selected mode', async palette => {
    values.set('1warden.palette', palette); values.set('1warden.theme', 'dark');
    const theme = await import('./theme'); theme.initTheme();
    expect(theme.getThemePalette()).toBe(palette);
    expect(styles.get('--surface-chrome')).toBe(paletteTokens(palette, 'dark')['--surface-chrome']);
    theme.setThemePalette('dracula'); theme.setThemePalette(palette); theme.setThemeMode('light');
    expect(values.get('1warden.palette')).toBe(palette);
    expect(values.get('1warden.theme')).toBe('light');
    expect(styles.get('--surface-paper')).toBe(paletteTokens(palette, 'light')['--surface-paper']);
  });
  it('persists palettes independently, resets all overrides and notifies subscribers', async () => {
    const theme = await import('./theme'); theme.initTheme();
    const notify = vi.fn(); const dispose = theme.subscribeTheme(notify);
    theme.setThemePalette('dracula'); theme.setThemeMode('dark');
    expect(values.get('1warden.palette')).toBe('dracula');
    expect(styles.get('--surface-paper')).toBe(paletteTokens('dracula', 'dark')['--surface-paper']);
    theme.setThemePalette('original'); expect(styles.size).toBe(0);
    expect(theme.getThemeMode()).toBe('dark'); expect(notify).toHaveBeenCalledTimes(3); dispose();
  });
  it('follows live system changes only in system mode and initializes listeners once', async () => {
    values.set('1warden.palette', 'github');
    const theme = await import('./theme'); theme.initTheme(); theme.initTheme();
    expect(media.addEventListener).toHaveBeenCalledTimes(1);
    media.matches = true; media.addEventListener.mock.calls[0]![1]();
    expect(dataset.theme).toBeUndefined(); expect(styles.get('--surface-paper')).toBe(paletteTokens('github', 'dark')['--surface-paper']);
    theme.setThemeMode('light'); media.addEventListener.mock.calls[0]![1]();
    expect(styles.get('--surface-paper')).toBe(paletteTokens('github', 'light')['--surface-paper']);
  });
  it('synchronizes other windows without echo writes', async () => {
    const theme = await import('./theme'); theme.initTheme();
    values.set('1warden.theme', 'dark'); values.set('1warden.palette', 'everforest');
    events.get('storage')!({ key: '1warden.palette', storageArea: localStorage });
    expect(theme.getThemeMode()).toBe('dark'); expect(theme.getThemePalette()).toBe('everforest');
    values.clear(); events.get('storage')!({ key: null, storageArea: localStorage });
    expect(theme.getThemeMode()).toBe('system'); expect(theme.getThemePalette()).toBe('clear-blue');
    expect(styles.get('--surface-paper')).toBe(paletteTokens('clear-blue', 'light')['--surface-paper']);
  });
  it('survives invalid preferences and inaccessible storage', async () => {
    values.set('1warden.theme', 'bad'); values.set('1warden.palette', 'bad');
    const theme = await import('./theme'); theme.initTheme();
    expect(theme.getThemePalette()).toBe('clear-blue');
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } });
    expect(() => theme.setThemePalette('graphite')).not.toThrow();
    expect(dataset.palette).toBe('graphite');
  });
  it('initializes clear-blue and system mode when storage is inaccessible', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } });
    media.matches = true;
    const theme = await import('./theme'); theme.initTheme();
    expect(theme.getThemePalette()).toBe('clear-blue'); expect(theme.getThemeMode()).toBe('system');
    expect(styles.get('--surface-chrome')).toBe(paletteTokens('clear-blue', 'dark')['--surface-chrome']);
  });
  it('defaults to original icon artwork and syncs icon style between windows without echoing writes', async () => {
    const theme = await import('./theme'); theme.initTheme();
    expect(theme.getIconStyle()).toBe('original'); expect(dataset.iconStyle).toBe('original');
    theme.setIconStyle('plate');
    expect(values.get('1warden.iconStyle')).toBe('plate'); expect(dataset.iconStyle).toBe('plate');
    values.set('1warden.iconStyle', 'original');
    events.get('storage')!({ key: '1warden.iconStyle', storageArea: localStorage });
    expect(theme.getIconStyle()).toBe('original');
    values.set('1warden.iconStyle', 'future');
    events.get('storage')!({ key: '1warden.iconStyle', storageArea: localStorage });
    expect(theme.getIconStyle()).toBe('original'); expect(values.get('1warden.iconStyle')).toBe('future');
  });
});
