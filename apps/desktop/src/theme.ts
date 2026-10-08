/**
 * 主题 —— 跟随系统 / 亮色 / 暗色，三选一。
 *
 * ## 为什么是模块级状态，不是 React state
 *
 * 主题在**渲染之前**就必须落到 DOM 上：等 React 挂载完再设属性，
 * 窗口会先按系统主题画一帧，然后「啪」地翻过来。所以 `initTheme()`
 * 在 `createRoot` 之前调用（见 main.tsx），控件那一侧再用
 * Zustand 选择器订阅 —— store 是唯一真相，组件只是它的视图。
 *
 * ## 为什么「跟随系统」不写 `data-theme`
 *
 * 写死成解析后的 light/dark 的话，CSS 里的
 * `@media (prefers-color-scheme: dark)` 就永远挨不上边了 ——
 * 用户半夜让系统自动切暗色，界面不会跟着动，直到有人重新点一次设置。
 * 所以「跟随系统」= **不设属性**，把决定权留给媒体查询；
 * 只有显式选择才写 `data-theme`，而属性那条规则能压过媒体查询
 * （见 styles.css 里那两段暗色令牌）。
 *
 * ## 存储
 *
 * localStorage 只在**渲染层**碰。`packages/` 里有一条不许引入持久化
 * API 的硬规定（见 model.ts 的注释），主题是界面的事，本来也不该往
 * 下渗。存的是**选择**（'system'）而不是解析结果 —— 存结果的话，
 * 「跟随系统」这个选项会在下一次启动时消失。
 */

import { isPalette, paletteTokens, type ThemePalette } from './theme-palettes';
import { createStore } from '@1warden/state';
export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

const KEY = '1warden.theme';
const PALETTE_KEY = '1warden.palette';

function isMode(v: unknown): v is ThemeMode {
  return v === 'system' || v === 'light' || v === 'dark';
}

/**
 * 读取上次的选择。
 *
 * ⚠️ localStorage 在**读**的时候也会抛（隐私模式、被策略禁用、
 * 配额被清空之后的重建）。主题读不出来只是「跟随系统」，
 * 不该让整个应用起不来 —— 所以这里整个包在 try 里。
 */
function readStored(): ThemeMode {
  try {
    const raw = localStorage.getItem(KEY);
    return isMode(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

function readPalette(): ThemePalette {
  try { const raw = localStorage.getItem(PALETTE_KEY); return isPalette(raw) ? raw : 'original'; }
  catch { return 'original'; }
}
let media: MediaQueryList | undefined;
let initialized = false;
let appliedTokens: string[] = [];
const resolveMode = (mode: ThemeMode): 'light' | 'dark' => mode === 'system' ? (media?.matches ? 'dark' : 'light') : mode;
export const themeStore = createStore(() => {
  const mode = readStored(); return { mode, palette: readPalette(), resolved: resolveMode(mode) };
});

export function getThemeMode(): ThemeMode {
  return themeStore.getState().mode;
}
export function getThemePalette(): ThemePalette { return themeStore.getState().palette; }
export function getResolvedTheme(): 'light' | 'dark' {
  return themeStore.getState().resolved;
}

export function subscribeTheme(fn: () => void): () => void {
  return themeStore.subscribe(fn);
}

/** 把当前选择写到根元素上 —— 属性在 = 显式选择；不在 = 跟随系统 */
function apply(): void {
  const { mode: current, palette } = themeStore.getState();
  const root = document.documentElement;
  if (current === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = current;
  root.dataset['palette'] = palette;
  for (const key of appliedTokens) root.style.removeProperty(key);
  const tokens = paletteTokens(palette, getResolvedTheme());
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
  appliedTokens = Object.keys(tokens);
}

export function setThemePalette(value: ThemePalette): void {
  if (!isPalette(value) || getThemePalette() === value) return;
  themeStore.setState({ palette: value });
  try { localStorage.setItem(PALETTE_KEY, value); } catch { /* Session-only when storage is blocked. */ }
  apply();
}

export function setThemeMode(mode: ThemeMode): void {
  if (!isMode(mode) || mode === getThemeMode()) return;
  themeStore.setState({ mode, resolved: resolveMode(mode) });
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // 存不下就只在这个会话里生效。不提示 —— 用户要的是「现在变暗」，
    // 而这个请求已经完成了；为一件他没要求过的事弹一条报错是噪音。
  }
  apply();
}

/** 启动时调用一次。必须在首次渲染之前 —— 否则会闪一帧系统主题 */
export function initTheme(): void {
  if (!initialized) {
    initialized = true;
    if (typeof matchMedia === 'function') {
      media = matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', () => {
        if (getThemeMode() !== 'system') return;
        themeStore.setState({ resolved: resolveMode('system') }); apply();
      });
    }
    window.addEventListener('storage', (event) => {
      if (event.storageArea !== localStorage || (event.key !== null && event.key !== KEY && event.key !== PALETTE_KEY)) return;
      const mode = readStored(); themeStore.setState({ mode, palette: readPalette(), resolved: resolveMode(mode) }); apply();
    });
  }
  const resolved = resolveMode(getThemeMode());
  if (getResolvedTheme() !== resolved) themeStore.setState({ resolved });
  apply();
}
