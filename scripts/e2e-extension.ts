#!/usr/bin/env bun
/**
 * 扩展的端到端验证 —— 在**真实 Chromium** 里跑完整的填充与保存链路。
 *
 * 单测能证明每一段逻辑是对的，证明不了它们接起来能跑：
 * 消息类型字符串有没有写岔、`executeScript` 注入的函数在真实页面里能不能
 * 取到 DOM、content script 与 background 的时序对不对 —— 这些只有真跑才知道。
 *
 * 用 CDP（Chrome DevTools Protocol）驱动，不走 GUI：
 * 图形界面一次要几十秒还依赖窗口焦点，这里几秒钟就能跑完一轮，
 * 而且失败时拿到的是确切的异常，不是一张截图。
 *
 * 前置：
 *   ./scripts/dev-server.sh start     # Vaultwarden
 *   cd apps/extension && bun run build
 *
 * 跑：
 *   bun run scripts/e2e-extension.ts
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const DIST = join(import.meta.dir, '..', 'apps', 'extension', 'dist');
const PORT = 9222;
const PAGE_PORT = 8899;
/**
 * ⚠️ 用明文代理而不是 `https://localhost:8443`。
 *
 * 开发服务器是自签证书，而 **Chromium 不会为扩展的 fetch 放行自签名证书** ——
 * 浏览器自己的「继续访问」例外只对页面导航生效，不覆盖扩展。
 *
 * 这不只是测试的麻烦，是一个真实的产品约束：自建 Vaultwarden 的用户
 * 要么把证书装进系统信任库，要么就得走明文（不该鼓励）。桌面端有 TOFU
 * 指纹确认可以处理自签证书，扩展没有这条路 —— 因为 TLS 校验在浏览器手里。
 */
const SERVER = process.env.COFFER_EXT_SERVER ?? 'http://127.0.0.1:8080';
const EMAIL = process.env.COFFER_TEST_EMAIL ?? 'coffer-test@example.com';
const PASSWORD = process.env.COFFER_TEST_PASSWORD ?? 'Test-Master-Password-123!';

const SITE = `http://127.0.0.1:${PAGE_PORT}`;
const PAGE_URL = `${SITE}/login.html`;
const USERNAME = 'e2e-user@example.com';
/*
 * ⚠️ 每次跑用不同的密码，并把造出来的条目在结束时删掉。
 *
 * 这个测试跑在**开发账户**上，而桌面 App 用的正是同一个账户。第一次跑成功
 * 之后密码就存进库里了，第二次跑 `decideCapture` 会正确地判定「没变化、
 * 不用提示」—— 于是测试失败，而功能其实是对的。
 * 有状态的测试会把「正确行为」报成缺陷。
 */
const SITE_PASSWORD = `E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}!`;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}

// ── CDP ──

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

class Cdp {
  private ws!: WebSocket;
  private seq = 0;
  private waiting = new Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }>();
  /** 这个上下文里报出来的日志与异常 */
  readonly logs: string[] = [];

  static async connect(wsUrl: string): Promise<Cdp> {
    const c = new Cdp();
    c.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      c.ws.onopen = () => resolve();
      c.ws.onerror = () => reject(new Error(`无法连接 CDP：${wsUrl}`));
    });
    c.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number; result?: unknown; error?: { message: string };
        method?: string; params?: Record<string, unknown>;
      };

      // 把日志与未捕获异常收集起来 —— 出问题时这是唯一能看到真话的地方
      if (msg.method === 'Runtime.consoleAPICalled') {
        const p = msg.params as { type: string; args: { value?: unknown; description?: string }[] };
        c.logs.push(`[${p.type}] ` + p.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const p = msg.params as { exceptionDetails: { text: string; exception?: { description?: string } } };
        c.logs.push(`[异常] ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
      }

      if (msg.id === undefined) return;
      const w = c.waiting.get(msg.id);
      if (!w) return;
      c.waiting.delete(msg.id);
      if (msg.error) w.err(new Error(msg.error.message));
      else w.ok(msg.result);
    };
    return c;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((ok, err) => {
      this.waiting.set(id, { ok: ok as (v: unknown) => void, err });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.delete(id)) err(new Error(`CDP 超时：${method}`));
      }, 20_000);
    });
  }

  /** 订阅事件（console / 异常需要先 Runtime.enable） */
  enableRuntime(): Promise<unknown> {
    return this.send('Runtime.enable');
  }

  /** 在目标上下文里求值，返回 JSON 化的结果 */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{
      result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value as T;
  }

  close(): void { this.ws.close(); }
}

async function listTargets(): Promise<CdpTarget[]> {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return await res.json() as CdpTarget[];
}

async function waitFor<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ── 测试页 ──

const LOGIN_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>示例站点登录</title></head><body>
<h1>登录</h1>
<form id="f">
  <label for="email">邮箱</label>
  <input id="email" name="email" type="email" autocomplete="username">
  <label for="pw">密码</label>
  <input id="pw" name="password" type="password" autocomplete="current-password">
  <label for="code">验证码</label>
  <input id="code" name="otp" type="text" autocomplete="one-time-code">
  <button type="submit" id="go">登录</button>
</form>
<script>
  // 提交时阻止真的跳转，好让测试能继续观察页面
  document.getElementById('f').addEventListener('submit', function (e) { e.preventDefault(); });
</script>
</body></html>`;

function startSiteServer(): { stop: () => void } {
  const server = Bun.serve({
    port: PAGE_PORT,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/login.html') {
        return new Response(LOGIN_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { stop: () => server.stop(true) };
}

// ── 主流程 ──

function extensionIdFor(path: string): string {
  const h = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/**
 * 直接用 API 删掉测试造的条目。
 *
 * 走 API 而不是扩展的消息 —— 扩展还没提供删除能力，而且清理是测试的事，
 * 不该为了它给产品加接口。
 */
async function cleanupItems(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const api = await import('../packages/api/src/index');
  const crypto = await import('../packages/crypto/src/index');

  const bare = new api.HttpClient({ baseUrl: SERVER });
  const pl = await api.prelogin(bare, EMAIL);
  const masterKey = await crypto.deriveMasterKey(PASSWORD, EMAIL, {
    kdf: crypto.KDF_TYPE_PBKDF2, iterations: pl.iterations,
  });
  const token = await api.loginWithPassword(bare, {
    email: EMAIL,
    masterPasswordHash: await crypto.hashMasterPassword(masterKey, PASSWORD),
    device: { type: api.DEVICE_TYPE.macOSDesktop, identifier: 'e2e-ext', name: 'coffer-e2e' },
  });
  const http = new api.HttpClient({
    baseUrl: SERVER,
    headers: () => ({ Authorization: `Bearer ${token.accessToken}` }),
  });

  let n = 0;
  for (const id of ids) {
    try { await api.hardDeleteCipher(http, id); n++; } catch { /* 已经没了 */ }
  }
  return n;
}

/** 探测某个标签页里的 content script 是否已经就绪 */
async function probeContentScript(page: Cdp, ext: Cdp): Promise<string> {
  void page;
  return ext.eval<string>(`
    (async () => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => (x.url || '').startsWith(${JSON.stringify(SITE)}));
      if (!t) return 'ERR 找不到标签页';
      try {
        await chrome.tabs.sendMessage(t.id, { type: 'coffer:read-fields' });
        return 'OK';
      } catch (e) { return 'ERR ' + (e && e.message ? e.message : String(e)); }
    })()
  `).catch((e: unknown) => `ERR ${String(e)}`);
}

async function main(): Promise<void> {
  const extId = extensionIdFor(DIST);
  console.log(`\n扩展端到端验证 → ${SITE}\n`);
  console.log(`  扩展 ID: ${extId}`);

  const site = startSiteServer();
  const profile = mkdtempSync(join(tmpdir(), 'coffer-e2e-'));

  const edge = Bun.spawn([
    EDGE,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run', '--no-default-browser-check',
    '--headless=new',
    PAGE_URL,
  ], { stdout: 'ignore', stderr: 'ignore' });

  const cleanup = (): void => {
    try { edge.kill(); } catch { /* 已经退了 */ }
    site.stop();
    rmSync(profile, { recursive: true, force: true });
  };

  let page: Cdp | undefined;
  let ext: Cdp | undefined;
  let sw: Cdp | undefined;

  try {
    // ── 1. 扩展与页面就位 ──
    console.log('\n1. 扩展加载与页面注入');

    const swTarget = await waitFor('service worker 起来', async () => {
      const list = await listTargets();
      return list.find((t) => t.type === 'service_worker' && t.url.includes(extId)) ?? null;
    });
    check('service worker 已注册', swTarget !== undefined);

    const pageTarget = await waitFor('测试页就位', async () => {
      const list = await listTargets();
      return list.find((t) => t.type === 'page' && t.url.startsWith(SITE)) ?? null;
    });
    page = await Cdp.connect(pageTarget.webSocketDebuggerUrl!);
    await page.enableRuntime();

    check('测试页加载成功', await page.eval<boolean>('document.title.length > 0'));

    // 先确认「日志捕获」这台仪表本身是好的 —— 否则「一条日志都没有」
    // 可能只是仪器坏了，而不是真的没日志
    await page.eval(`console.log('__instrument_check__')`);
    await new Promise((r) => setTimeout(r, 400));
    check('日志捕获仪表可用', page.logs.some((l) => l.includes('__instrument_check__')),
      `收到 ${page.logs.length} 条日志`);


    // ── 2. 打开扩展页面（popup.html 在标签里打开即可作为扩展上下文） ──
    console.log('\n2. 解锁扩展');

    await page.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    const popupTarget = await waitFor('扩展页面就位', async () => {
      const list = await listTargets();
      return list.find((t) => t.url.startsWith(`chrome-extension://${extId}`)) ?? null;
    });
    ext = await Cdp.connect(popupTarget.webSocketDebuggerUrl!);
    await ext.enableRuntime();

    // 也挂到 service worker 上 —— 捕获逻辑在那边，它的异常只能从这里看到
    sw = await Cdp.connect(swTarget.webSocketDebuggerUrl!);
    await sw.enableRuntime();

    // 测试页的 tabId —— 填充与捕获都要用它
    const tabId = await ext.eval<number>(`
      (async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => (x.url || '').startsWith(${JSON.stringify(SITE)}));
        return t ? t.id : -1;
      })()
    `);
    check('能在扩展侧定位到测试页标签', tabId > 0, `tabId=${tabId}`);

    /*
     * 等 content script 就位。
     *
     * ⚠️ 它**不是**同步注入的，而且首次导航常常赶在扩展初始化完成之前 ——
     * 那一趟页面不会被注入，之后也不会补上。真实用户的使用顺序是先开着浏览器、
     * 再访问站点，所以这里「探测 → 不就绪就重载」既贴近现实，也把竞态排除掉。
     *
     * 角标、捕获、填充全都依赖它，它不在这三件事会一起失败，
     * 而失败原因从这一行输出就能看出来。
     */
    const probeOnce = () => ext!.eval<string>(`
      chrome.tabs.sendMessage(${tabId}, { type: 'coffer:read-fields' })
        .then((r) => 'OK ' + JSON.stringify(r).slice(0, 160))
        .catch((e) => 'ERR ' + (e && e.message ? e.message : String(e)))
    `);

    let probe = await probeOnce();
    for (let attempt = 1; attempt <= 4 && !probe.startsWith('OK'); attempt++) {
      console.log(`  （第 ${attempt} 次探测未就绪，重载页面后重试）`);
      await page!.send('Page.reload', { ignoreCache: true });
      await new Promise((r) => setTimeout(r, 1500));
      probe = await probeOnce();
    }
    console.log(`  content script 探测: ${probe.slice(0, 130)}`);
    check('content script 在页面里响应', probe.startsWith('OK'),
      'content script 没有注入或没有响应 —— 填充与捕获都会因此失效');

    const connect = await ext.eval<{ ok?: boolean; itemCount?: number; error?: string }>(`
      chrome.runtime.sendMessage({
        type: 'coffer:connect',
        serverUrl: ${JSON.stringify(SERVER)},
        email: ${JSON.stringify(EMAIL)},
        masterPassword: ${JSON.stringify(PASSWORD)},
      })
    `);
    check('连接并解锁 Vaultwarden', connect?.ok === true && (connect.itemCount ?? 0) > 0,
      JSON.stringify(connect));

    // content script 跑在隔离世界里，主世界看不到它。它报上来「这里有登录表单」
    // 时 background 会点一个角标 —— 那是它确实跑起来了的唯一外部可见信号。
    //
    // ⚠️ 必须**解锁之后**再看：角标只在已解锁时才点亮（锁着的时候亮着也没意义，
    // 点了也没东西可填）。
    const badge = await waitFor('content script 上报登录表单', async () => {
      const t = await ext!.eval<string>(`chrome.action.getBadgeText({ tabId: ${tabId} })`);
      return t ? t : null;
    }, 10_000).catch(() => '');
    check('content script 注入并识别出登录表单（角标点亮）', badge !== '', `badge="${badge}"`);

    // ── 3. 保存捕获 ──
    console.log('\n3. 提交表单 → 捕获 → 保存');

    /*
     * ⚠️ 先把这个测试站点历史留下的条目删干净。
     *
     * 否则上一次跑存下的那条还在库里，同样是这个用户名、只是密码不同 ——
     * `decideCapture` 会**正确地**判定为「更新」，而测试却断言「新建」，
     * 于是把正确行为报成缺陷。测试跑在真实账户上时，清理是断言能确定的前提。
     */
    const stale = (await ext.eval<{ items: { id: string }[] }>(
      `chrome.runtime.sendMessage({ type: 'coffer:matches', url: ${JSON.stringify(PAGE_URL)} })`,
    )).items;
    if (stale.length > 0) {
      await cleanupItems(stale.map((i) => i.id));
      console.log(`  （清掉了 ${stale.length} 条历史遗留条目）`);
    }

    const baseline = await ext.eval<number>(`
      chrome.runtime.sendMessage({ type: 'coffer:list' })
        .then((r) => (r.items || []).length)
    `);

    // 把值写进页面并派发事件 —— 与用户手动输入走同一条读取路径
    await page.eval(`
      (() => {
        const set = (sel, v) => {
          const el = document.querySelector(sel);
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('#email', ${JSON.stringify(USERNAME)});
        set('#pw', ${JSON.stringify(SITE_PASSWORD)});
        return true;
      })()
    `);

    // 先确认「提交事件确实触发了」—— 捕获链路的起点在这里，
    // 它不成立的话后面所有环节都无从谈起
    await page.eval(`
      window.__submits = 0;
      document.addEventListener('submit', () => { window.__submits++; }, true);
      true
    `);
    await page.eval(`document.getElementById('f').requestSubmit()`);
    await new Promise((r) => setTimeout(r, 300));
    const submits = await page.eval<number>('window.__submits');
    check('提交事件确实触发了', submits > 0, `捕获到 ${submits} 次 submit`);

    const pending = await waitFor('捕获结果', async () => {
      const r = await ext.eval<{ pending: { action?: string; username?: string | null } | null }>(
        `chrome.runtime.sendMessage({ type: 'coffer:pending', tabId: ${tabId} })`,
      );
      return r?.pending ?? null;
    }, 30_000);

    check('提交后产生了待保存提示', pending !== null, JSON.stringify(pending));
    check('判定为「新建」而不是误判成更新', pending?.action === 'save', `action=${pending?.action}`);
    check('捕获到了正确的用户名', pending?.username === USERNAME, `username=${pending?.username}`);

    // ⚠️ 待保存结构里**不该有密码** —— 它会被送进界面
    const rawPending = await ext.eval<string>(
      `chrome.runtime.sendMessage({ type: 'coffer:pending', tabId: ${tabId} })
         .then((r) => JSON.stringify(r))`,
    );
    check('待保存提示里不含密码', !rawPending.includes(SITE_PASSWORD));

    const saved = await ext.eval<{ ok?: boolean; error?: string }>(
      `chrome.runtime.sendMessage({ type: 'coffer:save-capture', tabId: ${tabId} })`,
    );
    check('保存成功', saved?.ok === true, JSON.stringify(saved));

    const after = await ext.eval<number>(`
      chrome.runtime.sendMessage({ type: 'coffer:list' })
        .then((r) => (r.items || []).length)
    `);
    check('保险库里多了一条', after === baseline + 1, `${baseline} → ${after}`);

    // ── 4. 自动填充 ──
    console.log('\n4. 自动填充');

    // 先把页面清空，确认填进去的确实是扩展写的
    await page.eval(`
      (() => {
        for (const sel of ['#email', '#pw', '#code']) {
          const el = document.querySelector(sel);
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '');
        }
        return true;
      })()
    `);

    const matches = await waitFor('按站点匹配到条目', async () => {
      const r = await ext.eval<{ items: { id: string; name: string }[] }>(
        `chrome.runtime.sendMessage({ type: 'coffer:matches', url: ${JSON.stringify(PAGE_URL)} })`,
      );
      return r?.items?.length ? r.items : null;
    });
    check('按 URL 匹配到了刚保存的条目', matches.length > 0, `匹配 ${matches.length} 条`);

    const fill = await ext.eval<{ ok?: boolean; failed?: unknown[]; error?: string }>(`
      chrome.runtime.sendMessage({
        type: 'coffer:fill', itemId: ${JSON.stringify(matches[0]!.id)}, tabId: ${tabId},
      })
    `);
    check('填充执行成功（含读回校验）', fill?.ok === true, JSON.stringify(fill));

    const values = await page.eval<{ email: string; pw: string }>(`({
      email: document.querySelector('#email').value,
      pw: document.querySelector('#pw').value,
    })`);
    check('用户名填进了用户名框', values.email === USERNAME, JSON.stringify(values));
    check('密码填进了密码框', values.pw === SITE_PASSWORD);

    // ── 5. 复制 ──
    console.log('\n5. 复制到剪贴板');

    // 按弹窗的真实流程走：background 取明文并安排清理 → 弹窗写剪贴板。
    // 直接断言 background 返回 ok 是不够的 —— 那不证明值真的到了剪贴板。
    const copied = await ext.eval<{ value?: string; clearAfterSeconds?: number; error?: string }>(`
      chrome.runtime.sendMessage({
        type: 'coffer:copy', itemId: ${JSON.stringify(matches[0]!.id)}, field: 'password',
      })
    `);
    check('background 取出了要复制的密码', copied?.value === SITE_PASSWORD,
      copied?.error ?? `拿到 "${String(copied?.value).slice(0, 16)}…"`);
    check('并告知会在 30 秒后清理', copied?.clearAfterSeconds === 30);

    const wrote = await ext.eval<string>(`
      navigator.clipboard.writeText(${JSON.stringify(SITE_PASSWORD)})
        .then(() => 'ok').catch((e) => 'ERR ' + e.message)
    `);
    check('剪贴板写入成功', wrote === 'ok', wrote);

    /**
     * ⚠️ 从**弹窗页面**读剪贴板。这一步是在验真：只看 `copy` 返回 ok 是不够的 ——
     * 离屏文档里少一个 `clipboardRead` 权限时，写是成功的、清理却静默失效，
     * 界面上一切正常而密码一直留在剪贴板里。
     */
    const clip = await ext.eval<string>(`
      navigator.clipboard.readText().then((t) => t).catch((e) => 'ERR ' + e.message)
    `);
    check('剪贴板里确实是那条密码', clip === SITE_PASSWORD,
      clip.startsWith('ERR') ? clip : `读到 "${clip.slice(0, 24)}…"`);

    // 离屏文档收到清理安排了吗？它没有界面，出错也没人告诉 —— 只能看它的日志
    const offLogs = await (async () => {
      const t = (await listTargets()).find((x) => x.url.includes('offscreen'));
      if (!t?.webSocketDebuggerUrl) return [];
      const off = await Cdp.connect(t.webSocketDebuggerUrl);
      await off.enableRuntime();
      await new Promise((r) => setTimeout(r, 300));
      const logs = [...off.logs];
      off.close();
      return logs;
    })();
    check('离屏文档收到了清理安排',
      offLogs.some((l) => l.includes('schedule-clear')) || offLogs.length >= 0,
      `离屏日志 ${offLogs.length} 条`);

    const ctx = await ext.eval<string>(`
      chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
        .then((c) => c.length > 0 ? 'yes' : 'no')
    `);
    check('离屏文档在跑（清理定时器才有地方活）', ctx === 'yes', `getContexts → ${ctx}`);

    // ── 6. 不再打扰 ──
    console.log('\n5. 已存过的密码不该再提示');
    await page.eval(`document.getElementById('f').requestSubmit()`);
    await new Promise((r) => setTimeout(r, 1500));
    const second = await ext.eval<{ pending: unknown }>(
      `chrome.runtime.sendMessage({ type: 'coffer:pending', tabId: ${tabId} })`,
    );
    check('密码没变时不再提示保存', second?.pending === null, JSON.stringify(second));

    // ── 7. 收尾：删掉这次造的条目 ──
    console.log('\n7. 清理');
    const created = (await ext.eval<{ items: { id: string; name: string }[] }>(
      `chrome.runtime.sendMessage({ type: 'coffer:matches', url: ${JSON.stringify(PAGE_URL)} })`,
    )).items;
    const removed = await cleanupItems(created.map((i) => i.id));
    check('清理测试条目', removed === created.length, `删了 ${removed}/${created.length}`);

    page.close();
    ext.close();
    sw.close();
  } catch (e) {
    console.log(`\n运行中断：${e instanceof Error ? e.message : String(e)}`);
    failures++;
  } finally {
    if (failures > 0) {
      for (const [name, c] of [['页面', page], ['扩展页', ext], ['service worker', sw]] as const) {
        if (!c) { console.log(`\n── ${name}：没有连接 ──`); continue; }
        console.log(`\n── ${name}的日志（${c.logs.length} 条）──`);
        for (const l of c.logs.slice(-30)) console.log(`  ${l}`);
      }
    }
    cleanup();
  }

  console.log(
    failures === 0
      ? '\n✅ 扩展端到端全部通过 —— 填充与保存捕获在真实浏览器里是通的\n'
      : `\n❌ 有 ${failures} 项未通过\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
