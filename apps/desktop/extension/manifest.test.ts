import { describe, expect, it } from 'vitest';
import manifestSource from './public/manifest.json?raw';
import { firefoxManifest } from '../../../scripts/extension-manifest';

const chromeManifest = JSON.parse(manifestSource) as Record<string, unknown> & { permissions: string[] };

describe('Firefox extension package', () => {
  it('uses a module event page without Chrome-only keys or permissions', () => {
    const result = firefoxManifest(chromeManifest);
    expect(result.background).toEqual({ scripts: ['background.js'], type: 'module' });
    expect(result).not.toHaveProperty('minimum_chrome_version');
    expect(result).not.toHaveProperty('key');
    expect(result.permissions).not.toContain('offscreen');
    expect(result.browser_specific_settings).toEqual({
      gecko: { id: '1warden@1warden.app', strict_min_version: '128.0' },
    });
  });

  it('preserves the UI, content scripts, CSP and shared permissions', () => {
    const source: Record<string, unknown> = { ...chromeManifest, permissions: [...chromeManifest.permissions, 'alarms'] };
    const original = JSON.stringify(source);
    const result = firefoxManifest(source);
    expect(result.action).toEqual(source.action);
    expect(result.content_scripts).toEqual(source.content_scripts);
    expect(result.content_security_policy).toEqual(source.content_security_policy);
    expect(result.host_permissions).toEqual(source.host_permissions);
    expect(result.permissions).toContain('alarms');
    expect(result.permissions).toContain('downloads');
    expect(result.permissions).toContain('clipboardRead');
    expect(result.permissions).toContain('clipboardWrite');
    expect(JSON.stringify(source)).toBe(original);
  });

  it('rejects an incompatible build instead of emitting a broken event page', () => {
    expect(() => firefoxManifest({ ...chromeManifest, manifest_version: 2 })).toThrow(/Manifest V3/);
    expect(() => firefoxManifest({ ...chromeManifest, background: {} })).toThrow(/service_worker/);
  });
});
