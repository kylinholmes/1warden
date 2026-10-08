import { describe, expect, it, vi } from 'vitest';
import { describeDevice, deviceIdentity } from './device-info';
describe('self-reported devices', () => {
  const desktop = { native: true, browser: false, saveAttachments: true };
  it('distinguishes desktop and extension on the same OS without storing the raw UA', () => {
    const ua = 'Mozilla Windows NT 10.0 Chrome/120 Edg/120';
    expect(describeDevice('id', desktop, ua)).toEqual({ id: 'id', name: 'Windows · 桌面端', client: 'desktop', platform: 'windows' });
    expect(describeDevice('id', { ...desktop, native: false, browser: true }, ua).name).toBe('Windows · Edge');
  });
  it('recognizes iPad desktop UA as iOS, not macOS', () => {
    expect(describeDevice('id', { ...desktop, native: false }, 'Mozilla Macintosh Safari', 5).platform).toBe('ios');
  });
  it('reuses a stored random installation ID and fails closed if storage is unavailable', () => {
    const store = { getItem: vi.fn(() => 'stable-id'), setItem: vi.fn() };
    const random = vi.fn(() => 'new-id');
    expect(deviceIdentity(store, random)).toBe('stable-id'); expect(random).not.toHaveBeenCalled();
    expect(() => deviceIdentity({ ...store, getItem: () => { throw Error('blocked'); } }, random)).toThrow('blocked');
  });
});
