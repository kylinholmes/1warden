# @coffer/extension

浏览器扩展（Manifest V3）。自动填充、密码生成、与桌面端同一套密码学实现。

## 构建

```bash
bun run build          # 产出 dist/
```

## 载入

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选 `apps/extension/dist`

## 开发时的两个坑

**content script 不能是 ES module。** 它由独立的 Vite 配置
（`vite.content.config.ts`）打成自包含的 IIFE。如果直接把它加进主配置，
产物里会留下 `import` 语句 —— 浏览器会**静默**拒绝加载，页面上什么都不发生。
构建后可以用这个确认：

```bash
grep -c '^import ' dist/content.js   # 必须是 0
```

**service worker 会被杀。** 约 30 秒空闲后浏览器就终止它，模块变量全部归零。
任何跨请求的状态都必须落在 `chrome.storage.session` 里（见 `src/session-store.ts`）。
注意**不能**用 `chrome.storage.local` —— 那是磁盘，明文与密钥落盘违反不变量 S1。

## 安全模型

填充时明文**不经过 content script**：

```
content script  →  上报「页面上有哪些输入框」（只有位置，没有值）
background      →  用完整条目算出「第几个框填什么」
background      →  chrome.scripting.executeScript 注入瞬时函数，值经 args 直达
```

content script 是常驻在页面里的那份代码，页面上的 XSS 或别的扩展更容易够到它 ——
所以让它从头到尾看不到密码。

## MV3 里三个实测出来的坑

**service worker 会收到自己 `runtime.sendMessage` 发出的消息。** 这与「发送方
不会收到自己的消息」的常见说法相反。后果是发给离屏文档的请求会被自己的监听器
抢先应答，调用方拿到「未知请求：xxx」这种驴唇不对马嘴的报错。**内部消息一律
用另一个前缀**（`coffer-internal:`），让它落在对外路由之外。

**离屏文档的 `sendResponse` 回不去。** 投递是好的（`onMessage` 收得到），
但无论发送方是 service worker 还是弹窗，拿回来的都是 `undefined`。
所以跟它通信只能「发完不管」，别设计成请求-应答。

**离屏文档里 `chrome.storage` 是 undefined。** 想拿它当信箱也不行。

这三条合起来决定了剪贴板清理的实现形状：消息只用来**通知**离屏文档挂定时器，
剪贴板由弹窗写（它有用户手势，写失败也能当场报错），
值不经过离屏文档。

## 剪贴板

复制后 30 秒清空，且**只在内容还是我们写进去的东西时才清** ——
无条件清空会把用户后来复制的内容抹掉。这需要 `clipboardRead`：
少了它 `readText()` 抛错、清理静默失效，界面上那句「30 秒后清空」就是空头承诺。
