#!/usr/bin/env bun
/** Package the same UI/runtime for Firefox's MV3 module event page. */
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { firefoxManifest } from './extension-manifest';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'apps/desktop/dist-extension');
const OUT = join(ROOT, 'apps/desktop/dist-firefox');

if (!existsSync(join(SRC, 'manifest.json'))) {
  throw new Error('找不到 Chrome 扩展构建，请先运行 bun run build:extension');
}

const source = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8')) as Record<string, unknown>;
const manifest = firefoxManifest(source);
const background = manifest['background'] as { scripts: string[] };
const action = manifest['action'] as { default_popup?: string } | undefined;
const content = (manifest['content_scripts'] ?? []) as { js?: string[]; css?: string[] }[];
const entryFiles = [
  ...background.scripts,
  ...(action?.default_popup ? [action.default_popup] : []),
  ...content.flatMap((script) => [...(script.js ?? []), ...(script.css ?? [])]),
];
for (const file of entryFiles) {
  if (!existsSync(join(SRC, file))) throw new Error(`扩展构建不完整：缺少 ${file}`);
}

// Validate before replacing an existing Firefox build; preserve the Chrome output.
rmSync(OUT, { recursive: true, force: true });
cpSync(SRC, OUT, { recursive: true });
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Firefox 扩展已构建：apps/desktop/dist-firefox');
console.log('about:debugging → 此 Firefox → 临时载入附加组件 → 选择 manifest.json');
