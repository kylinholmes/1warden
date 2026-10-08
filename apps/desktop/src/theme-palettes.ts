/** Presentation only. Names describe familiar palette families, not imported editor themes. */
type Colors = readonly [canvas: string, chrome: string, content: string, paper: string, ink: string, accent: string, accentInk: string];
interface Palette { id: string; name: string; light: Colors; dark: Colors }
export const PALETTES = [
  { id: 'original', name: '1Warden',
    light: ['#edf2fb', '#ecf2ff', '#f7f9fd', '#ffffff', '#202b3c', '#0667e8', '#ffffff'],
    dark: ['#101722', '#162234', '#1b2738', '#213045', '#f1f6ff', '#8ac0ff', '#112947'] },
  { id: 'graphite', name: '石墨',
    light: ['#eeeeee', '#f4f4f4', '#fafafa', '#ffffff', '#202020', '#343434', '#ffffff'],
    dark: ['#121212', '#181818', '#1e1e1e', '#242424', '#ededed', '#ededed', '#202020'] },
  { id: 'ayu', name: 'Ayu',
    light: ['#f1eee7', '#f6f3ec', '#faf8f3', '#fffdf8', '#363a40', '#986000', '#ffffff'],
    dark: ['#0b0e14', '#10141c', '#151b24', '#1b222d', '#e6e1cf', '#e6b450', '#211b0e'] },
  { id: 'catppuccin', name: 'Catppuccin',
    light: ['#e6e6ef', '#ededf5', '#f4f3fa', '#faf9ff', '#343347', '#7545b8', '#ffffff'],
    dark: ['#181825', '#1e1e2e', '#262638', '#2e2e42', '#e2e3f3', '#cba6f7', '#271d38'] },
  { id: 'dracula', name: 'Dracula',
    light: ['#eae7f0', '#f1edf6', '#f7f4fb', '#fffbff', '#302936', '#843e9e', '#ffffff'],
    dark: ['#1e1f29', '#252632', '#2b2c3a', '#323342', '#f8f8f2', '#ff92df', '#361b30'] },
  { id: 'everforest', name: 'Everforest',
    light: ['#e9eddf', '#f0f2e8', '#f6f7ee', '#fcfcf4', '#303b32', '#466b35', '#ffffff'],
    dark: ['#202824', '#27312b', '#2e3831', '#354037', '#e5ebda', '#b2cf9d', '#202f1b'] },
  { id: 'github', name: 'GitHub',
    light: ['#eaeef2', '#f0f3f6', '#f6f8fa', '#ffffff', '#1f2328', '#0969da', '#ffffff'],
    dark: ['#0d1117', '#111820', '#161e28', '#1d2733', '#e6edf3', '#79b8ff', '#10263f'] },
  { id: 'gruvbox', name: 'Gruvbox',
    light: ['#eee5cd', '#f4ecd7', '#faf3e2', '#fffaeb', '#3c342a', '#965716', '#ffffff'],
    dark: ['#22201d', '#292622', '#302c27', '#38332d', '#f0e5cb', '#e8ba70', '#302314'] },
  { id: 'linear', name: 'Linear',
    light: ['#eaeaef', '#f1f1f6', '#f8f8fc', '#ffffff', '#292935', '#5752c6', '#ffffff'],
    dark: ['#111116', '#181820', '#20202a', '#282834', '#ededf5', '#aaa4ff', '#232040'] },
] as const satisfies readonly Palette[];

export type ThemePalette = typeof PALETTES[number]['id'];
export const isPalette = (value: unknown): value is ThemePalette => PALETTES.some(p => p.id === value);
export function getPalette(id: ThemePalette) { return PALETTES.find(p => p.id === id)!; }

/** Hex mixing keeps previews, WebViews and contrast tests on the same exact colors. */
function mix(a: string, b: string, amount: number): string {
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * amount
    + parseInt(b.slice(i, i + 2), 16) * (1 - amount)).toString(16).padStart(2, '0')).join('');
}

export function paletteTokens(id: ThemePalette, mode: 'light' | 'dark'): Record<string, string> {
  // Keep the existing CSS as the original theme's source of truth (and no-JS fallback).
  if (id === 'original') return {};
  const [canvas, chrome, content, paper, ink, accent, accentInk] = getPalette(id)[mode];
  const subtle = mix(ink, paper, .16);
  return {
    '--surface-canvas': canvas, '--surface-chrome': chrome, '--surface-content': content,
    '--surface-paper': paper, '--surface-well': chrome, '--surface-overlay': paper,
    '--surface-hover': mix(ink, paper, .06), '--surface-selected': mix(accent, paper, .12),
    '--surface-brand': mix(accent, paper, .08), '--surface-card': paper,
    '--ink-primary': ink, '--ink-secondary': mix(ink, paper, .86), '--ink-tertiary': mix(ink, paper, .78),
    '--ink-inverse': accentInk, '--border-subtle': subtle, '--border-overlay': mix(ink, paper, .24),
    '--border-strong': mix(ink, paper, .4), '--accent': accent,
    '--accent-hover': mix(accent, mode === 'dark' ? '#ffffff' : '#000000', .88),
    '--accent-tint': mix(accent, paper, .1), '--accent-ring': accent, '--accent-ink': accentInk,
  };
}
