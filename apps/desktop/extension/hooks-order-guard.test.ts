import { describe, it, expect } from 'vitest';
import ts from 'typescript';

/**
 * 守卫：**提前返回之后再调 hook**。
 *
 * ## 为什么值得单独写一个测试
 *
 * 这个错误我自己刚犯过一次：在 `Popup.tsx` 里把 `railTypes` 那个 `useMemo`
 * 插到了 `if (status === null) return …` **之后**。首屏 `status` 是 null 时
 * 不调用它，数据到了才调用 —— React 抛
 *
 *     Rendered more hooks than during the previous render
 *
 * 整棵树不渲染，用户看到的是一张**全白**。
 *
 * 而当时的检查**全部通过**：类型检查、827 个测试、构建、Firefox 打包。
 * 因为 hooks 规则不是类型系统能表达的 —— `tsc` 只看形状，不看调用顺序。
 *
 * 仓库里没有 eslint，也就没有 `react-hooks/rules-of-hooks`。这条守卫是
 * 针对那个形状的替代品，**不是**完整的 hooks 检查 —— 它只管一件事：
 * 同一个函数体里，`if` / 循环 / `switch` 里出现过 `return` 之后，
 * 后面**不该**再有 `use*()` 调用。
 *
 * ## 为什么用 AST 而不是正则
 *
 * 「在 return 之后」是**控制流**上的位置，不是文本上的。正则会被缩进、
 * 换行、注释和嵌套函数骗到；而且它没法区分「顶层的 return」和
 * 「某个回调里的 return」—— 后者完全合法：
 *
 *     const f = () => { if (x) return 1; return 2; };   // 不是组件
 *     useEffect(() => { if (!a) return; doThing(); });  // 回调里的 return，合法
 *
 * 所以这里做两件事：只走**函数体的顶层语句**，遇到嵌套函数就停。
 */
const SOURCES = import.meta.glob(
  ['./**/*.tsx', '../../desktop/src/**/*.tsx', '../../../packages/ui/src/**/*.tsx'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

/** 这个语句本身会不会「有条件地返回」—— 只看它自己那一层，不钻进嵌套函数 */
function returnsConditionally(stmt: ts.Statement): boolean {
  if (!ts.isIfStatement(stmt) && !ts.isSwitchStatement(stmt)
    && !ts.isForStatement(stmt) && !ts.isForOfStatement(stmt)
    && !ts.isForInStatement(stmt) && !ts.isWhileStatement(stmt)
    && !ts.isDoStatement(stmt) && !ts.isTryStatement(stmt)) {
    return false;
  }
  return containsReturn(stmt);
}

function containsReturn(node: ts.Node): boolean {
  if (ts.isReturnStatement(node)) return true;
  // 嵌套函数里的 return 是它自己的事 —— 不进
  if (ts.isFunctionLike(node)) return false;
  return ts.forEachChild(node, containsReturn) === true;
}

/** 这个语句里有没有 `use*()` 调用 —— 同样不钻进嵌套函数 */
function containsHookCall(node: ts.Node): boolean {
  if (ts.isFunctionLike(node) && !ts.isSourceFile(node)) return false;
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && /^use[A-Z]/.test(callee.text)) return true;
  }
  return ts.forEachChild(node, containsHookCall) === true;
}

function offenders(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const checkBody = (body: ts.Block): void => {
    let sawConditionalReturn = false;
    for (const stmt of body.statements) {
      if (sawConditionalReturn && containsHookCall(stmt)) {
        const { line } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
        const text = stmt.getText(sf).split('\n')[0]!.trim().slice(0, 60);
        found.push(`${file.replace('./', '')}:${line + 1}  ${text}`);
        return; // 一个函数报一次就够
      }
      if (returnsConditionally(stmt)) sawConditionalReturn = true;
    }
  };

  /*
   * `ts.isFunctionLike` 的类型里包含**没有函数体**的签名声明（重载、抽象方法…），
   * 所以不能直接读 `.body` —— 要先收窄到真有 body 的那种。
   * （这个错误单测抓不到：vitest 不做类型检查，只有 `tsc` 会报。）
   */
  const bodyOf = (node: ts.Node): ts.Block | null => {
    if (!ts.isFunctionLike(node)) return null;
    const body = (node as ts.FunctionLikeDeclaration).body;
    return body !== undefined && ts.isBlock(body) ? body : null;
  };

  const visit = (node: ts.Node): void => {
    const body = bodyOf(node);
    if (body !== null) checkBody(body);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('hook 不在提前返回之后调用', () => {
  it('没有任何函数把 use* 放在有条件 return 的后面', () => {
    const all: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      if (/\.test\.tsx?$/.test(path)) continue; // 测试正文里有反例
      all.push(...offenders(path, source));
    }
    expect(
      all,
      'React 的 hooks 必须**每次渲染都按同样的顺序调用**。有条件 return 之后再调，\n' +
        '首屏和后续渲染的 hook 数量就不一样，React 会抛\n' +
        '「Rendered more hooks than during the previous render」——**整棵树不渲染**。\n' +
        '⚠️ 类型检查、单测、构建全都不会报这个。修法：把 hook 挪到提前返回之前。\n' +
        all.join('\n'),
    ).toEqual([]);
  });

  it('确实扫到了 .tsx（不是扫了个空列表）', () => {
    const keys = Object.keys(SOURCES).filter((k) => !/\.test\.tsx?$/.test(k));
    expect(keys.length).toBeGreaterThan(10);
    expect(keys).toContain('./popup/main.tsx');
    expect(keys.some((key) => key.endsWith('screens/VaultView.tsx'))).toBe(true);
  });

  it('守卫确实认得出来（正例抓、反例放过）', () => {
    const bad = `
      function C() {
        const [s] = useState(0);
        if (s === null) return null;
        const m = useMemo(() => 1, [s]);
        return m;
      }`;
    expect(offenders('bad.tsx', bad)).toHaveLength(1);

    const good = `
      function C() {
        const [s] = useState(0);
        const m = useMemo(() => 1, [s]);
        if (s === null) return null;
        return m;
      }`;
    expect(offenders('good.tsx', good)).toHaveLength(0);

    // 嵌套函数里的 return **不算**「提前返回」—— 它不改变本函数的 hook 数量
    const nestedReturn = `
      function C() {
        const [s] = useState(0);
        const f = () => { if (!s) return 1; return 2; };
        const m = useMemo(() => f(), [s]);
        return m;
      }`;
    expect(offenders('nested.tsx', nestedReturn)).toHaveLength(0);

    // 循环里的 return 也是「有条件返回」—— 它照样能让 hook 数量在两次渲染间不同
    const loopReturn = `
      function C() {
        const [s] = useState(0);
        for (const x of s) { if (x) return null; }
        useEffect(() => {}, []);
        return null;
      }`;
    expect(offenders('loop.tsx', loopReturn)).toHaveLength(1);
  });
});
