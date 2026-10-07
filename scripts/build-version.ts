import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const readJson = async (path: string) => Bun.file(resolve(root, path)).json();
const [desktop, tauri, extension, cargoSource] = await Promise.all([
  readJson('apps/desktop/package.json'),
  readJson('apps/desktop/src-tauri/tauri.conf.json'),
  readJson('apps/desktop/extension/public/manifest.json'),
  Bun.file(resolve(root, 'apps/desktop/src-tauri/Cargo.toml')).text(),
]);
const cargo = Bun.TOML.parse(cargoSource) as { package: { version: string } };
const versions = [desktop.version, tauri.version, extension.version, cargo.package.version];
const version: string = versions[0];
if (!/^\d+\.\d+\.\d+$/.test(version) || versions.some((value) => value !== version)) {
  throw new Error(`Desktop, Tauri, extension and Cargo versions must match: ${versions.join(', ')}`);
}
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error(`Release tag must match the package version: v${version}`);
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
console.log(version);
