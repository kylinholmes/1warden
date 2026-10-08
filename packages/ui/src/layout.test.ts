import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCompactLayout, subscribeLayout } from './layout';

afterEach(() => vi.unstubAllGlobals());
describe('available-width layout contract', () => {
  it.each([true, false])('uses available width, including when compact=%s', matches => {
    const matchMedia = vi.fn(() => ({ matches }));
    vi.stubGlobal('matchMedia', matchMedia);
    expect(isCompactLayout()).toBe(matches);
    expect(matchMedia).toHaveBeenCalledWith('(width < 900px)');
  });
  it('subscribes to width changes and cleans up its listener', () => {
    const media = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    const listener = vi.fn();
    const dispose = subscribeLayout(listener);
    expect(media.addEventListener).toHaveBeenCalledWith('change', listener);
    dispose();
    expect(media.removeEventListener).toHaveBeenCalledWith('change', listener);
  });
  it('has a safe server/test fallback', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(isCompactLayout()).toBe(false);
    expect(() => subscribeLayout(() => {})()).not.toThrow();
  });
});
