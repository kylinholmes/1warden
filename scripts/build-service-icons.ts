#!/usr/bin/env bun
/** Vendor curated official artwork and Simple Icons paths. Normal app builds are offline.
 * This explicit maintenance command fetches public artwork, never vault data.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SERVICE_BRANDS } from '../packages/ui/src/service-brands/catalog';
import { OFFICIAL_ARTWORK, type OfficialArtwork } from '../packages/ui/src/service-brands/overrides';

const VERSION = '16.34.0';
const CDN = `https://cdn.jsdelivr.net/npm/simple-icons@${VERSION}`;
const output = resolve(import.meta.dir, '../packages/ui/src/service-brands');
type Metadata = {
  title: string; slug: string; hex: string; source: string;
  guidelines?: string; license?: { type: string; url?: string };
};

async function download(path: string): Promise<string> {
  const response = await fetch(`${CDN}/${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Error(`Simple Icons ${path}: HTTP ${response.status}`);
  return response.text();
}

const [metadataJson, license, disclaimer] = await Promise.all([
  download('data/simple-icons.json'), download('LICENSE.md'), download('DISCLAIMER.md'),
]);
const metadata = new Map((JSON.parse(metadataJson) as Metadata[]).map(icon => [icon.slug, icon]));
const icons: Record<string, { name: string; color: string; path: string }> = {};
const sources: Record<string, Metadata | (OfficialArtwork & { sha256: string })> = {};
const assets = new Map<string, { file: string; bytes: Uint8Array }>();

async function officialAsset(asset: OfficialArtwork): Promise<Uint8Array> {
  if (!/^(?:assets\/)?[a-z0-9-]+\.(png|ico|webp|svg)$/.test(asset.file)) throw Error(`Invalid asset file: ${asset.file}`);
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Error(`${asset.name}: HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw Error(`Empty asset: ${asset.name}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 512_000) { await reader.cancel(); throw Error(`Oversized asset: ${asset.name}`); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const starts = (header: number[], offset = 0) => header.every((byte, i) => bytes[offset + i] === byte);
  const text = new TextDecoder().decode(bytes);
  const valid = asset.file.endsWith('.png') ? starts([137, 80, 78, 71, 13, 10, 26, 10])
    : asset.file.endsWith('.ico') ? starts([0, 0, 1, 0])
    : asset.file.endsWith('.webp') ? starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)
    : /<svg\b/.test(text) && !/<(?:script|foreignObject|image|iframe|object|use|style)\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=|<!DOCTYPE|<!ENTITY|url\(\s*["']?(?!#)/i.test(text);
  if (!size || !valid) throw Error(`Unexpected image format or unsafe SVG: ${asset.name} (${asset.file})`);
  return bytes;
}

// Bound network concurrency. Generate everything successfully before touching assets.
for (let index = 0; index < SERVICE_BRANDS.length; index += 6) {
  await Promise.all(SERVICE_BRANDS.slice(index, index + 6).map(async brand => {
    const official = OFFICIAL_ARTWORK[brand.id];
    if (official) {
      const bytes = await officialAsset(official);
      assets.set(brand.id, { file: official.file, bytes });
      icons[brand.id] = { name: official.name, color: '#000000', path: '' };
      sources[brand.id] = { ...official, sha256: createHash('sha256').update(bytes).digest('hex') };
      return;
    }
    const meta = metadata.get(brand.id);
    if (!meta || !/^[0-9A-F]{6}$/i.test(meta.hex)) throw Error(`Missing metadata: ${brand.id}`);
    const svg = await download(`icons/${brand.id}.svg`);
    // Import geometry only, never upstream SVG markup, scripts or external references.
    const paths = [...svg.matchAll(/<path d="([^"]+)"\s*\/>/g)];
    if (!svg.includes('viewBox="0 0 24 24"') || paths.length !== 1
      || !/^[MmZzLlHhVvCcSsQqTtAaEe\d.,+\s-]+$/.test(paths[0]![1]!)) {
      throw Error(`Unexpected SVG geometry: ${brand.id}`);
    }
    icons[brand.id] = { name: meta.title, color: `#${meta.hex}`, path: paths[0]![1]! };
    sources[brand.id] = meta;
  }));
}

const orderedIcons = Object.fromEntries(SERVICE_BRANDS.map(({ id }) => [id, icons[id]]));
const orderedSources = Object.fromEntries(SERVICE_BRANDS.map(({ id }) => [id, sources[id]]));
mkdirSync(output, { recursive: true });
const orderedAssets = SERVICE_BRANDS.flatMap(({ id }) => assets.has(id) ? [{ id, ...assets.get(id)! }] : []);
for (const asset of orderedAssets) {
  const path = resolve(output, asset.file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, asset.bytes);
}
writeFileSync(resolve(output, 'local-assets.ts'),
  '// Generated by bun run build:service-icons; unmodified official site artwork.\n'
  + orderedAssets.map(({ id, file }) => `import ${id} from './${file}';`).join('\n')
  + '\nexport const LOCAL_ASSETS: Readonly<Partial<Record<string, string>>> = {\n'
  + orderedAssets.map(({ id }) => `  ${id},`).join('\n') + '\n};\n');
writeFileSync(resolve(output, 'artwork.ts'),
  `// Generated by bun run build:service-icons. Simple Icons ${VERSION}; see README.md.\n`
  + `export const SERVICE_ARTWORK = ${JSON.stringify(orderedIcons, null, 2)} as const;\n`);
writeFileSync(resolve(output, 'sources.json'), JSON.stringify({ version: VERSION, icons: orderedSources }, null, 2) + '\n');
writeFileSync(resolve(output, 'LICENSE.simple-icons.md'), license);
writeFileSync(resolve(output, 'DISCLAIMER.simple-icons.md'), disclaimer);
console.log(`Vendored ${SERVICE_BRANDS.length} service icons: ${assets.size} official assets + ${SERVICE_BRANDS.length - assets.size} Simple Icons ${VERSION} paths.`);
