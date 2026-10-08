export { createStore, type StoreApi } from 'zustand/vanilla';

export type FieldUpdate<T> = T | ((previous: T) => T);

/** Small immutable field action for scoped view stores. No persistence or devtools:
 * these stores may contain temporary passwords, OTPs or decrypted editor drafts.
 */
export function setStoreField<S, K extends keyof S>(store: import('zustand/vanilla').StoreApi<S>, key: K, next: FieldUpdate<S[K]>): void {
  store.setState(previous => {
    const value = typeof next === 'function' ? (next as (value: S[K]) => S[K])(previous[key]) : next;
    return Object.is(value, previous[key]) ? previous : { ...previous, [key]: value };
  });
}
