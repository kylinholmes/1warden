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
import { ext } from './ext-api';
import { isLikelyLoginForm, type FieldDescriptor } from '@coffer/vault';
import { installInlinePicker } from './inline-picker';

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
  ext.runtime.sendMessage(msg).catch(() => { /* 没有接收方是正常情况 */ });
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

  console.debug('[coffer] 检测到登录表单提交');
  ext.runtime.sendMessage({ type: 'coffer:submitted', url: location.href })
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
  ext.runtime.sendMessage({ type: 'coffer:submitted', url: location.href }).catch(() => {});
}, true);

// ── 注册顺序很重要 ──
//
// ⚠️ **先注册所有监听器，再干别的。**
//
// 早先的顺序是先 `report()` 再注册 onMessage —— 只要初始上报抛一次异常
// （扩展上下文还没就绪、页面状态古怪……），后面的注册就全被跳过，
// 整个 content script 变成哑的：不响应消息、不检测提交，
// 而页面上看起来一切正常，控制台也未必有声。
// 这个脆弱性是端到端测试抓出来的（表现为偶发的
// "Receiving end does not exist"）。

/**
 * popup 点击填充时，background 需要知道「现在这份字段列表」——
 * 页面可能已经变了。这里按需重新读一遍再回。
 */
ext.runtime.onMessage.addListener((msg: unknown, _sender, respond) => {
  if ((msg as { type?: string })?.type !== 'coffer:read-fields') return undefined;
  const fields = readFields();
  respond({ fields, isLoginForm: isLikelyLoginForm(fields) });
  return true;
});

/**
 * WebAuthn 转发 —— MAIN world 的拦截脚本与 background 之间的桥。
 *
 * ## 这里**刻意什么都不判断**
 *
 * 页面可以伪造这条消息里的任何字段，包括它自称的 origin。所以这份代码
 * 只是个搬运工：原样送出去，原样送回来。真正的校验在 background，
 * 它用 `sender.origin`（浏览器给的、页面改不了的）去比对 rpId。
 *
 * 在这里「顺手做一次检查」是危险的：那会给人一个已经校验过的错觉，
 * 而这里的输入全是页面可控的。
 */
/**
 * ⚠️ **必须幂等。**
 *
 * MAIN world 那边会每 250ms 重发一次，直到收到回复 —— 因为在它发第一次的时候，
 * 这份脚本可能还没注入（它跑在 `document_start`，我们跑在 `document_idle`）。
 * 重发是对的，但**接收方**得扛得住：同一条请求转发两次、执行两次，
 * 就会注册出两条凭据、或者拿同一个 challenge 签两次名。
 *
 * 所以要挡住**两种**重发，只挡一种是不够的：
 *
 *   - 已经回过的：把上次的答案再发一遍
 *   - **正在执行中的**：挂到同一次执行上，等它出结果再一起回
 *
 * ⚠️ 第二种才是真正会出事的那种。一次 create 要跑几百毫秒到几秒
 * （生成密钥 + 签名 + 写服务端），而重发是每 250ms 一次 —— 中间会挤进来
 * 好几次。它们各自独立执行，于是同一个条目被并发写了两遍、同一个 challenge
 * 被签了两次。服务端那边表现为「Cipher doesn't exist」这类莫名其妙的错，
 * 而本地完全看不出是并发造成的。
 */
const answered = new Map<number, unknown>();
const inFlight = new Map<number, Promise<Record<string, unknown>>>();

/** 只留最近几十条 —— 页面开一整天的话，这个表不该无限长下去 */
function remember(id: number, reply: unknown): void {
  answered.set(id, reply);
  if (answered.size > 64) answered.delete(answered.keys().next().value as number);
}

function send(id: number, payload: Record<string, unknown>): void {
  window.postMessage({ tag: 'coffer:webauthn-reply', id, ...payload }, window.location.origin);
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { tag?: string; id?: number } | null;

  // 探针：MAIN world 用它确认我们已经就位。**只回一个标记，不做任何事** ——
  // 它跑在 document_start，我们跑在 document_idle，它必须等我们。
  // 让重发带副作用（直接重发真正的请求）会让一次 create 执行多遍
  if (data?.tag === 'coffer:webauthn-ping') {
    window.postMessage({ tag: 'coffer:webauthn-pong' }, window.location.origin);
    return;
  }

  if (!data || data.tag !== 'coffer:webauthn' || typeof data.id !== 'number') return;
  const { id } = data;

  // 已经回过 —— 再把同一个答案发一次。页面那边可能只是没收到上一条回复
  if (answered.has(id)) {
    send(id, answered.get(id) as Record<string, unknown>);
    return;
  }

  // 正在跑 —— 挂到同一次执行上。**不能**再发一遍给 background
  const running = inFlight.get(id);
  if (running) {
    void running.then((r) => send(id, r));
    return;
  }

  /**
   * ⚠️ 只认 `event.source`，而且只回给同一个窗口。
   *
   * 这条消息的载荷是页面说了算的 —— 它也可能是**别的 frame** 发过来的。
   * 但无论来自谁，能到达的都是 window 自己，所以回给 window 是对的。
   */
  const work: Promise<Record<string, unknown>> = ext.runtime
    .sendMessage({ type: 'coffer:webauthn', payload: data })
    .then((reply: unknown) => (reply ?? { ok: false, error: '扩展没有返回结果' }) as Record<string, unknown>)
    .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : '扩展没有响应' }));

  inFlight.set(id, work);
  void work.then((r) => {
    inFlight.delete(id);
    remember(id, r);
    send(id, r);
  });
});

/**
 * 表单提交检测。
 */

// 初始上报放在所有监听器就绪**之后**，并且单独兜住异常 ——
// 上报失败只该让角标不亮，不该让整个脚本失去响应能力。
function safeReport(): void {
  try {
    report();
  } catch (e) {
    console.error('[coffer] 初始上报失败：', e);
  }
}

installInlinePicker(readFields);
safeReport();
safeReportDelayed();

/** 表单可能是异步渲染出来的，稍后再看一次 */
function safeReportDelayed(): void {
  for (const ms of [1500, 4000]) {
    setTimeout(() => { try { report(); } catch { /* 同上 */ } }, ms);
  }
}

setInterval(() => {
  try {
    maybeReport();
  } catch { /* 轮询失败不该让脚本停摆 */ }
}, 1000);
