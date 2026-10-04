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
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown };
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
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile: false,
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

  // 等字体与布局稳定。用固定延时而不是 networkidle —— 静态页没有网络活动可等。
  await new Promise((r) => setTimeout(r, 1200));

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
