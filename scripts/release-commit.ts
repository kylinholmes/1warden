import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyVersion, git, versionFiles } from './release-version';

interface ReleasePlan { version: string; tree: string; sourceSha: string }
/** Called only by the successful main release job. Atomic, fast-forward-only writes. */
export function prepareReleaseCommit(root: string, { version, tree, sourceSha }: ReleasePlan) {
  if (!/^[a-f0-9]{40}$/.test(tree) || !/^[a-f0-9]{40}$/.test(sourceSha)
    || git(root, 'rev-parse', 'HEAD') !== sourceSha) throw new Error('Unexpected release source/tree');
  applyVersion(root, version); git(root, 'add', '--', ...versionFiles);
  if (git(root, 'write-tree') !== tree) throw new Error('Release contents differ from the tree tested by CI');
  git(root, 'fetch', 'origin', 'main', '--tags');
  const remoteHead = git(root, 'ls-remote', '--heads', 'origin', 'refs/heads/main').split(/\s/)[0];
  const tag = `v${version}`;
  let commit: string;
  if (git(root, 'tag', '--list', tag)) {
    commit = git(root, 'rev-parse', `${tag}^{commit}`);
    const parent = git(root, 'show', '-s', '--format=%P', commit);
    // A failed-jobs retry retains its old check outputs. A newer main may have
    // legitimately published that planned version while this run was failed.
    if (parent !== sourceSha && remoteHead !== sourceSha) return { publish: false, commit, tag };
    if (parent !== sourceSha
      || git(root, 'rev-parse', `${commit}^{tree}`) !== tree
      || !git(root, 'show', '-s', '--format=%B', commit).split('\n').includes(`Release-Source: ${sourceSha}`)) {
      throw new Error('Existing release tag belongs to a different source/tree');
    }
    return { publish: remoteHead === commit, commit, tag };
  }
  if (remoteHead !== sourceSha) return { publish: false, commit: sourceSha, tag };
  git(root, '-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '--allow-empty', '-m', `chore: release ${tag}\n\nRelease-Source: ${sourceSha}`);
  commit = git(root, 'rev-parse', 'HEAD'); git(root, 'tag', tag);
  // gh reads GH_TOKEN itself; no token is put in git configuration or command arguments.
  git(root, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    'push', '--atomic', 'origin', `${commit}:refs/heads/main`, `refs/tags/${tag}`);
  return { publish: true, commit, tag };
}

if (import.meta.main) {
  if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Only main pushes can publish');
  const result = prepareReleaseCommit(resolve(import.meta.dir, '..'), {
    version: process.env.APP_VERSION ?? '', tree: process.env.RELEASE_TREE ?? '', sourceSha: process.env.GITHUB_SHA ?? '',
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `publish=${result.publish}\ncommit=${result.commit}\ntag=${result.tag}\n`);
  console.log(result.publish ? `Ready to publish ${result.tag} at ${result.commit}` : 'Skipped an obsolete main build');
}
