import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const versionFiles = [
  'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json',
  'apps/desktop/extension/public/manifest.json', 'apps/desktop/src-tauri/Cargo.toml',
  'apps/desktop/src-tauri/Cargo.lock', 'bun.lock',
] as const;
export const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function parts(version: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid release version');
  const values = version.split('.').map(Number);
  if (values.some(value => value > 65535)) throw new Error('Version component exceeds browser extension limit; bump the minor version');
  return values;
}
const compare = (a: string, b: string) => {
  const x = parts(a), y = parts(b);
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
};
export function nextVersion(base: string, tags: string[]): string {
  parts(base);
  const versions = tags.filter(tag => /^v\d+\.\d+\.\d+$/.test(tag)).map(tag => tag.slice(1)).sort(compare);
  const latest = versions.at(-1);
  if (!latest || compare(base, latest) > 0) return base;
  const [major, minor, patch] = parts(latest);
  const version = `${major}.${minor}.${patch! + 1}`; parts(version); return version;
}

/** Update only our own version fields, preserving every dependency and lock entry. */
export function applyVersion(root: string, version: string): void {
  parts(version);
  const replacements = versionFiles.map(path => {
    const source = readFileSync(join(root, path), 'utf8');
    const pattern = path === 'bun.lock' ? /("apps\/desktop"\s*:\s*\{[^}]*?"version"\s*:\s*")[^"]+/
      : path.endsWith('Cargo.lock') ? /(\[\[package\]\]\r?\nname = "onewarden"\r?\nversion = ")[^"]+/
      : path.endsWith('Cargo.toml') ? /(\[package\][\s\S]*?\r?\nversion = ")[^"]+/
      : /("version"\s*:\s*")[^"]+/;
    if (!pattern.test(source)) throw new Error(`Missing version field: ${path}`);
    return [path, source.replace(pattern, (_match, prefix: string) => `${prefix}${version}`)] as const;
  });
  for (const [path, contents] of replacements) writeFileSync(join(root, path), contents);
}

/** Stage the same version-only tree in every job; no remote writes before CI passes. */
export function prepareVersion(root: string, sourceSha: string): { version: string; tree: string } {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || git(root, 'rev-parse', 'HEAD') !== sourceSha) throw new Error('Unexpected release source');
  const tags = git(root, 'tag', '--list', 'v*').split('\n').filter(Boolean);
  const retry = tags.find(tag => /^v\d+\.\d+\.\d+$/.test(tag)
    && git(root, 'show', '-s', '--format=%P', tag) === sourceSha
    && git(root, 'show', '-s', '--format=%B', tag).split('\n').includes(`Release-Source: ${sourceSha}`));
  const base = JSON.parse(readFileSync(join(root, versionFiles[0]), 'utf8')).version;
  const version = retry ? retry.slice(1) : nextVersion(base, tags);
  applyVersion(root, version);
  git(root, 'add', '--', ...versionFiles);
  const tree = git(root, 'write-tree');
  if (retry && git(root, 'rev-parse', `${retry}^{tree}`) !== tree) throw new Error('Previously released tree does not match this source');
  return { version, tree };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  if (process.argv[2] === 'apply') {
    applyVersion(root, process.env.APP_VERSION ?? '');
  } else if (process.argv[2] === 'prepare') {
    if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Only main pushes prepare automatic releases');
    const result = prepareVersion(root, process.env.GITHUB_SHA ?? '');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ntree=${result.tree}\n`);
    console.log(`Prepared v${result.version}: ${result.tree}`);
  } else throw new Error('Expected prepare or apply');
}
