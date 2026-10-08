import { useLocalStore, useStoreField, useStoreSnapshot } from '@1warden/state/react';
import { useEffect, useRef } from 'react';
import { IconChevronDown, IconIdentity, IconKeyboard, PageHeader } from '@1warden/ui';
import type { ApplicationClient } from '../application/types';
import { ProfileAvatar } from '../components/ProfileAvatar';
import { ProfileEditor } from '../components/ProfileEditor';
import { UserDetails } from '../components/UserDetails';
import { useProfileDraft } from '../components/ProfileAutosave';

type Page = 'overview' | 'edit' | 'devices';
const sections = [
  { id: 'edit', label: '个人资料', hint: '头像、显示名称', icon: IconIdentity },
  { id: 'devices', label: '登录设备', hint: '查看最近使用此账户的客户端', icon: IconKeyboard },
] as const;

/** A vault destination, not a modal: identical hierarchy on wide and narrow windows. */
export function ProfilePage({ client, onBack }: { client: ApplicationClient; onBack: () => void }) {
  const snapshot = useStoreSnapshot(client.subscribe, client.getSnapshot);
  const { profile, store } = useProfileDraft(client);
  const viewStore = useLocalStore(() => {
    const page = ('overview') as Page;
    return { page };
  });
  const [page, setPage] = useStoreField(viewStore, 'page');
  const last = useRef<Page>('edit');
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current && page === 'overview') document.getElementById(`profile-link-${last.current}`)?.focus();
    else heading.current?.focus({ preventScroll: true });
    mounted.current = true;
  }, [page]);
  function back() { void store.flush(); if (page === 'overview') onBack(); else setPage('overview'); }
  function backToVault() { void store.flush(); onBack(); }
  const title = sections.find(section => section.id === page)?.label;
  return <main className="flex min-h-0 flex-1 flex-col" aria-label="用户详情">
    <PageHeader navigation title="用户详情" onBack={back} backLabel={page === 'overview' ? '返回保险库' : '返回用户详情'}
      breadcrumbs={page === 'overview' ? [{ label: '保险库', onSelect: back }, { label: '用户详情' }]
        : [{ label: '保险库', onSelect: backToVault }, { label: '用户详情', onSelect: back }, { label: title! }]} />
    <div role="region" aria-label={title ?? '用户详情目录'} className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-8">
      <div className="mx-auto w-full max-w-[680px]">
        <h1 ref={heading} tabIndex={-1} className="mb-6 text-xl font-semibold outline-none">{title ?? '用户详情'}</h1>
        {page === 'overview' ? <>
          <div className="mb-8 flex items-center gap-4">
            <ProfileAvatar profile={profile.value} fallback={snapshot.account?.email ?? ''} className="h-16 w-16 shrink-0 text-2xl" />
            <div className="min-w-0"><p className="break-words text-lg font-medium">{profile.value.displayName || '我的账户'}</p><p className="mt-1 break-all text-sm text-[var(--ink-secondary)]">{snapshot.account?.email}</p><p className="mt-1 break-all text-xs text-[var(--ink-tertiary)]">{snapshot.account?.serverUrl}</p></div>
          </div>
          <div className="card overflow-hidden">
            {sections.map(({ id, label, hint, icon: Icon }) => <button key={id} id={`profile-link-${id}`} type="button"
              onClick={() => { last.current = id; setPage(id); }} className="flex min-h-20 w-full items-center gap-4 border-b border-[var(--border-subtle)] p-4 text-left last:border-0 hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)]">
              <Icon size={19} className="shrink-0 text-[var(--accent)]" /><span className="min-w-0 flex-1"><span className="block text-md font-medium">{label}</span><span className="mt-1 block text-xs text-[var(--ink-tertiary)]">{hint}</span>
                {id === 'edit' && profile.error && <span className="mt-1 block text-xs text-[var(--risk)]">有修改保存失败，点击查看</span>}</span><IconChevronDown size={16} className="-rotate-90 shrink-0 text-[var(--ink-tertiary)]" />
            </button>)}
          </div>
          <p className="mt-5 text-xs leading-relaxed text-[var(--ink-tertiary)]">资料和设备信息保存在保险库的特殊加密记录中，修改后自动同步。</p>
        </> : page === 'edit' ? <ProfileEditor client={client} /> : <UserDetails client={client} />}
      </div>
    </div>
  </main>;
}
