import { describe, it, expect, vi, afterEach } from 'vitest';
import { avatarCrop, normalizeAvatarView, loadProfileAvatar, INITIAL_AVATAR_VIEW } from './profile-avatar';
import config from '../../src-tauri/tauri.conf.json?raw';

afterEach(() => vi.unstubAllGlobals());
describe('avatar crop and native image loading', () => {
  it('centers landscape and portrait sources at minimum zoom', () => {
    expect(avatarCrop(600, 200, INITIAL_AVATAR_VIEW)).toEqual({ x: 200, y: 0, size: 200 });
    expect(avatarCrop(200, 600, INITIAL_AVATAR_VIEW)).toEqual({ x: 0, y: 200, size: 200 });
  });
  it('allows custom zoom and edges without revealing blank canvas', () => {
    expect(avatarCrop(600, 200, { x: 1, y: 0, zoom: 2 })).toEqual({ x: 500, y: 0, size: 100 });
    for (const x of [-10, 0, .5, 1, 10]) for (const y of [-10, 0, .5, 1, 10]) for (const zoom of [-1, 1, 2, 10]) {
      const view = normalizeAvatarView(200, 600, { x, y, zoom });
      const crop = avatarCrop(200, 600, view);
      expect(crop.x).toBeGreaterThanOrEqual(0); expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.size).toBeLessThanOrEqual(200); expect(crop.y + crop.size).toBeLessThanOrEqual(600);
      expect(view.zoom).toBeGreaterThanOrEqual(1); expect(view.zoom).toBeLessThanOrEqual(4);
    }
    expect(() => avatarCrop(0, 100, INITIAL_AVATAR_VIEW)).toThrow();
    expect(() => avatarCrop(100, 100, { ...INITIAL_AVATAR_VIEW, x: NaN })).toThrow();
  });
  it('decodes via data: allowed by native CSP, without broadening img-src', async () => {
    const conf = JSON.parse(config);
    expect(conf.app.security.csp['img-src']).toContain('data:');
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,AAAA'; onload = () => {};
      readAsDataURL() { this.onload(); }
    });
    vi.stubGlobal('Image', class {
      naturalWidth = 200; naturalHeight = 100; onload = () => {};
      set src(value: string) { expect(value.startsWith('data:')).toBe(true); this.onload(); }
    });
    await expect(loadProfileAvatar(new File(['data'], 'avatar.png', { type: 'image/png' }))).resolves.toMatchObject({ naturalWidth: 200 });
  });
  it('rejects unsupported and oversized files before decoding', async () => {
    await expect(loadProfileAvatar(new File(['x'], 'avatar.svg', { type: 'image/svg+xml' }))).rejects.toThrow(/JPG/);
    await expect(loadProfileAvatar({ type: 'image/jpeg', size: 11 * 1024 * 1024 } as File)).rejects.toThrow(/10 MB/);
  });
});
