import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useEffect, useRef } from 'react';
import { writeClipboardText } from './clipboard';

export interface CopyActionProps {
  getValue: () => Promise<string>;
  onCopied?: ((value: string) => void | Promise<void>) | undefined;
  onError?: ((error: unknown) => void) | undefined;
}

/** Share platform writes and feedback without retaining the copied plaintext. */
export function useCopyAction({ getValue, onCopied, onError }: CopyActionProps) {
  const store = useLocalStore(() => ({ state: 'idle' as 'idle' | 'busy' | 'ok' | 'error' }));
  const [state, setState] = useStoreField(store, 'state');
  const pending = useRef(false), mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);

  async function copy() {
    if (pending.current) return;
    pending.current = true; clearTimeout(timer.current); setState('busy');
    try {
      const value = await getValue();
      if (!mounted.current) return;
      await writeClipboardText(value);
      // Cleanup belongs to the platform and must survive leaving this view.
      await onCopied?.(value);
      if (!mounted.current) return;
      setState('ok');
      timer.current = setTimeout(() => setState('idle'), 2000);
    } catch (error) {
      if (mounted.current) { setState('error'); onError?.(error); }
    } finally { pending.current = false; }
  }
  return { state, copy };
}
