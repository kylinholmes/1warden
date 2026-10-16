import { useLocalStore, useStoreField } from '@1warden/state/react';
import { QuickAccess } from '../src/screens/QuickAccess';
import type { QuickAccount, QuickItem } from '../src/quick-bridge';
import type { QuickAuthentication } from '../src/components/QuickUnlockPanel';

const identities: QuickAccount[] = [
  { id: 'personal', displayName: '个人账户', email: 'alex@example.com', serverUrl: 'https://vault.example.com', avatarDataUrl: null },
  { id: 'work', displayName: '工作账户', email: 'alex@example.com', serverUrl: 'https://work.example.com/team', avatarDataUrl: null },
  { id: 'family', displayName: '家庭账户', email: 'family@example.com', serverUrl: 'https://family.example.com', avatarDataUrl: null },
  { id: 'long', displayName: '长账户', email: 'long-account-name@example.com', serverUrl: 'https://long-server.example.com/team', avatarDataUrl: null },
];
const items: QuickItem[] = ['GitHub', '公司 VPN', '邮箱'].map((name, index) => ({ id: String(index), name, username: 'alex@example.com',
  hasPassword: true, hasTotp: index === 0, type: 'login', summary: 'alex@example.com', iconDomain: null, avatarText: name.slice(0, 2), avatarHue: index * 110 }));

/** Synthetic credentials only: preview / 123456. Exercises the production UI. */
export function QuickInteractionPreview({ single, twoFactor }: { single: boolean; twoFactor: boolean }) {
  const store = useLocalStore(() => ({ locked: true, query: '', notice: null as string | null, closed: false, generation: 0 }));
  const [locked, setLocked] = useStoreField(store, 'locked');
  const [query, setQuery] = useStoreField(store, 'query');
  const [notice, setNotice] = useStoreField(store, 'notice');
  const [closed, setClosed] = useStoreField(store, 'closed');
  const [generation, setGeneration] = useStoreField(store, 'generation');
  const authenticate: QuickAuthentication = async (accountId, input) => {
    await new Promise(resolve => setTimeout(resolve, 160));
    const base = { accountId, requestId: 1, generation };
    if (input.action === 'select') return { ...base, stage: 'password' };
    if (input.action === 'twoFactor') return input.code === '123456'
      ? { ...base, stage: 'unlocked' } : { ...base, stage: 'twoFactor', providers: [0, 3], error: '验证码不正确，请重试' };
    if (input.password !== 'preview') return { ...base, stage: 'password', error: '主密码不正确，请重试' };
    return twoFactor ? { ...base, stage: 'twoFactor', providers: [0, 3] } : { ...base, stage: 'unlocked' };
  };
  if (closed) return <button className="btn" onClick={() => { setClosed(false); setGeneration(value => value + 1); }}>重新打开快速搜索</button>;
  return <QuickAccess key={generation} items={items.filter(item => item.name.toLowerCase().includes(query.toLowerCase()))} icons={null}
    locked={locked} busy={false} notice={notice} accounts={single ? identities.slice(0, 1) : identities}
    onAuthenticate={authenticate} onAuthenticationComplete={() => setLocked(false)} onCancelAuthentication={() => {}}
    onQueryChange={setQuery} onPick={() => setNotice('密码已复制，30 秒后清空')}
    onClose={() => setClosed(true)} onTogglePin={() => {}} />;
}
