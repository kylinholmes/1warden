import { useLayoutEffect } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';

/** Layout follows usable viewport width, never OS, build target, or orientation.
 * 900px leaves room for navigation, a list, and a readable detail pane.
 * Keep components.css media queries in sync; the wiring test guards this contract.
 */
export const COMPACT_LAYOUT_QUERY = '(width < 900px)';

export function isCompactLayout(): boolean {
  return globalThis.matchMedia?.(COMPACT_LAYOUT_QUERY).matches ?? false;
}

export function subscribeLayout(listener: () => void): () => void {
  const query = globalThis.matchMedia?.(COMPACT_LAYOUT_QUERY);
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
}

export function useCompactLayout(): boolean {
  const store = useLocalStore(() => ({ compact: isCompactLayout() }));
  const [compact, setCompact] = useStoreField(store, 'compact');
  useLayoutEffect(() => {
    const refresh = () => setCompact(isCompactLayout());
    const stop = subscribeLayout(refresh); refresh(); return stop;
  }, [setCompact]);
  return compact;
}
