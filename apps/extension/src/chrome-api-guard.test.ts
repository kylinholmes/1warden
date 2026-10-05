import { describe, it, expect } from 'vitest';
import ts from 'typescript';

/**
 * 守卫：扩展代码里**不许在值位置直接碰 `chrome` 或 `browser`**，一律走 `ext`
 * （见 ext-api.ts）。
 *
 * ## 为什么值得单独写一个测试
 *
 * 这不是洁癖，是同一个 bug 已经发生过**两次**了：
 *
 * | | `chrome.*` | `browser.*` |
 * |---|---|---|
 * | Chrome / Edge | 返回 Promise | 不存在 |
 * | Firefox / Zen | **回调式，不返回 Promise** | 返回 Promise |
 *
 * 两个方向都会炸，而且方式不同：
 *
 * - 裸 `chrome`：`chrome.runtime.sendMessage(x).catch(...)` 里 `sendMessage`
 *   返回 `undefined` —— `.catch()` 于是抛**同步** TypeError，调用点当场断掉。
 * - 裸 `chrome`（更阴的一种）：`await chrome.storage.local.get(k)` ——
 *   `await undefined` **是合法的**，于是不报错、不抛异常，只是永远拿到
 *   `undefined`。缓存永远 miss，表现是「每次解锁都很慢」，
 *   和网络慢长得一模一样。
 * - 裸 `browser`：Chrome 上 `browser` **根本不存在** → `browser is not defined`。
 *
 * 这类 bug 在**另一个**浏览器上完全不会暴露，只有换过去才看得到。
 * 靠人记得住是不够的 —— `ext-api.ts` 的文档明明写着「新增代码一律用 `ext`」，
 * 而 `content.ts`（内容脚本本体）和 `sync-cache.ts`（解锁缓存）仍然直接用，
 * 一直没人发现。所以交给机器守。
 *
 * ## 为什么用 AST 而不是正则
 *
 * 正则分不清这三种情况，而这个仓库里三种都有：
 *
 * - **注释**里的例子：`ext-api.ts` 的文档就写着 `` `await chrome.storage.session.get(...)` ``
 * - **类型位置**：`chrome.runtime.MessageSender`、`chrome.offscreen.Reason`
 *   —— 这些是**必须**保留的，换成 `ext` 反而编译不过
 * - **字符串**里的 URL（`https://…`）
 *
 * TypeScript 的 AST 天生分得清：类型位置是 `TypeReference`/`TypeQuery`，
 * 值位置才是 `PropertyAccessExpression`。
 *
 * ## 为什么用 `import.meta.glob` 而不是 `node:fs`
 *
 * 扩展的 tsconfig 把 `types` 限定成 `["chrome", "vite/client"]` —— **故意不含
 * `node`**。加了的话，`process` / `Buffer` / `__dirname` 会在整个扩展源码里
 * 通过类型检查（包括 content script 和 popup），然后在浏览器里炸掉。
 * 那是这个项目已经踩过的坑（「类型放行、运行时崩」），不能为了一个测试破例。
 *
 * `vite/client` 本来就在白名单里，所以用 Vite 自己的 glob 读源码 ——
 * 同样是构建期求值，一行配置都不用改。
 */
const SOURCES = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** 允许出现裸 `chrome` 的文件 —— 只有定义 shim 的那一个 */
const ALLOWED = new Set(['./ext-api.ts']);

/**
 * 两个名字都不能直接用，而且是**对称**的：
 *
 * - 裸 `chrome` 在 Firefox 上不返回 Promise → 静默失效或同步抛错
 * - 裸 `browser` 在 Chrome 上**根本不存在** → `browser is not defined`
 *
 * 所以判据不是「哪个名字不好」，而是「绕过了 shim」。
 */
const RAW_NAMES = new Set(['chrome', 'browser']);

/** 值位置上最左边的标识符是不是裸的 API 命名空间 */
function rootsAtRawNamespace(node: ts.Expression): boolean {
  let cur: ts.Expression = node;
  while (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
  return ts.isIdentifier(cur) && RAW_NAMES.has(cur.text);
}

/** 找出文件里所有「绕开 ext、直接用裸命名空间」的位置 */
function rawNamespaceUses(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    // 只认值位置的属性访问。类型位置（chrome.runtime.MessageSender）在 AST 里
    // 是 TypeReference，走不到这里 —— 那正是我们要放过的。
    if (ts.isPropertyAccessExpression(node) && rootsAtRawNamespace(node)) {
      // 只报链条最外层。`chrome.a.b.c()` 里每一层都以 chrome 打头，
      // 不挡的话同一行会报三条，读起来反而看不清问题在哪。
      const parent = node.parent;
      if (!ts.isPropertyAccessExpression(parent) || !rootsAtRawNamespace(parent)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push(`${file.replace('./', '')}:${line + 1}  ${node.getText(sf).split('\n')[0]!.slice(0, 70)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** 被测源码 —— 排除测试自己（它正文里有反例）和 shim */
function scannedSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, source] of Object.entries(SOURCES)) {
    if (ALLOWED.has(path) || /\.test\.tsx?$/.test(path)) continue;
    out[path] = source;
  }
  return out;
}

describe('扩展只通过 ext 访问浏览器 API', () => {
  it('没有任何文件在值位置直接用 chrome / browser', () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(scannedSources())) {
      offenders.push(...rawNamespaceUses(path, source));
    }

    expect(
      offenders,
      '这些地方绕开了 shim：裸 chrome 在 Firefox 上静默失效或同步抛错，' +
        '裸 browser 在 Chrome 上根本不存在 —— 改用 `ext`（见 ext-api.ts）：\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  /**
   * 守卫本身也得能被信任：如果 glob 没匹配到文件，上面那条会因为
   * 「一个都没扫到」而**永远通过** —— 一个永远绿的守卫比没有守卫更糟。
   */
  it('确实扫到了源码（不是扫了个空列表）', () => {
    const scanned = Object.keys(scannedSources());
    expect(scanned.length).toBeGreaterThan(10);
    // 抽查几个必须被扫到的关键文件
    expect(scanned).toContain('./background.ts');
    expect(scanned).toContain('./content.ts');
  });

  it('确实认得出来值位置的裸命名空间', () => {
    const sample = `
      import { ext } from './ext-api';
      const a = chrome.runtime.sendMessage({});        // 值位置 —— 该被抓
      const b = await browser.storage.local.get(k);    // 裸 browser —— 也该被抓
      const c: chrome.runtime.MessageSender = x;       // 类型位置 —— 该放过
      const d = (globalThis as any).chrome;            // 不是裸名字打头 —— 该放过
      const e = ext.runtime.sendMessage({});           // 走 shim —— 该放过
    `;
    const hits = rawNamespaceUses('sample.ts', sample);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toContain('chrome.runtime.sendMessage');
    expect(hits[1]).toContain('browser.storage.local.get');
  });
});
