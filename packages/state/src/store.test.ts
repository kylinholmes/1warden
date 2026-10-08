import { describe, expect, it, vi } from 'vitest';
import { createStore, setStoreField } from './index';

describe('scoped Zustand view stores', () => {
  it('isolates instances and applies functional updates to the latest state', () => {
    const a = createStore(() => ({ count: 0, password: '' })); const b = createStore(() => ({ count: 0, password: '' }));
    setStoreField(a, 'password', 'temporary');
    setStoreField(a, 'count', n => n + 1); setStoreField(a, 'count', n => n + 1);
    expect(a.getState()).toEqual({ count: 2, password: 'temporary' });
    expect(b.getState()).toEqual({ count: 0, password: '' });
  });
  it('preserves identity for no-op updates and unsubscribes cleanly', () => {
    const store = createStore(() => ({ open: false })); const listener = vi.fn(); const initial = store.getState();
    const stop = store.subscribe(listener); setStoreField(store, 'open', false);
    expect(store.getState()).toBe(initial); expect(listener).not.toHaveBeenCalled();
    setStoreField(store, 'open', true); expect(listener).toHaveBeenCalledTimes(1);
    stop(); setStoreField(store, 'open', false); expect(listener).toHaveBeenCalledTimes(1);
  });
});
