// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FloatingPanel } from '@1warden/ui';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it.each([true, false])('releases retained panels promptly when reduced motion is %s at close', async reduceAtClose => {
  vi.useFakeTimers();
  const listeners = new Set<() => void>();
  const media = { matches: reduceAtClose, addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
  vi.stubGlobal('matchMedia', () => media);
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = (open: boolean) => root.render(<FloatingPanel open={open} onClose={() => {}} labelledBy="test-title"><h2 id="test-title">Synthetic panel</h2></FloatingPanel>);
  try {
    await act(() => render(true)); expect(document.activeElement?.getAttribute('role')).toBe('dialog');
    await act(() => render(false));
    expect(document.activeElement).toBe(opener);
    if (!reduceAtClose) {
      expect(host.querySelector('.panel-out')).not.toBeNull();
      // A live preference change must finish an exit that started with motion.
      await act(() => { media.matches = true; for (const listener of listeners) listener(); });
    }
    expect(host.querySelector('.floating-layer')).toBeNull();
    expect(listeners.size).toBe(0);
    await act(() => render(true));
    await act(() => vi.advanceTimersByTime(450));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  } finally { await act(() => root.unmount()); host.remove(); opener.remove(); }
});
