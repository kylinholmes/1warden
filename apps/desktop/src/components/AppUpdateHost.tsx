import { useEffect } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { getAppUpdater } from '../updates/app';
import type { AppUpdater } from '../updates/controller';
import AppUpdateNotice from './AppUpdateNotice';
import AppUpdates from './AppUpdates';

export default function AppUpdateHost({ settings = false }: { settings?: boolean }) {
  const store = useLocalStore(() => ({ updater: null as AppUpdater | null }));
  const [updater, setUpdater] = useStoreField(store, 'updater');
  useEffect(() => {
    let alive = true;
    void getAppUpdater().then((value) => {
      if (!alive || !value) return;
      value.start(); setUpdater(value);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!updater) return null;
  return settings ? <AppUpdates updater={updater} /> : <AppUpdateNotice updater={updater} />;
}
