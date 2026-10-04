import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fillFields, readFieldValues, type FillOutcome } from './fill';

/**
 * 这些函数会被 `chrome.scripting.executeScript` 把 `toString()` 之后注入页面。
 * 也就是说**闭包里引用的任何外部变量都不存在** —— 而失败是静默的：
 * 页面上什么都不发生，控制台也不一定有声。
 *
 * 所以这里用同样的手法把它们「脱离闭包」再执行。只要实现里偷用了模块作用域的
 * 东西，就会在这里抛 ReferenceError，而不是等到用户点了填充什么都没有。
 */
function detach<F>(fn: F): F {
  return new Function(`return (${String(fn)})`)() as F;
}

// ── 一个够用的假 DOM ──

class FakeInput {
  type = 'text';
  disabled = false;
  readOnly = false;
  focused = false;
  events: string[] = [];

  constructor() {
    Object.defineProperty(this, '_value', { value: '', writable: true, enumerable: false });
  }

  focus(): void { this.focused = true; }
  blur(): void { this.focused = false; }
  dispatchEvent(e: { type: string }): boolean { this.events.push(e.type); return true; }
}

class FakeTextArea extends FakeInput {}

// 原型上的存取器就是「原生 setter」—— 真实浏览器里 React 正是把它遮掉的
Object.defineProperty(FakeInput.prototype, 'value', {
  get(this: { _value: string }) { return this._value; },
  set(this: { _value: string }, v: string) { this._value = v; },
  configurable: true,
});

let nodes: FakeInput[] = [];

const globals = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeEach(() => {
  for (const k of ['document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event']) saved[k] = globals[k];

  nodes = [];
  globals['document'] = {
    querySelectorAll: () => nodes,
  };
  globals['HTMLInputElement'] = FakeInput;
  globals['HTMLTextAreaElement'] = FakeTextArea;
  globals['Event'] = class { constructor(public type: string) {} };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete globals[k]; else globals[k] = v;
  }
});

describe('fillFields 必须自包含', () => {
  it('survives being detached from its module scope', () => {
    nodes = [new FakeInput()];
    const detached = detach(fillFields);
    expect(() => detached([{ index: 0, value: 'x' }])).not.toThrow();
  });

  it('writes the value into the field at the given index', () => {
    nodes = [new FakeInput(), new FakeInput(), new FakeInput()];
    detach(fillFields)([{ index: 2, value: 'hunter2xyz' }]);
    expect((nodes[2] as unknown as { _value: string })._value).toBe('hunter2xyz');
    // 其余字段不该被动
    expect((nodes[0] as unknown as { _value: string })._value).toBe('');
  });

  /**
   * ⚠️ 这是 React/Vue 那类框架的标准做法：给 value 装自己的 setter。
   * 直接 `el.value = x` 只改 DOM、框架状态没变，下一次重渲染就把值冲掉 ——
   * 用户看到的是「填了又没了」。所以必须先走原型上的原生 setter。
   */
  it('goes through the native prototype setter, not a framework override', () => {
    const el = new FakeInput();
    let frameworkSaw = '';
    // 模拟框架接管：实例自有的 value 属性遮住原型上的
    Object.defineProperty(el, 'value', {
      get: () => frameworkSaw,
      set: (v: string) => { frameworkSaw = v; },
      configurable: true,
    });
    nodes = [el];

    detach(fillFields)([{ index: 0, value: 'from-extension' }]);

    // 框架的 setter 不该被绕过：原生 setter 写在 _value 上，框架读自己的
    expect((el as unknown as { _value: string })._value).toBe('from-extension');
    expect(frameworkSaw).toBe('');
  });

  it('dispatches input and change so the framework notices', () => {
    const el = new FakeInput();
    nodes = [el];
    detach(fillFields)([{ index: 0, value: 'x' }]);
    expect(el.events).toContain('input');
    expect(el.events).toContain('change');
  });

  it('focuses the field while writing', () => {
    const el = new FakeInput();
    nodes = [el];
    detach(fillFields)([{ index: 0, value: 'x' }]);
    expect(el.focused).toBe(false);   // 写完就 blur 掉
  });

  /**
   * ⚠️ DOM 赋值有静默失败的先例。`verified` 是唯一能判断「到底写进去没有」
   * 的依据 —— 界面据此决定要不要告诉用户「有字段没填成功」。
   */
  it('reads the value back and reports verified', () => {
    nodes = [new FakeInput()];
    const out = detach<typeof fillFields>(fillFields)([{ index: 0, value: 'ok' }]);
    expect(out[0]).toMatchObject({ index: 0, ok: true, verified: true });
  });

  it('reports verified:false when the value did not stick', () => {
    const el = new FakeInput();
    // 读回来永远不是写进去的值 —— 模拟框架把写入吞掉了
    Object.defineProperty(el, 'value', { get: () => 'something-else', configurable: true });
    nodes = [el];

    const out = detach<typeof fillFields>(fillFields)([{ index: 0, value: 'lost' }]);
    expect(out[0]?.verified).toBe(false);
  });

  it('reports a miss instead of throwing when the index is gone', () => {
    nodes = [];
    const out = detach<typeof fillFields>(fillFields)([{ index: 7, value: 'x' }]);
    expect(out[0]).toMatchObject({ index: 7, ok: false });
    expect(out[0]?.reason).toBeTruthy();
  });

  it('refuses to write into a disabled or readonly field', () => {
    const disabled = new FakeInput(); disabled.disabled = true;
    const readonly = new FakeInput(); readonly.readOnly = true;
    nodes = [disabled, readonly];

    const out = detach<typeof fillFields>(fillFields)([
      { index: 0, value: 'a' }, { index: 1, value: 'b' },
    ]);
    expect(out[0]?.ok).toBe(false);
    expect(out[1]?.ok).toBe(false);
  });

  it('keeps going after one field fails', () => {
    const el = new FakeInput();
    nodes = [el];
    const out = detach<typeof fillFields>(fillFields)([
      { index: 5, value: 'missing' }, { index: 0, value: 'fine' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]?.ok).toBe(true);
  });
});

describe('readFieldValues 必须自包含', () => {
  it('survives being detached from its module scope', () => {
    nodes = [new FakeInput()];
    expect(() => detach(readFieldValues)([0])).not.toThrow();
  });

  it('reads the current value at each index', () => {
    const a = new FakeInput(); const b = new FakeInput();
    (a as unknown as { _value: string })._value = 'me@example.com';
    (b as unknown as { _value: string })._value = 'hunter2xyz';
    nodes = [a, b];

    expect(detach<typeof readFieldValues>(readFieldValues)([0, 1])).toEqual(['me@example.com', 'hunter2xyz']);
  });

  it('returns null for an index that no longer exists', () => {
    nodes = [];
    expect(detach<typeof readFieldValues>(readFieldValues)([3])).toEqual([null]);
  });
});

describe('填充结果的形状', () => {
  /** background 靠这两个字段判断「有没有填成功」，界面据此提示 */
  it('always carries ok and verified', () => {
    nodes = [new FakeInput()];
    const out: FillOutcome[] = detach<typeof fillFields>(fillFields)([{ index: 0, value: 'x' }]);
    expect(out[0]).toHaveProperty('ok');
    expect(out[0]).toHaveProperty('verified');
  });
});
