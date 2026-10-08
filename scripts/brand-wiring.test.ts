import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const json = (path: string) => JSON.parse(read(path));
const desktop = 'apps/desktop';
const native = `${desktop}/src-tauri`;

describe('fresh 1Warden application identity', () => {
  it('uses the same package scope in each workspace', () => {
    for (const name of ['api', 'crypto', 'state', 'ui', 'vault']) {
      expect(json(`packages/${name}/package.json`).name).toBe(`@1warden/${name}`);
    }
    expect(json(`${desktop}/package.json`).name).toBe('@1warden/desktop');
  });

  it('keeps native executable and Rust identifiers valid and connected', () => {
    const config = json(`${native}/tauri.conf.json`);
    expect(config).toMatchObject({ productName: '1Warden', identifier: 'app.onewarden.desktop', mainBinaryName: '1warden' });
    const cargo = read(`${native}/Cargo.toml`).replace(/^#.*$/gm, '');
    expect(cargo).toMatch(/\[package\][\s\S]*?name = "onewarden"/);
    expect(cargo).toMatch(/\[\[bin\]\]\s*name = "1warden"\s*path = "src\/main.rs"/);
    expect(cargo).toMatch(/\[lib\]\s*name = "onewarden_lib"/);
    expect(read(`${native}/src/main.rs`)).toContain('onewarden_lib::run()');
    expect(read(`${native}/Cargo.lock`)).toContain('name = "onewarden"');
  });

  it('pins the unpacked Chromium identity with a public key, not a signing secret', () => {
    const manifest = json(`${desktop}/extension/public/manifest.json`);
    expect(manifest.name).toBe('1Warden');
    const der = Buffer.from(manifest.key, 'base64');
    const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
    expect(key.asymmetricKeyType).toBe('rsa');
    expect(key.type).toBe('public');
    const id = createHash('sha256').update(der).digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
    expect(id).toBe('eceecdljohcknjkdfllnjlifehffcain');
  });

  it('retains renamed iOS source, metadata and scheme paths', () => {
    const apple = `${native}/gen/apple`;
    for (const path of [
      'Sources/onewarden/main.mm', 'Sources/onewarden/bindings/bindings.h',
      'onewarden_iOS/Info.plist', 'onewarden_iOS/onewarden_iOS.entitlements',
      'onewarden.xcodeproj/project.pbxproj',
      'onewarden.xcodeproj/xcshareddata/xcschemes/onewarden_iOS.xcscheme',
    ]) expect(existsSync(resolve(apple, path)), path).toBe(true);
    expect(read(`${apple}/project.yml`)).toContain('PRODUCT_BUNDLE_IDENTIFIER: app.onewarden.desktop');
    expect(read(`${apple}/Podfile`)).toContain('onewarden_iOS');
    expect(read(`${apple}/onewarden.xcodeproj/project.pbxproj`)).toContain('path = "1Warden.app";');
    expect(read(`${apple}/onewarden.xcodeproj/xcshareddata/xcschemes/onewarden_iOS.xcscheme`)).toContain('BuildableName = "1Warden.app"');
  });
});
