import { StrictMode, memo, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore } from '../../packages/state/src/index';
import { useLocalStore, useStoreField, useStore, useStoreSnapshot } from '../../packages/state/src/react';
import { ErrorBoundary } from '../../apps/desktop/src/App';

// Synthetic values only. Exposing stores here tests teardown, never production.
const fixture = { stores: {} as Record<string, any>, setters: {} as Record<string, any>, renders: {} as Record<string, number>, listeners: 0, mounted: 0 };
(window as any).fixture = fixture;
const root = createRoot(document.getElementById('root')!);
const shared = createStore(() => ({ count: 0 }));
const subscribe = (listener: () => void) => {
  fixture.listeners++; const stop = shared.subscribe(listener);
  return () => { fixture.listeners--; stop(); };
};
function Snapshot() {
  const value = useStoreSnapshot(subscribe, shared.getState);
  return <output id="snapshot">{value.count}</output>;
}
const Count = memo(function Count({ store, name }: { store: any; name: string }) {
  const count = useStore(store, (s: any) => s.count);
  fixture.renders[name] = (fixture.renders[name] ?? 0) + 1;
  return <output id={name + '-count'}>{count}</output>;
});
function Form({ name, initial }: { name: string; initial: number }) {
  const store = useLocalStore(() => ({ count: initial, secret: '' }));
  const [secret, setSecret] = useStoreField(store, 'secret');
  const [, setCount] = useStoreField(store, 'count');
  useEffect(() => {
    fixture.stores[name] = store; fixture.setters[name] = { setSecret, setCount }; fixture.mounted++;
    return () => { fixture.mounted--; };
  }, [store, name, setSecret, setCount]);
  return <section><input id={name + '-secret'} value={secret} onChange={e => setSecret(e.target.value)} /><Count store={store} name={name} /></section>;
}
function Thrower({ fail }: { fail: boolean }) { if (fail) throw new Error('synthetic render failure'); return <p>Healthy</p>; }
(window as any).mount = (key = 'a', initial = 0) => root.render(<StrictMode><Form key={key} name="a" initial={initial} /><Form key="b" name="b" initial={0} /><Snapshot /></StrictMode>);
(window as any).empty = () => root.render(null);
(window as any).bump = () => shared.setState(s => ({ count: s.count + 1 }));
(window as any).boundary = (fail: boolean) => root.render(<ErrorBoundary><Thrower fail={fail} /></ErrorBoundary>);
(window as any).mount();
