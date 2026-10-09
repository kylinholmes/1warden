import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PALETTES, paletteTokens } from './theme-palettes';

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
  it('preserves existing mode and defaults to the original colors', async () => {
    values.set('1warden.theme', 'dark');
    const theme = await import('./theme'); theme.initTheme();
    expect(theme.getThemeMode()).toBe('dark'); expect(theme.getThemePalette()).toBe('original');
    expect(dataset.theme).toBe('dark'); expect(styles.size).toBe(0);
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
    expect(theme.getThemeMode()).toBe('system'); expect(styles.size).toBe(0);
  });
  it('survives invalid preferences and inaccessible storage', async () => {
    values.set('1warden.theme', 'bad'); values.set('1warden.palette', 'bad');
    const theme = await import('./theme'); theme.initTheme();
    expect(theme.getThemePalette()).toBe('original');
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } });
    expect(() => theme.setThemePalette('graphite')).not.toThrow();
    expect(dataset.palette).toBe('graphite');
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
