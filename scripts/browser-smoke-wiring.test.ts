import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync('scripts/browser-smoke.ts', 'utf8');
const tree = ts.createSourceFile('browser-smoke.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const clickFunction = tree.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'click')!;

afterEach(() => vi.unstubAllGlobals());

function fixture(engine: 'chrome' | 'firefox', replaceWhileWaiting = false) {
  const domClick = vi.fn();
  const scrollIntoView = vi.fn();
  const node = { click: domClick, scrollIntoView, textContent: 'Alpha smoke login',
    closest: () => null, contains: (hit: unknown) => hit === node,
    getBoundingClientRect: () => ({ x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 60, width: 100, height: 40 }) };
  const previous = { ...node, getBoundingClientRect: () => ({ ...node.getBoundingClientRect(), left: -200 }) };
  let current = replaceWhileWaiting ? previous : node;
  const querySelector = vi.fn(() => current);
  vi.stubGlobal('document', { querySelector, querySelectorAll: () => [current], elementFromPoint: () => node });
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
  vi.stubGlobal('innerWidth', 440); vi.stubGlobal('innerHeight', 600);
  const handle = {
    click: vi.fn(async () => {}),
    evaluate: vi.fn(async (action: (node: typeof current) => void) => action(current)),
    dispose: vi.fn(async () => {}),
  };
  const popup = { waitForFunction: vi.fn(async (predicate: (...args: unknown[]) => unknown, _options: unknown, ...args: unknown[]) => {
    // Reproduce a revision replacing the button between two rendering frames.
    if (replaceWhileWaiting) {
      expect(predicate(...args)).toBe(false);
      current = node;
    }
    expect(predicate(...args)).toBe(node);
    return handle;
  }) };
  // Exercise the actual script helper without launching its top-level browser workflow.
  const javascript = ts.transpile(clickFunction.getText(tree), { target: ts.ScriptTarget.ES2022 });
  const click = new Function('popup', 'name', `${javascript}; return click;`)(popup, engine) as (selector: string) => Promise<void>;
  return { click, popup, handle, domClick, scrollIntoView, querySelector };
}

describe('production extension smoke input routing', () => {
  it('routes every popup pointer click through the engine-aware helper', () => {
    const bypasses: number[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(tree) === 'popup' && node.expression.name.text === 'click') {
        bypasses.push(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    expect(bypasses, 'Direct popup.click bypasses Gecko privileged-page input adaptation').toEqual([]);
  });

  it('uses DOM activation on the real Gecko target rather than unsupported native actions', async () => {
    const f = fixture('firefox');
    await f.click('[data-add-server]');
    expect(f.domClick).toHaveBeenCalledOnce();
    expect(f.handle.click).not.toHaveBeenCalled();
    expect(f.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  });

  it('keeps native pointer activation and actionability checks on Chromium', async () => {
    const f = fixture('chrome');
    await f.click('[data-add-server]');
    expect(f.popup.waitForFunction).toHaveBeenCalledOnce();
    expect(f.handle.click).toHaveBeenCalledOnce();
    expect(f.domClick).not.toHaveBeenCalled();
    expect(f.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  });

  it('re-resolves a replaced button instead of waiting on its detached predecessor', async () => {
    const f = fixture('chrome', true);
    await f.click('[aria-label="加入收藏"]');
    expect(f.querySelector).toHaveBeenCalledTimes(2);
    expect(f.handle.click).toHaveBeenCalledOnce();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  });

  it('resolves the text target before activating it', async () => {
    const f = fixture('chrome');
    await f.click('button::-p-text(Alpha smoke login)');
    expect(f.handle.click).toHaveBeenCalledOnce();
  });
});
