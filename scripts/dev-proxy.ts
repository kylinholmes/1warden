#!/usr/bin/env bun
/**
 * 本地开发用的 HTTP → HTTPS 代理。
 *
 * **为什么需要它**：开发服务器用自签证书走 HTTPS（因为官方 CLI 拒绝明文 HTTP），
 * 但桌面 App 的 WebView 不会接受自签证书。两条路：
 *   a) 把证书装进系统钥匙串 —— 需要 sudo，而且会污染用户的机器
 *   b) 加一个本地代理，让 App 走明文 HTTP
 *
 * 选 (b)：不动系统状态，改一行配置就能切换。**仅限本地开发。**
 *
 *   bun run scripts/dev-proxy.ts        # 监听 8080，转发到 https://localhost:8443
 */
const LISTEN_PORT = Number(process.env.PROXY_PORT ?? 8080);
const UPSTREAM = process.env.VW_URL ?? 'https://localhost:8443';

const server = Bun.serve({
  port: LISTEN_PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    const target = `${UPSTREAM}${url.pathname}${url.search}`;

    // 逐跳头部不能透传
    const headers = new Headers(req.headers);
    headers.delete('host');
    headers.delete('connection');

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
        // @ts-expect-error Bun 专有选项：接受自签证书。仅限本地开发。
        tls: { rejectUnauthorized: false },
        redirect: 'manual',
      });

      const out = new Headers(upstream.headers);
      out.delete('content-encoding'); // fetch 已解压，别让浏览器再解一次
      out.delete('content-length');
      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: `代理无法连到 ${UPSTREAM}：${String(e)}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }
  },
});

console.log(`→ 代理已启动: http://127.0.0.1:${server.port}  →  ${UPSTREAM}`);
console.log('  （仅限本地开发；生产环境直连 HTTPS）');
