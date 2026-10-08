import { useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { setStoreField, type FieldUpdate } from './index';

export { useStore } from 'zustand';
/** Bind the stable snapshot API exposed by application/RPC controllers to Zustand.
 * Controllers own their vanilla store; this adapter does not copy session data.
 */
export function useStoreSnapshot<S>(subscribe: (fn: () => void) => () => void, getSnapshot: () => S, getInitialSnapshot = getSnapshot): S {
  const store = useMemo(() => ({
    getState: getSnapshot, getInitialState: getInitialSnapshot,
    subscribe: (listener: (state: S, previous: S) => void) => {
      let previous = getSnapshot();
      return subscribe(() => { const next = getSnapshot(); const before = previous; previous = next; listener(next, before); });
    },
  }), [subscribe, getSnapshot, getInitialSnapshot]);
  return useStore(store);
}
/** One vanilla store per mounted owner, never shared between form instances/accounts. */
export function useLocalStore<S>(initialize: () => S): StoreApi<S> {
  const ref = useRef<StoreApi<S> | null>(null);
  if (!ref.current) ref.current = createStore(initialize);
  return ref.current;
}

export function useStoreField<S, K extends keyof S>(store: StoreApi<S>, key: K): [S[K], (next: FieldUpdate<S[K]>) => void] {
  const value = useStore(store, state => state[key]);
  const update = useMemo(() => (next: FieldUpdate<S[K]>) => setStoreField(store, key, next), [store, key]);
  return [value, update];
}
