import { Segmented } from '@1warden/ui';
import type { ApplicationClient } from '../application/types';
import { useShowTypes } from '../prefs';
import { AppearancePicker } from './AppearancePicker';
import { SyncedPreferences } from './SyncedPreferences';

export function AccountAppearance({ client }: { client?: ApplicationClient }) {
  const [showTypes, setShowTypes] = useShowTypes();
  return <SyncedPreferences {...(client ? { client } : {})}>{onChange => <>
    <AppearancePicker onChange={onChange} />
    <section>
      <h3 className="text-md font-medium">布局与显示</h3>
      <div className="card mt-3 flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-[120px] flex-1"><p className="text-md">侧栏按类别分组</p><p className="mt-1 text-xs text-[var(--ink-tertiary)]">按登录、信用卡等条目类型显示分组</p></div>
        <Segmented<'on' | 'off'> label="侧栏按类别分组" value={showTypes ? 'on' : 'off'} onChange={v => { setShowTypes(v === 'on'); onChange(); }}
          options={[{ value: 'on', label: '显示' }, { value: 'off', label: '隐藏' }]} />
      </div>
    </section>
  </>}</SyncedPreferences>;
}
