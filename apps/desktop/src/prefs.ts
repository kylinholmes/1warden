/**
 * 界面偏好 —— 存 localStorage，改了立刻生效。
 *
 * ## 为什么不是 React context
 *
 * 目前只有一个偏好，而它要跨两个**不挨着**的地方：侧栏（在读）和设置浮层
 * （在写）。设置浮层是浮层、侧栏在主界面里，中间的层级有好几层，
 * 为传一个布尔值把 prop 一路穿下去不划算。
 *
 * 模块级 + 订阅是这里最小的做法。**偏好多了之后要换成别的东西** ——
 * 每个偏好各写一遍订阅就变成一堆样板了。
 */
import { useEffect, useState } from 'react';

const KEY_SHOW_TYPES = 'coffer.pref.showTypes';

/*
 * ⚠️ 默认**开着**。这个功能的发现成本高（藏在设置里），关掉之后侧栏
 * 完全没有入口 —— 所以默认关等于没做。想关的人会自己去找。
 */
let showTypes = localStorage.getItem(KEY_SHOW_TYPES) !== '0';
const listeners = new Set<() => void>();

function setShowTypes(v: boolean): void {
  showTypes = v;
  localStorage.setItem(KEY_SHOW_TYPES, v ? '1' : '0');
  for (const f of listeners) f();
}

/** 读 + 订阅。返回 `[当前值, 设置函数]` */
export function useShowTypes(): [boolean, (v: boolean) => void] {
  const [, force] = useState(0);
  useEffect(() => {
    const f = (): void => force((n) => n + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  return [showTypes, setShowTypes];
}
