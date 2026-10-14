import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyVersion, nextVersion, prepareVersion, versionFiles } from './release-version';
import { prepareReleaseCommit } from './release-commit';

const directories: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'onewarden-release-')); directories.push(root);
  const files: Record<string, string> = {
    'apps/desktop/package.json': '{"name":"@1warden/desktop","version":"0.2.1"}\n',
    'apps/desktop/src-tauri/tauri.conf.json': '{"version":"0.2.1"}\n',
    'apps/desktop/extension/public/manifest.json': '{"version":"0.2.1"}\n',
    'apps/desktop/src-tauri/Cargo.toml': '[package]\nname = "onewarden"\nversion = "0.2.1"\n',
    'apps/desktop/src-tauri/Cargo.lock': '[[package]]\nname = "dependency"\nversion = "0.2.1"\n\n[[package]]\nname = "onewarden"\nversion = "0.2.1"\n',
    'bun.lock': '{\n  "workspaces": {\n    "apps/desktop": {\n      "name": "@1warden/desktop",\n      "version": "0.2.1",\n    },\n  },\n}\n',
  };
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'source'); git(root, 'tag', 'v0.2.1');
  return root;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('automatic release versions', () => {
  it('increments the highest published patch numerically and allows an explicit new minor', () => {
    expect(nextVersion('0.2.1', ['v0.2.9', 'v0.2.10', 'unrelated', 'v0.3.0-beta'])).toBe('0.2.11');
    expect(nextVersion('0.3.0', ['v0.2.10'])).toBe('0.3.0');
    expect(nextVersion('0.2.1', [])).toBe('0.2.1');
    expect(() => nextVersion('0.2.65535', ['v0.2.65535'])).toThrow();
  });
  it('updates all package and lockfile versions without touching dependency versions', () => {
    const root = fixture(); applyVersion(root, '0.2.2');
    for (const file of versionFiles) expect(readFileSync(join(root, file), 'utf8')).toContain('0.2.2');
    expect(readFileSync(join(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8')).toContain('name = "dependency"\nversion = "0.2.1"');
    expect(git(root, 'diff', '--name-only').split('\n').sort()).toEqual([...versionFiles].sort());
    expect(() => applyVersion(root, '0.2.2\nmalicious')).toThrow();
  });
  it('reuses the tested version tree when the same main CI is retried after publishing', () => {
    const root = fixture(); const source = git(root, 'rev-parse', 'HEAD');
    const first = prepareVersion(root, source);
    expect(first.version).toBe('0.2.2');
    git(root, 'commit', '-qm', `chore: release v0.2.2\n\nRelease-Source: ${source}`); git(root, 'tag', 'v0.2.2');
    git(root, 'checkout', '--detach', source);
    expect(prepareVersion(root, source)).toEqual(first);
  });
  it('recovers after main and tag were pushed but asset publication failed, without another version commit', () => {
    const root = fixture(); const remote = mkdtempSync(join(tmpdir(), 'onewarden-remote-')); directories.push(remote);
    git(remote, 'init', '--bare'); git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', 'origin', 'main', '--tags');
    const sourceSha = git(root, 'rev-parse', 'HEAD'); const plan = prepareVersion(root, sourceSha);
    const first = prepareReleaseCommit(root, { ...plan, sourceSha });
    expect(first.publish).toBe(true);
    expect(git(root, 'rev-parse', 'v0.2.2^')).toBe(sourceSha);
    git(root, 'checkout', '--detach', sourceSha);
    const retried = prepareVersion(root, sourceSha);
    expect(retried).toEqual(plan);
    expect(prepareReleaseCommit(root, { ...retried, sourceSha })).toEqual(first);
    expect(git(remote, 'rev-parse', 'main')).toBe(first.commit);
    expect(git(root, 'tag', '--list', 'v0.2.*').split('\n')).toEqual(['v0.2.1', 'v0.2.2']);
  });
  it('does not overwrite main or tag a stale build after newer source arrives', () => {
    const root = fixture(); const remote = mkdtempSync(join(tmpdir(), 'onewarden-remote-')); directories.push(remote);
    git(remote, 'init', '--bare'); git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', 'origin', 'main', '--tags');
    const sourceSha = git(root, 'rev-parse', 'HEAD'); const plan = prepareVersion(root, sourceSha);
    git(root, 'reset', '--hard', sourceSha); git(root, 'commit', '--allow-empty', '-qm', 'newer source'); git(root, 'push', '-q', 'origin', 'main');
    const newer = git(root, 'rev-parse', 'HEAD'); git(root, 'checkout', '--detach', sourceSha);
    expect(prepareReleaseCommit(root, { ...plan, sourceSha }).publish).toBe(false);
    expect(git(remote, 'rev-parse', 'main')).toBe(newer);
    expect(git(remote, 'tag', '--list', 'v0.2.2')).toBe('');
  });
  it('skips an old failed-jobs rerun whose planned version was already published by newer main', () => {
    const root = fixture(); const remote = mkdtempSync(join(tmpdir(), 'onewarden-remote-')); directories.push(remote);
    git(remote, 'init', '--bare'); git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', 'origin', 'main', '--tags');
    const oldSource = git(root, 'rev-parse', 'HEAD'); const oldPlan = prepareVersion(root, oldSource);
    git(root, 'reset', '--hard', oldSource); git(root, 'commit', '--allow-empty', '-qm', 'newer source'); git(root, 'push', '-q', 'origin', 'main');
    const newSource = git(root, 'rev-parse', 'HEAD');
    const published = prepareReleaseCommit(root, { ...prepareVersion(root, newSource), sourceSha: newSource });
    expect(published.tag).toBe('v0.2.2');
    git(root, 'checkout', '--detach', oldSource);
    expect(prepareReleaseCommit(root, { ...oldPlan, sourceSha: oldSource }).publish).toBe(false);
    expect(git(remote, 'rev-parse', 'main')).toBe(published.commit);
  });
});
