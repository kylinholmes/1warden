import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useCallback, useEffect, useLayoutEffect } from 'react';

/** Keep the last rendered value until its exit animation ends, including interrupted exits. */
export function useRetainedPresence<T>(value: T | null) {
  const viewStore = useLocalStore(() => {
    const retained = value;
    return { retained };
  });
  const [retained, setRetained] = useStoreField(viewStore, 'retained');
  useLayoutEffect(() => { if (value !== null) setRetained(value); }, [value, setRetained]);
  const leaving = value === null && retained !== null;
  useEffect(() => {
    if (!leaving) return;
    const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    const finishWithoutMotion = () => { if (media?.matches) setRetained(null); };
    finishWithoutMotion();
    media?.addEventListener('change', finishWithoutMotion);
    // animationend is primary; this also handles hidden elements and disabled animations.
    const timer = media?.matches ? undefined : setTimeout(() => setRetained(null), 400);
    return () => { clearTimeout(timer); media?.removeEventListener('change', finishWithoutMotion); };
  }, [leaving]);
  const onExited = useCallback(() => {
    if (value === null) setRetained(null);
  }, [value]);
  return { value: value ?? retained, mounted: value !== null || retained !== null, leaving, onExited };
}
