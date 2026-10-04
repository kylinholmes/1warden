/**
 * content script —— 页面里唯一常驻的那份代码。
 *
 * ## 它**看不到任何密码**
 *
 * 这里只做两件事：把页面上的输入框描述出来，以及在用户点击填充时
 * 把请求转给 background。值的注入由 background 用
 * `chrome.scripting.executeScript` 单独完成（见 fill.ts），
 * 不经过这份代码。
 *
 * 这样即使页面本身有 XSS、或者有别的扩展想读我们的内存，也拿不到明文。
 */
import { isLikelyLoginForm, type FieldDescriptor } from '@coffer/vault';

/** 与 background / popup 约定的消息形状 */
interface FieldsReport {
  type: 'coffer:fields';
  url: string;
  fields: FieldDescriptor[];
  isLoginForm: boolean;
}

/**
 * 读出页面上所有输入框的描述。
 *
 * 刻意**不读 `value`**（除了判断「是否已有内容」这个布尔用途）——
 * 页面里已有的内容可能是用户正在输的密码，没有理由把它送出去。
 */
function readFields(): FieldDescriptor[] {
  const nodes = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
  );

  return nodes.map((el) => {
    const label = labelFor(el);
    // ⚠️ 只上报「有没有内容」，不上报内容本身
    const hasValue = el.value.length > 0;
    return {
      type: (el.getAttribute('type') ?? 'text').toLowerCase(),
      name: el.getAttribute('name') ?? '',
      id: el.id ?? '',
      autocomplete: el.getAttribute('autocomplete') ?? '',
      placeholder: el.getAttribute('placeholder') ?? '',
      ariaLabel: el.getAttribute('aria-label') ?? '',
      labelText: label,
      isVisible: isVisible(el),
      isDisabled: el.disabled,
      isReadOnly: el.readOnly,
      // 空串与「有内容」在分类逻辑里是两种含义，这里只传这个布尔
      value: hasValue ? ' ' : '',
    };
  });
}

/** 关联的 `<label>` 文字 —— for= 与包裹式两种都要认 */
function labelFor(el: HTMLElement): string {
  if (el.id) {
    const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (byFor?.textContent) return byFor.textContent.trim().slice(0, 200);
  }
  const wrapping = el.closest('label');
  if (wrapping?.textContent) return wrapping.textContent.trim().slice(0, 200);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ').trim();
    if (parts) return parts.slice(0, 200);
  }
  return '';
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  // `type=hidden` 的框本来就不该被填
  return el.getAttribute('type')?.toLowerCase() !== 'hidden';
}

function report(): void {
  // 只在顶层文档上报 —— iframe 里的表单由内容脚本的 all_frames 各自处理，
  // 但 popup 只关心主框架的地址
  if (window.top !== window.self) return;

  const fields = readFields();
  const msg: FieldsReport = {
    type: 'coffer:fields',
    url: location.href,
    fields,
    isLoginForm: isLikelyLoginForm(fields),
  };
  // background 可能还没醒 —— sendMessage 会把它唤醒
  chrome.runtime.sendMessage(msg).catch(() => { /* 没有接收方是正常情况 */ });
}

/** 页面可能是 SPA，路由变化后表单会换掉 */
let lastUrl = location.href;

function maybeReport(): void {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    report();
  }
  // 表单可能是异步渲染出来的：见到密码框就立刻上报一次
  if (!reportedOnce && document.querySelector('input[type="password"]')) {
    reportedOnce = true;
    report();
  }
}

let reportedOnce = false;

report();
maybeReport();
setInterval(maybeReport, 1000);

/**
 * 表单提交检测。
 *
 * ⚠️ **这里读不到也不上报任何值** —— 只发一个「某个登录表单被提交了」的信号。
 * 真正的取值由 background 收到信号后注入一次性的读取函数完成（看 fill.ts），
 * 值从页面直达 background，不经过这份常驻代码。
 *
 * 用捕获阶段监听：很多站点在冒泡阶段就 `preventDefault()` 了，
 * 那时候再监听就晚了。
 */
function onFormSubmit(event: Event): void {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (window.top !== window.self) return;

  // 只关心含密码框的表单 —— 搜索框、订阅框提交时不该触发保存提示
  if (!form.querySelector('input[type="password"]')) return;

  chrome.runtime.sendMessage({ type: 'coffer:submitted', url: location.href })
    .catch(() => { /* 没有接收方是正常情况 */ });
}

document.addEventListener('submit', onFormSubmit, true);

/**
 * 有些站点不用 submit 事件，而是给按钮绑 click 后自己发请求。
 * 这种情况靠 Enter 键兜底 —— 覆盖面不如 submit，但聊胜于无。
 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || window.top !== window.self) return;
  const el = e.target;
  if (!(el instanceof HTMLInputElement)) return;
  if (el.type !== 'password' && el.form?.querySelector('input[type="password"]') === null) return;
  chrome.runtime.sendMessage({ type: 'coffer:submitted', url: location.href }).catch(() => {});
}, true);

/**
 * popup 点击填充时，background 需要知道「现在这份字段列表」——
 * 页面可能已经变了。这里按需重新读一遍再回。
 */
chrome.runtime.onMessage.addListener((msg: unknown, _sender, respond) => {
  if ((msg as { type?: string })?.type !== 'coffer:read-fields') return undefined;
  const fields = readFields();
  respond({ fields, isLoginForm: isLikelyLoginForm(fields) });
  return true;
});
