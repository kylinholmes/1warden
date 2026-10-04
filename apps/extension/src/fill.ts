/**
 * 往页面里写值。
 *
 * ## 安全模型：明文不经过 content script
 *
 * content script 只上报「页面上有哪些输入框」，**拿不到任何值**。
 * 值由 background 通过 `chrome.scripting.executeScript` 的 `args` 直接送进
 * 这个函数 —— 它是一次性的注入，不是常驻在页面里的那份额外上下文。
 *
 * ## ⚠️ 这个函数必须**完全自包含**
 *
 * `executeScript({ func })` 的实现是把它 `toString()` 之后注入页面再求值。
 * 也就是说它**闭包里引用的任何外部变量都是 undefined** —— 类型可以 import
 * （编译期就没了），值不行。所有依赖都必须在函数体内部。
 */

export interface FillEntry {
  /** 目标输入框在 `readFields` 那份列表里的下标 */
  index: number;
  value: string;
}

export interface FillOutcome {
  index: number;
  ok: boolean;
  /** 写进去之后读回来的值是否一致 —— DOM 赋值有静默失败的先例 */
  verified: boolean;
  reason?: string;
}

/**
 * 把值写进指定下标的输入框，并**读回校验**。
 *
 * 自包含 —— 不要在里面引用模块作用域的任何东西。
 */
export function fillFields(entries: FillEntry[]): FillOutcome[] {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
  );

  /**
   * React / Vue 这类框架会给 value 装上自己的 setter，直接 `el.value = x`
   * 只改了 DOM，框架的状态没变 —— 下一次重渲染就把值冲掉，用户看到的是
   * 「填了又没了」。绕法是拿原型上的原生 setter 来写，再手动派发 input 事件。
   */
  function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const out: FillOutcome[] = [];
  for (const { index, value } of entries) {
    const el = inputs[index];
    if (!el) {
      out.push({ index, ok: false, verified: false, reason: '找不到对应的输入框（页面可能变了）' });
      continue;
    }
    if (el.disabled || el.readOnly) {
      out.push({ index, ok: false, verified: false, reason: '输入框被禁用或只读' });
      continue;
    }
    try {
      el.focus();
      setNativeValue(el, value);
      // ⚠️ 必须读回：框架接管了 setter 的话，上面那次写入可能没生效
      out.push({ index, ok: true, verified: el.value === value });
    } catch (e) {
      out.push({ index, ok: false, verified: false, reason: String(e) });
    }
    el.blur();
  }
  return out;
}

/**
 * 把值放进剪贴板之前用的聚焦 —— 让用户按 ⌘V 时目标框已经就位。
 * 自包含，理由同上。
 */
export function focusField(index: number): boolean {
  const inputs = document.querySelectorAll('input, textarea');
  const el = inputs[index] as HTMLElement | undefined;
  if (!el) return false;
  el.focus();
  return true;
}

/**
 * 按下标读出输入框的当前值 —— 表单提交后用，用来捕获用户输入的凭据。
 *
 * ⚠️ 与 `fillFields` 一样必须**完全自包含**（`executeScript` 会 toString 后注入）。
 *
 * 由 background 在**收到提交通知之后**才注入，读到的值直接回到 background ——
 * content script 全程不接触这些值。这和填充走的是同一条路径，
 * 只是方向相反。
 */
export function readFieldValues(indices: number[]): (string | null)[] {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
  );
  return indices.map((i) => {
    const el = inputs[i];
    return el ? el.value : null;
  });
}
