import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const native = 'apps/desktop/src-tauri/icons';
const extension = 'apps/desktop/extension/public/icons';
const read = (path: string) => readFileSync(resolve(path));

/** Small dependency-free decoder for the non-interlaced, 8-bit RGB(A) PNGs
 * exported by Tauri. Checking decoded pixels catches painted checkerboards;
 * merely checking for an alpha channel does not establish transparency. */
function png(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(bytes[24], 'PNG bit depth').toBe(8);
  expect([2, 6], 'RGB or RGBA').toContain(bytes[25]);
  expect([...bytes.subarray(26, 29)], 'compression/filter/interlace').toEqual([0, 0, 0]);
  const channels = bytes[25] === 6 ? 4 : 3;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const scanlines = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  expect(scanlines.length).toBe((stride + 1) * height);
  const decoded = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = scanlines[y * (stride + 1)];
    expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? decoded[y * stride + x - channels] : 0;
      const above = y > 0 ? decoded[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? decoded[(y - 1) * stride + x - channels] : 0;
      const adjustment = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][filter];
      decoded[y * stride + x] = (scanlines[y * (stride + 1) + x + 1] + adjustment) & 255;
    }
  }
  const pixel = (x: number, y: number): [number, number, number, number] => {
    const offset = (y * width + x) * channels;
    return [decoded[offset], decoded[offset + 1], decoded[offset + 2], channels === 4 ? decoded[offset + 3] : 255];
  };
  return { width, height, channels, pixel };
}

function transparentCorners(image: ReturnType<typeof png>) {
  const { width, height, pixel } = image;
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
    expect(pixel(x, y)[3], `alpha at ${x},${y}`).toBe(0);
  }
  expect(pixel(Math.floor(width / 2), Math.floor(height / 2))[3]).toBe(255);
}

function ivoryComponents(image: ReturnType<typeof png>) {
  const { width, height, pixel } = image;
  const pending = new Set<number>();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b, a] = pixel(x, y);
    if (r > 210 && g > 210 && b > 180 && a === 255) pending.add(y * width + x);
  }
  const components: number[][] = [];
  while (pending.size) {
    const first = pending.values().next().value!;
    pending.delete(first);
    const component = [first];
    for (let cursor = 0; cursor < component.length; cursor++) {
      const x = component[cursor] % width, y = Math.floor(component[cursor] / width);
      // Eight neighbours: even a diagonal bridge would make the numeral merge.
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (pending.delete(next)) component.push(next);
      }
    }
    components.push(component);
  }
  return components.sort((a, b) => b.length - a.length);
}

describe('production icon pixels and platform containers', () => {
  it.each([16, 24, 32, 48, 64, 128])('exports a genuinely transparent %i px extension icon', size => {
    const image = png(read(`${extension}/${size}.png`));
    expect([image.width, image.height]).toEqual([size, size]);
    transparentCorners(image);
  });

  it.each([16, 24, 32, 48])('keeps the numeral separate from its shield at %i px', size => {
    const image = png(read(`${extension}/${size}.png`));
    const components = ivoryComponents(image);
    expect(components).toHaveLength(2);
    const numeral = components[1];
    expect(numeral.length).toBeGreaterThanOrEqual(10);
    expect(numeral.every(index => {
      const x = index % size, y = Math.floor(index / size);
      return x > size * 0.3 && x < size * 0.7 && y > size * 0.2 && y < size * 0.7;
    })).toBe(true);
  });

  it('packages each Windows ICO resolution with the matching exported pixels', () => {
    const bytes = read(`${native}/icon.ico`);
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    expect([...bytes.subarray(0, 6)]).toEqual([0, 0, 1, 0, sizes.length, 0]);
    let end = 6 + sizes.length * 16;
    sizes.forEach((size, index) => {
      const entry = 6 + index * 16;
      expect([bytes[entry] || 256, bytes[entry + 1] || 256]).toEqual([size, size]);
      expect(bytes.readUInt16LE(entry + 4)).toBe(1);
      expect(bytes.readUInt16LE(entry + 6)).toBe(32);
      const length = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12);
      expect(offset).toBe(end);
      const payload = bytes.subarray(offset, offset + length);
      const image = png(payload);
      expect([image.width, image.height]).toEqual([size, size]);
      transparentCorners(image);
      if (size <= 128) expect(payload).toEqual(read(`${extension}/${size}.png`));
      end += length;
    });
    expect(end).toBe(bytes.length);
  });

  it('provides regular and Retina ICNS entries with valid PNG payloads', () => {
    const bytes = read(`${native}/icon.icns`);
    expect(bytes.toString('ascii', 0, 4)).toBe('icns');
    expect(bytes.readUInt32BE(4)).toBe(bytes.length);
    const expected = new Map([
      ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256],
      ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64],
    ]);
    let offset = 8;
    while (offset < bytes.length) {
      const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32BE(offset + 4);
      const image = png(bytes.subarray(offset + 8, offset + length));
      expect([image.width, image.height]).toEqual([expected.get(type), expected.get(type)]);
      transparentCorners(image);
      expected.delete(type);
      offset += length;
    }
    expect(expected.size).toBe(0);
    expect(offset).toBe(bytes.length);
  });

  it('keeps shared UI, favicon and tray exports connected to the production sources', () => {
    expect(read('apps/desktop/public/brand/mark.svg')).toEqual(read('logos/production/compact.svg'));
    expect(read('packages/ui/src/brand/app.png')).toEqual(read('apps/desktop/public/brand/256.png'));
    expect(read('packages/ui/src/brand/compact.png')).toEqual(read('logos/production/compact-128.png'));
    expect(read(`${native}/tray-color.png`)).toEqual(read(`${extension}/32.png`));
    const image = png(read(`${native}/tray-template.png`));
    expect([image.width, image.height]).toEqual([32, 32]);
    let painted = 0, transparent = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const [r, g, b, a] = image.pixel(x, y);
      if (a > 0) { expect([r, g, b, a]).toEqual([0, 0, 0, 255]); painted++; }
      else transparent++;
    }
    expect(painted).toBeGreaterThan(0);
    expect(transparent).toBeGreaterThan(painted);
  });

  it('flattens every iOS catalog entry onto opaque navy at its exact pixel size', () => {
    const catalog = 'apps/desktop/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset';
    const { images } = JSON.parse(read(`${catalog}/Contents.json`).toString('utf8')) as {
      images: { filename?: string; size: string; scale: string }[];
    };
    for (const entry of images) {
      if (!entry.filename) continue;
      const size = parseFloat(entry.size) * parseFloat(entry.scale);
      const image = png(read(`${catalog}/${entry.filename}`));
      expect([image.width, image.height], entry.filename).toEqual([size, size]);
      // RGB-only export: no alpha channel is permitted in the iOS app icon.
      expect(image.channels, entry.filename).toBe(3);
      expect(image.pixel(0, 0), entry.filename).toEqual([27, 39, 52, 255]);
    }
  });
});
