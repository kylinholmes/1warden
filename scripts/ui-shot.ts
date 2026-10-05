#!/usr/bin/env bun
/**
 * 给静态页面截图 —— 界面验证用。
 *
 * ## 为什么需要它
 *
 * 原生壳里的界面验证依赖 macOS 的辅助功能/屏幕录制授权，而那两个授权
 * 在开发期**每次重编都可能失效**（未签名构建没有稳定身份）。授权一失效，
 * 就既读不到可访问性树也截不了图，界面只能靠「读代码想象」——
 * 而排版问题恰恰是读代码看不出来的。
 *
 * 这条路完全不碰那些授权：静态页 + 无头浏览器 + CDP 截图。
 *
 *   bun run scripts/ui-shot.ts <目录> <路径> <输出.png> [宽] [高]
 *
 * 例：
 *   bun run scripts/ui-shot.ts apps/desktop/dist-preview / "security.png" 900 1100
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = 9333;

const [, , rootArg, pathArg, outArg, widthArg, heightArg] = process.argv;
if (!rootArg || !pathArg || !outArg) {
  console.error('用法：bun run scripts/ui-shot.ts <目录> <路径> <输出.png> [宽] [高]');
  process.exit(2);
}

const root = resolve(rootArg);
const relPath = pathArg;
const out = resolve(outArg);
const width = Number(widthArg ?? 900);
const height = Number(heightArg ?? 1100);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    let p = url.pathname;
    if (p === '/') p = '/index.html';
    const file = Bun.file(join(root, p));
    if (!(await file.exists())) return new Response('not found', { status: 404 });
    return new Response(file, {
      headers: { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' },
    });
  },
});

const pageUrl = `http://127.0.0.1:${server.port}${relPath}`;
const profile = mkdtempSync(join(tmpdir(), 'coffer-shot-'));

const edge = Bun.spawn([
  EDGE,
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  `--window-size=${width},${height}`,
  '--headless=new',
  '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars',
  'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });

function cleanup(): void {
  try { edge.kill(); } catch { /* 已经退了 */ }
  server.stop(true);
  rmSync(profile, { recursive: true, force: true });
}

interface Target { type: string; url: string; webSocketDebuggerUrl?: string }

async function waitForTarget(): Promise<Target> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json() as Target[];
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error('等待浏览器超时');
    await new Promise((r) => setTimeout(r, 200));
  }
}

try {
  const target = await waitForTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl!);
  await new Promise<void>((ok, err) => {
    ws.onopen = () => ok();
    ws.onerror = () => err(new Error('无法连接 CDP'));
  });

  let seq = 0;
  const waiting = new Map<number, (v: unknown) => void>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; method?: string; params?: unknown };
    /*
     * 打开 COFFER_SHOT_VERBOSE=1 时把页面里的报错打出来。
     * 截图工具最坑的一种失败是「截出一张全白」—— 页面在渲染时抛了异常，
     * 而截图本身完全成功。没有这条，只能靠猜。
     */
    /*
     * ⚠️ 也要收 `Runtime.consoleAPICalled`。
     *
     * 只监听 `exceptionThrown` 和 `Log.entryAdded` 的话，页面里
     * `console.error(...)` 打的东西**看不到** —— 而那恰恰是排查时最常用的
     * 手段（异常只在真抛出来时才有）。我加探针时就撞上过这个：
     * 探针明明跑了，输出一个字都没有，看起来像探针没执行。
     */
    if (msg.method === 'Runtime.exceptionThrown' || msg.method === 'Log.entryAdded'
      || msg.method === 'Runtime.consoleAPICalled') {
      console.error('[页面]', JSON.stringify(msg.params).slice(0, 800));
    }
    if (msg.id === undefined) return;
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
  };
  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const id = ++seq;
    return new Promise<T>((ok) => {
      waiting.set(id, ok as (v: unknown) => void);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  await send('Page.enable');

  /*
   * 剪贴板授权。
   *
   * ⚠️ 没有它，「复制」这条路径**根本验不了**，而且失败的样子和产品坏了一样：
   * 无头页面通常不是聚焦状态，Chromium 会拒绝 `navigator.clipboard.writeText`；
   * 组件里那个 catch 把失败吞了（按钮不变、也不报错），截图看起来只是
   * 「点了没反应」。我第一次跑就是被这个骗了一轮 —— 以为是点击没命中。
   *
   * 授权失败不该让整张截图失败（老版本 CDP 未必有这个域），所以吞掉异常：
   * 退化成的结果是「复制验不了」，而不是「截图工具挂了」。
   */
  try {
    await send('Browser.grantPermissions', {
      origin: `http://127.0.0.1:${server.port}`,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
  } catch { /* 见上 */ }

  /*
   * ⚠️ 光有授权**不够** —— Chromium 还要求文档处于**聚焦**状态。
   *
   * 无头页面默认 `document.hasFocus() === false`，于是 `writeText` 抛
   * `NotAllowedError`，而组件里那个 catch 把失败吞了：按钮不变、也不报错。
   * 我第一次只加授权，复制照样不生效，看起来和「点击没命中」一模一样。
   * （探针打出 `clipboard=object focused=false` 才分清楚这两件事。）
   */
  try {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch { /* 见上 */ }

  if (process.env.COFFER_SHOT_VERBOSE) {
    await send('Runtime.enable');
    await send('Log.enable');
  }
  /*
   * ⚠️ 手机视口 ≠ 手机。
   *
   * `COFFER_SHOT_TOUCH=1` 之前，「手机尺寸」那一轮跑的是
   * `mobile: false` + 没有触摸模拟 —— 那是**一个窄的桌面窗口**：
   * 有鼠标、有 hover、有精确指针。手机上这三样都没有，
   * 而「导航抽屉靠 `:hover` 打开」这种设计恰恰只有在没有 hover 时才露馅。
   *
   * 所以尺寸和触摸能力是**两件事**，得分开说：`390×844` 只回答了
   * 「排版在窄屏下成不成立」，`touch` 才回答「这套交互在手指下成不成立」。
   * 上面 docs 里那次验收只做了前者 —— 记在那里了。
   */
  const touch = process.env.COFFER_SHOT_TOUCH === '1';
  await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 5 });
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile: touch,
  });

  /*
   * 强制配色方案。
   *
   * 无头浏览器跟随系统外观，而开发机常年是暗色 —— 于是亮色主题**永远
   * 截不到**，两套颜色里有一套没人看过。用 COFFER_SHOT_SCHEME=light 抓一遍，
   * 「亮色下对比度不够」这类问题才可能被发现。
   */
  const scheme = process.env.COFFER_SHOT_SCHEME;
  if (scheme === 'light' || scheme === 'dark') {
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    });
  }

  await send('Page.navigate', { url: pageUrl });

  /*
   * 等字体与布局稳定。用固定延时而不是 networkidle —— 静态页没有网络活动可等。
   *
   * 延时可以用 COFFER_SHOT_DELAY 覆盖：动效的**中间帧**只有在那之前拍才拍得到。
   * 预览页的 `?at=` 会把 CSS 动画定格在指定毫秒处（见 preview/main.tsx），
   * 两者配合才能给出可复现的关键帧截图 —— 靠卡时间点拍动画是拍不准的。
   */
  const delay = Number(process.env.COFFER_SHOT_DELAY ?? 1200);
  await new Promise((r) => setTimeout(r, delay));

  /*
   * 点一下再拍。
   *
   * `COFFER_SHOT_TAP=<选择器>` —— 用**触摸**点这个元素的中心，等一小会儿
   * 让动效走完，然后截图。
   *
   * ⚠️ 为什么是触摸而不是 `element.click()`：`click()` 走的是**鼠标**那条路，
   * 会老老实实地把 `:hover` 也置上。而移动端真正的问题是
   * 「**没有 hover 的时候这个交互还成不成立**」—— 用 `click()` 去验，
   * 等于把要验的那个前提自己抹掉了。
   *
   * `Input.dispatchTouchEvent` 走的是和手指同一条输入路径，
   * 所以「靠 `:hover` 打开的浮层在触摸下会怎样」这一条才有意义。
   */
  const tapSelector = process.env.COFFER_SHOT_TAP;
  if (tapSelector) {
    const point = await send<{ result?: { value?: { x: number; y: number } | null } }>(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(tapSelector)});
          if (el === null) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`,
        returnByValue: true,
      },
    );
    const p = point.result?.value;
    if (!p) {
      // 找不到就**大声**说 —— 静默跳过的话，截出来的是一张「没点过」的图，
      // 而它看起来和「点了没反应」一模一样。
      throw new Error(`COFFER_SHOT_TAP：找不到 ${tapSelector}`);
    }
    await send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }],
    });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // 等动效走完（--dur-base 是 200 上下，给足余量）
    await new Promise((r) => setTimeout(r, Number(process.env.COFFER_SHOT_TAP_DELAY ?? 700)));
  }

  const shot = await send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`已截图 → ${out}（${width}×${height} @2x）`);
  ws.close();
} finally {
  cleanup();
}

void createHash; // 保留导入位，方便将来给截图命名加指纹
