import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('scripts/browser-smoke.ts', 'utf8');
const tree = ts.createSourceFile('browser-smoke.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const clickFunction = tree.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'click')!;

function fixture(engine: 'chrome' | 'firefox') {
  const domClick = vi.fn();
  const handle = {
    click: vi.fn(async () => {}),
    evaluate: vi.fn(async (action: (node: { click(): void }) => void) => action({ click: domClick })),
    dispose: vi.fn(async () => {}),
  };
  const popup = { waitForSelector: vi.fn(async () => handle), waitForFunction: vi.fn(async () => {}) };
  // Exercise the actual script helper without launching its top-level browser workflow.
  const javascript = ts.transpile(clickFunction.getText(tree), { target: ts.ScriptTarget.ES2022 });
  const click = new Function('popup', 'name', `${javascript}; return click;`)(popup, engine) as (selector: string) => Promise<void>;
  return { click, popup, handle, domClick };
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
    expect(f.popup.waitForSelector).toHaveBeenCalledWith('[data-add-server]', { visible: true });
    expect(f.domClick).toHaveBeenCalledOnce();
    expect(f.handle.click).not.toHaveBeenCalled();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  });

  it('keeps native pointer activation and actionability checks on Chromium', async () => {
    const f = fixture('chrome');
    await f.click('[data-add-server]');
    expect(f.popup.waitForFunction).toHaveBeenCalledOnce();
    expect(f.handle.click).toHaveBeenCalledOnce();
    expect(f.domClick).not.toHaveBeenCalled();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  });
});
