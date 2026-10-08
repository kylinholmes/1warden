#!/usr/bin/env bun
/** Deterministic platform exports from the approved, editable pixel-grid artwork.
 * No network, image-model calls or private data. Keep original design drafts intact.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const root = resolve(import.meta.dir, '..');
const desktop = join(root, 'apps/desktop');
const output = mkdtempSync(join(tmpdir(), '1warden-icon-export-'));
function render(source: string, sizes: number[], name: string) {
  const dir = join(output, name);
  const result = spawnSync(process.execPath, ['run', '--cwd', desktop, 'tauri', 'icon',
    join(root, 'logos/production', source), '--output', dir,
    ...sizes.flatMap(size => ['--png', String(size)])], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw Error(`Icon conversion failed: ${source}`);
  return (size: number) => readFileSync(join(dir, `${size}x${size}.png`));
}
function save(path: string, data: Uint8Array) {
  const target = resolve(root, path);
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, data);
}

/** Tauri currently emits RGBA even after --ios-color compositing. App Store
 * icons must have no alpha channel. Decode its 8-bit PNG, composite any remaining
 * transparency onto navy, then encode RGB. Merely dropping A would expose the
 * undefined RGB values of transparent pixels and produce black corners. */
function opaqueIosPng(png: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!png.subarray(0, 8).equals(signature) || png[24] !== 8
    || ![2, 6].includes(png[25]) || png[26] !== 0 || png[27] !== 0 || png[28] !== 0) {
    throw Error('Expected non-interlaced 8-bit RGB(A) PNG from Tauri');
  }
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const channels = png[25] === 6 ? 4 : 3;
  const stride = width * channels;
  const parts: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      parts.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const filtered = inflateSync(Buffer.concat(parts));
  if (filtered.length !== (stride + 1) * height) throw Error('Unexpected PNG scanline length');
  const pixels = Buffer.alloc(stride * height);
  function paeth(a: number, b: number, c: number) {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  }
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    if (filter > 4) throw Error(`Unsupported PNG filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const above = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const correction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above
        : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      pixels[y * stride + x] = (filtered[y * (stride + 1) + x + 1] + correction) & 255;
    }
  }
  const rgbStride = width * 3;
  const rgb = Buffer.alloc((rgbStride + 1) * height); // Filter byte 0 for each row.
  const navy = [27, 39, 52];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = y * stride + x * channels;
    const alpha = channels === 4 ? pixels[source + 3] / 255 : 1;
    const target = y * (rgbStride + 1) + 1 + x * 3;
    for (let channel = 0; channel < 3; channel++) {
      rgb[target + channel] = Math.round(pixels[source + channel] * alpha + navy[channel] * (1 - alpha));
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
  function chunk(type: string, data: Buffer) {
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0); result.write(type, 4, 'ascii'); data.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, 8 + data.length)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(rgb, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const large = render('app.svg', sizes.filter(size => size >= 64), 'app');
const small = render('compact.svg', [16, 24, 32, 48, 64, 128], 'compact');
const template = render('tray-template.svg', [16, 32], 'template');
const icon = (size: number) => size <= 48 ? small(size) : large(size);
const native = 'apps/desktop/src-tauri/icons';

// ICO: embed a PNG at each native resolution, using the optical variant below 64px.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoHeader = Buffer.alloc(6 + icoSizes.length * 16);
icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(icoSizes.length, 4);
let offset = icoHeader.length;
const icoImages = icoSizes.map((size, index) => {
  const png = icon(size); const entry = 6 + index * 16;
  icoHeader[entry] = icoHeader[entry + 1] = size === 256 ? 0 : size;
  icoHeader.writeUInt16LE(1, entry + 4); icoHeader.writeUInt16LE(32, entry + 6);
  icoHeader.writeUInt32LE(png.length, entry + 8); icoHeader.writeUInt32LE(offset, entry + 12);
  offset += png.length; return png;
});
save(`${native}/icon.ico`, Buffer.concat([icoHeader, ...icoImages]));

// Modern ICNS supports PNG payloads, including Retina representations.
const icnsTypes: [string, number, boolean][] = [
  ['icp4', 16, true], ['icp5', 32, true], ['icp6', 64, false],
  ['ic07', 128, false], ['ic08', 256, false], ['ic09', 512, false],
  ['ic10', 1024, false], ['ic11', 32, true], ['ic12', 64, true],
];
const chunks = icnsTypes.map(([type, size, compact]) => {
  const png = compact ? small(size) : large(size); const header = Buffer.alloc(8);
  header.write(type, 0, 'ascii'); header.writeUInt32BE(8 + png.length, 4);
  return Buffer.concat([header, png]);
});
const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns', 0, 'ascii');
icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
save(`${native}/icon.icns`, Buffer.concat([icnsHeader, ...chunks]));
save(`${native}/icon.png`, large(512));
save(`${native}/tray-color.png`, small(32));
save(`${native}/tray-template.png`, template(32));

for (const size of [16, 24, 32, 48, 64, 128]) {
  save(`apps/desktop/extension/public/icons/${size}.png`, icon(size));
}
for (const size of [32, 64, 128, 256]) {
  save(`apps/desktop/public/brand/${size}.png`, icon(size));
}
save('packages/ui/src/brand/compact.png', small(128));
save('packages/ui/src/brand/app.png', large(256));
save('logos/production/app-1024.png', large(1024));
save('logos/production/compact-128.png', small(128));
save('logos/production/tray-template-32.png', template(32));
// Ask Tauri to composite iOS onto navy, then remove the alpha channel reliably.
// Match the existing Xcode asset catalog by dimensions, not generator filenames.
const platformOutput = join(output, 'platforms');
const platforms = spawnSync(process.execPath, ['run', '--cwd', desktop, 'tauri', 'icon',
  join(root, 'logos/production/app.svg'), '--output', platformOutput, '--ios-color', '#1B2734'],
{ stdio: 'inherit', windowsHide: true });
if (platforms.status !== 0) throw Error('Platform icon conversion failed');
const iosPngs = new Map<number, Buffer>();
for (const file of readdirSync(join(platformOutput, 'ios'))) {
  if (!file.endsWith('.png')) continue;
  const png = readFileSync(join(platformOutput, 'ios', file));
  iosPngs.set(png.readUInt32BE(16), opaqueIosPng(png));
}
const catalogPath = 'apps/desktop/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset';
const catalog = JSON.parse(readFileSync(join(root, catalogPath, 'Contents.json'), 'utf8'));
for (const entry of catalog.images) {
  if (!entry.filename) continue;
  const size = parseFloat(entry.size) * parseFloat(entry.scale);
  const png = iosPngs.get(size);
  if (!png) throw Error(`Missing iOS icon size ${size}`);
  save(`${catalogPath}/${entry.filename}`, png);
}
// Save a shared source too, useful for websites without a JS bundler.
copyFileSync(join(root, 'logos/production/compact.svg'), join(desktop, 'public/brand/mark.svg'));
console.log(`Exported desktop, extension, iOS, shared UI and tray icons. Intermediate PNGs: ${output}`);
