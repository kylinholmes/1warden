import { createStore } from '@1warden/state';
import type { AppUpdater } from './controller';

export interface RestartGuard {
  /** Only callbacks live here; editor drafts stay inside the mounted editor. */
  prepare(signal: AbortSignal): boolean | Promise<boolean>;
  finish?(): void;
  priority?: number;
  validate?(): void;
}

export function createSafeRestart() {
  const guards = new Set<RestartGuard>();
  const state = createStore(() => ({ busy: false, error: null as string | null }));
  let pending: Promise<void> | null = null;
  let active: AbortController | null = null;
  const invalidate = () => active?.abort();
  function register(guard: RestartGuard) {
    invalidate(); guards.add(guard);
    return () => { guards.delete(guard); invalidate(); };
  }
  function restart(updater: AppUpdater): Promise<void> {
    if (pending) return pending;
    if (updater.getSnapshot().phase !== 'ready') return Promise.resolve();
    const operation = new AbortController(); active = operation;
    const checks = [...guards].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    state.setState({ busy: true, error: null });
    pending = Promise.resolve().then(async () => {
      try {
        for (const check of checks) {
          if (operation.signal.aborted || !await check.prepare(operation.signal)) return;
        }
        if (operation.signal.aborted) return;
        for (const check of checks) check.validate?.();
        if (updater.getSnapshot().phase === 'ready') await updater.restart();
      } catch (error) {
        if (!operation.signal.aborted) state.setState({ error: error instanceof Error ? error.message : '暂时无法重启，请重试。' });
      } finally {
        for (const check of checks) check.finish?.();
        if (active === operation) active = null;
        pending = null; state.setState({ busy: false });
      }
    });
    return pending;
  }
  return { register, invalidate, restart, subscribe: state.subscribe, getSnapshot: state.getState };
}

/** One runtime/window, shared by the notice outside App and the Settings route. */
export const safeRestart = createSafeRestart();
