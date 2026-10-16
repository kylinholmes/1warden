/**
 * content script —— 页面里唯一常驻的那份代码。
 *
 * 字段元数据供账号选择器使用；凭据观察器在 ISOLATED world 中，仅在用户
 * 编辑完成或提交表单时，短暂读取当前表单并交给 background。登录密码和 TOTP
 * 种子不进入提示 UI；验证码候选仅显示后台生成的短期验证码。
 */
import { ext } from './ext-api';
import { isLikelyLoginForm, type FieldDescriptor } from '@1warden/vault';
import { installInlinePicker } from './inline-picker';
import { readPageFields as readFields } from './inline-fields';
import { installCredentialObserver } from './credential-observer';
import { installInlineCredentials } from './inline-credentials';

// Install capture listeners before page scripts can register clearing handlers.
const credentialObserver = installCredentialObserver();
const credentialUI = installInlineCredentials(credentialObserver);

/** 与 background / popup 约定的消息形状 */
interface FieldsReport {
  type: '1warden:fields';
  url: string;
  fields: FieldDescriptor[];
  isLoginForm: boolean;
}

function report(): void {
  // 只在顶层文档上报 —— iframe 里的表单由内容脚本的 all_frames 各自处理，
  // 但 popup 只关心主框架的地址
  if (window.top !== window.self) return;

  const fields = readFields();
  const msg: FieldsReport = {
    type: '1warden:fields',
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
  credentialObserver.navigation();
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
  if ((msg as { type?: string })?.type !== '1warden:read-fields') return undefined;
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
 * 两个 world 的脚本虽然都在 document_start 注入，执行先后仍可能不同。
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
  window.postMessage({ tag: '1warden:webauthn-reply', id, ...payload }, window.location.origin);
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { tag?: string; id?: number } | null;

  // 探针：MAIN world 用它确认我们已经就位。**只回一个标记，不做任何事** ——
  // 两个 world 的注入顺序不固定，它必须等我们。
  // 让重发带副作用（直接重发真正的请求）会让一次 create 执行多遍
  if (data?.tag === '1warden:webauthn-ping') {
    window.postMessage({ tag: '1warden:webauthn-pong' }, window.location.origin);
    return;
  }

  if (!data || data.tag !== '1warden:webauthn' || typeof data.id !== 'number') return;
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
    .sendMessage({ type: '1warden:webauthn', payload: data })
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
    console.error('[onewarden] 初始上报失败：', e);
  }
}

installInlinePicker(readFields, {
  nonce: credentialObserver.nonce,
  suppress: field => credentialUI.prefersGenerator(field),
  canGenerate: field => !!credentialObserver.forms.group(field)?.password,
  openGenerator: field => { void credentialUI.openGenerator(field); },
  onOpen: () => credentialUI.closeGenerator(),
});
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
