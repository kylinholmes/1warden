/**
 * 界面偏好 —— 存 localStorage，改了立刻生效。
 *
 * ## 为什么不是 React context
 *
 * 目前只有一个偏好，而它要跨两个**不挨着**的地方：侧栏（在读）和设置浮层
 * （在写）。设置浮层是浮层、侧栏在主界面里，中间的层级有好几层，
 * 为传一个布尔值把 prop 一路穿下去不划算。
 *
 * 模块级 Zustand store 管理偏好，存储只缓存允许公开的显示选项。
 */
import { createStore } from '@1warden/state';
import { useStore } from '@1warden/state/react';

const KEY_SHOW_TYPES = '1warden.pref.showTypes';

/*
 * ⚠️ 默认**开着**。这个功能的发现成本高（藏在设置里），关掉之后侧栏
 * 完全没有入口 —— 所以默认关等于没做。想关的人会自己去找。
 */
export const preferencesStore = createStore(() => {
  let showTypes = true;
  try { showTypes = localStorage.getItem(KEY_SHOW_TYPES) !== '0'; } catch { /* optional local preference */ }
  return { showTypes };
});

export function setShowTypes(v: boolean): void {
  if (preferencesStore.getState().showTypes === v) return;
  preferencesStore.setState({ showTypes: v });
  try { localStorage.setItem(KEY_SHOW_TYPES, v ? '1' : '0'); } catch { /* session-only */ }
}
export function getShowTypes(): boolean { return preferencesStore.getState().showTypes; }
export function subscribeShowTypes(fn: () => void): () => void { return preferencesStore.subscribe(fn); }

/** 读 + 订阅。返回 `[当前值, 设置函数]` */
export function useShowTypes(): [boolean, (v: boolean) => void] {
  return [useStore(preferencesStore, state => state.showTypes), setShowTypes];
}
