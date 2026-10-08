import { CLIPBOARD_CLEAR_MS } from '@1warden/ui/clipboard';
import type { StorageArea } from './session-store';
import { createSerialRunner } from './application-rpc';

const KEY = '1warden.clipboard';

/** Firefox's event page can stop; the alarm and expected value therefore live outside the popup. */
export function createClipboardStore(options: {
  area: StorageArea;
  clipboard: Pick<Clipboard, 'readText' | 'writeText'>;
  schedule(deadline: number): Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const run = createSerialRunner();
  return {
    schedule(value: string) {
      return run(async () => {
        const deadline = now() + CLIPBOARD_CLEAR_MS;
        await options.area.set({ [KEY]: { value, deadline } });
        await options.schedule(deadline);
      });
    },
    resume() {
      return run(async () => {
        const entry = (await options.area.get(KEY))[KEY] as { value?: unknown; deadline?: unknown } | undefined;
        if (!entry || typeof entry.value !== 'string' || typeof entry.deadline !== 'number') return;
        if (entry.deadline > now()) { await options.schedule(entry.deadline); return; }
        try {
          if (await options.clipboard.readText() === entry.value) await options.clipboard.writeText('');
        } finally {
          await options.area.remove(KEY);
        }
      });
    },
  };
}
