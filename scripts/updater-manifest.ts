import { resolve, join } from 'node:path';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

interface ManifestInput {
  version: string;
  repository: string;
  signature: string;
  pubDate: string;
}

export function createUpdaterManifest({ version, repository, signature, pubDate }: ManifestInput) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid updater version');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repository)) {
    throw new Error('Invalid GitHub repository');
  }
  signature = signature.trim();
  if (!signature || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length % 4 !== 0) {
    throw new Error('Missing or invalid updater signature');
  }
  return {
    version,
    notes: '重启 1Warden 完成更新。',
    pub_date: new Date(pubDate).toISOString(),
    platforms: {
      'darwin-aarch64': {
        url: `https://github.com/${repository}/releases/download/v${version}/1Warden-${version}-macos-apple-silicon.app.tar.gz`,
        signature,
      },
    },
  };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const directory = resolve(process.argv[2] ?? 'release-artifacts');
  const { version } = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'));
  if (process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('Updater release tag does not match package version');
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('Missing GitHub repository');
  const archive = join(directory, `1Warden-${version}-macos-apple-silicon.app.tar.gz`);
  if (!statSync(archive).isFile() || statSync(archive).size === 0) throw new Error('Missing updater archive');
  const signature = readFileSync(`${archive}.sig`, 'utf8');
  const manifest = createUpdaterManifest({ version, repository, signature, pubDate: new Date().toISOString() });
  writeFileSync(join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Created latest.json for ${version} (darwin-aarch64)`);
}
