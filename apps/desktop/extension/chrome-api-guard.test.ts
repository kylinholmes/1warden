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
 * 这里的 `types` 限定成 `["vite/client", "chrome"]` —— **故意不含 `node`**。
 * 加了的话，`process` / `Buffer` / `__dirname` 会在整个源码里通过类型检查
 * （包括 content script 和 popup），然后在浏览器里炸掉。
 * 那是这个项目已经踩过的坑（「类型放行、运行时崩」），不能为了一个测试破例。
 *
 * `vite/client` 本来就在白名单里，所以用 Vite 自己的 glob 读源码 ——
 * 同样是构建期求值，一行配置都不用改。
 *
 * ## ⚠️ 扫描范围**包含 `../src`（桌面端）
 *
 * 这不是顺手扩大的。合并成一个 app 之后，`chrome` 类型对所有源码都可见了 ——
 * 包括桌面端的 `src/`，而那里 `chrome` **根本不存在**，写下去就是运行时
 * `chrome is not defined`。以前两个 app 各有各的 tsconfig，桌面端那份没有
 * `chrome` 类型，写错会直接编译不过；合并把这个天然的防线拆掉了。
 *
 * 所以防线挪到这里：**两边一起扫**。桌面端本来就一个裸 `chrome` 都不该有，
 * 这条对它恒成立；万一将来有人从扩展代码里复制一段过来，这里会当场变红。
 */
const SOURCES = import.meta.glob(['./**/*.{ts,tsx}', '../src/**/*.{ts,tsx}'], {
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
        // 只去掉**行首**的 `./`。用 `replace('./','')` 会命中 `../src/…`
        // 里第二个字符起的那一段，报出来变成 `.src/…` —— 一个查不到的路径。
        found.push(`${file.replace(/^\.\//, '')}:${line + 1}  ${node.getText(sf).split('\n')[0]!.slice(0, 70)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * 取一个文件里所有 `import ... from 'x'` 的模块说明符。
 *
 * 还是用 AST 而不是正则：正则会把注释里举例的 import 也算进来。
 */
function moduleSpecifiers(source: string): string[] {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 把 `./a/b` 这种相对说明符解析成 SOURCES 里的键 */
function resolveSpecifier(fromPath: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;   // @1warden/* 之类的包依赖，不是本目录源码
  const base = fromPath.slice(0, fromPath.lastIndexOf('/'));
  const parts: string[] = [];
  for (const seg of `${base}/${spec}`.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const joined = `./${parts.join('/')}`;
  for (const cand of [`${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`, `${joined}/index.tsx`]) {
    if (cand in RESOLVABLE) return cand;
  }
  return null;
}

/** 从某个入口出发，能到达的全部本目录模块（含自身） */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    const source = SOURCES[cur];
    if (source === undefined) continue;
    for (const spec of moduleSpecifiers(source)) {
      const next = resolveSpecifier(cur, spec);
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * 被测源码。
 *
 * 排除三类：
 * - 测试自己（正文里有**故意写错**的反例，会被自己的检查抓到）
 * - `node_modules`（vitest 会把缓存写进 `src/node_modules/.vite`，
 *   哪天缓存里出现 `.ts` 就会变成一个查不出原因的红）
 *
 * ⚠️ **不**排除 `ext-api.ts` —— 它要被扫描（shim 的定义处），
 * 也要能被解析（别的文件 import 它）。豁免它的是 `.ts` 值位置那条检查里的
 * `ALLOWED`，不是这里。
 */
function scannedSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, source] of Object.entries(SOURCES)) {
    if (path.includes('node_modules')) continue;
    if (/\.test\.tsx?$/.test(path)) continue;
    out[path] = source;
  }
  return out;
}

/** 可被 import 解析到的模块 —— 和被测源码同一份视图 */
const RESOLVABLE = scannedSources();

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

/**
 * MAIN world 的脚本跑在**页面的** global 上，那里 `globalThis.chrome` 是网页版的
 * `chrome` 对象（有 `loadTimes` 之类，**没有任何扩展 API**），`globalThis.browser`
 * 在 Chrome 上则根本不存在。
 *
 * 所以 `ext-api.ts` 的 shim 在 MAIN world 里是个**陷阱**：它不报错，只是悄悄
 * 返回一个错的对象，然后在某个更远的地方炸掉。
 *
 * ⚠️ 而上面那条「值位置不许出现裸 chrome」的检查**抓不到这个** ——
 * `import { ext } from './ext-api'` 是「合法」的写法。这条不变量此前只写在
 * `webauthn-wire.ts` 的注释里（「只能依赖标准 Web API」），靠人记得。
 *
 * MAIN world 的入口在 `vite.content.config.ts` 里指定（`ONEWARDEN_ENTRY=webauthn`
 * → `src/webauthn-inject.ts` → `webauthn.js`）。
 */
const MAIN_WORLD_ENTRY = './webauthn-inject.ts';

describe('MAIN world 的脚本不依赖扩展 API', () => {
  it('webauthn-inject 的整个依赖图里没有 ext-api', () => {
    const reachable = [...reachableFrom(MAIN_WORLD_ENTRY)];
    expect(
      reachable.filter((p) => p === './ext-api.ts'),
      'MAIN world 拿不到扩展 API —— shim 在那里会返回页面的 chrome 对象。' +
        `改为通过 window.postMessage 桥回 content script。依赖图：\n${reachable.join('\n')}`,
    ).toEqual([]);
  });

  /** 依赖图要是没走通，上面那条会因为「什么都没连到」而永远通过 */
  it('依赖图确实走通了（不是个孤点）', () => {
    const reachable = reachableFrom(MAIN_WORLD_ENTRY);
    expect(reachable.size).toBeGreaterThan(1);
    expect([...reachable]).toContain('./webauthn-wire.ts');
  });

  /** 解析器本身也要能被信任 */
  it('相对说明符解析正确（含 ../ 和子目录）', () => {
    expect(resolveSpecifier('./webauthn-inject.ts', './webauthn-wire')).toBe('./webauthn-wire.ts');
    expect(resolveSpecifier('./popup/Popup.tsx', '../ext-api')).toBe('./ext-api.ts');
    expect(resolveSpecifier('./popup/Popup.tsx', './main')).toBe('./popup/main.tsx');
    // 包依赖不是本目录源码，不该解析
    expect(resolveSpecifier('./a.ts', '@1warden/vault')).toBeNull();
    // 指向不存在的文件时返回 null，而不是编一个路径出来
    expect(resolveSpecifier('./popup/Popup.tsx', './does-not-exist')).toBeNull();
  });
});
