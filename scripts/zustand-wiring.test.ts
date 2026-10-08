import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[cm]?tsx?$/.test(path) && !path.includes('.test.') ? [path] : [];
  });
}

it('keeps React state ownership in Zustand across every frontend target', () => {
  const violations: string[] = [];
  for (const directory of ['apps/desktop/src', 'apps/desktop/preview', 'apps/desktop/preview-extension', 'apps/desktop/extension', 'packages/ui/src', 'packages/state/src']) {
    for (const path of sources(join(root, directory))) {
      const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const note = (node: ts.Node) => violations.push(`${relative(root, path)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      const forbidden = new Set(['useState', 'useReducer', 'useSyncExternalStore', 'useOptimistic', 'useActionState']);
      function visit(node: ts.Node) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'react') {
          const bindings = node.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
            if (forbidden.has((item.propertyName ?? item.name).text)) note(item);
          }
        }
        if (ts.isPropertyAccessExpression(node) && (node.expression.getText(file) === 'React' && forbidden.has(node.name.text)
          || node.expression.kind === ts.SyntaxKind.ThisKeyword && ['state', 'setState'].includes(node.name.text))) note(node);
        ts.forEachChild(node, visit);
      }
      visit(file);
    }
  }
  expect(violations).toEqual([]);
});
