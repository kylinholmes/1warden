/**
 * 界面预览 —— 用固定的假数据渲染各个界面，供截图核对排版。
 *
 * ⚠️ 这里的数据是**编造的**，只为把界面撑到有代表性的状态：
 * 有发现项的、干净的、字段长度极端的。真实数据不进来。
 *
 * 构建：`bun run preview:build`（产物 `dist-preview/`，不打包进产品）
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SecurityReportView } from '../src/screens/SecurityReport';
import { VaultView, ItemDetail, EmptyDetail } from '../src/screens/VaultView';
import { QuickAccess } from '../src/screens/QuickAccess';
import { ImportScreen } from '../src/screens/Import';
import { ItemEditor } from '../src/screens/ItemEditor';
import { Connect } from '../src/screens/Connect';
import { Unlock } from '../src/screens/Unlock';
import { emptyLogin, type VaultItem, type VaultFolder, type VaultClient } from '@coffer/vault';
import './preview.css';

function item(over: Partial<VaultItem> & { id: string; name: string }): VaultItem {
  return {
    type: 'login', rawType: 1, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null, archivedAt: null, hasItemKey: false,
    login: { ...emptyLogin(), password: 'kJ8#mPq2$vXn9!wZt4&bR' },
    card: null, identity: null, secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
    ...over,
  };
}

/** 有各种问题的库 —— 报告页最该经得起看的就是这种 */
const MESSY: VaultItem[] = [
  item({ id: '1', name: 'GitHub', login: { ...emptyLogin(), username: 'me', password: 'password123', uris: [{ uri: 'https://github.com', match: null }] } }),
  item({ id: '2', name: '公司 VPN', login: { ...emptyLogin(), username: 'me', password: 'password123', uris: [{ uri: 'https://vpn.example.com', match: null }] } }),
  item({ id: '3', name: '邮箱（主）', login: { ...emptyLogin(), username: 'me@example.com', password: 'P@ssw0rd1!', uris: [{ uri: 'https://mail.example.com', match: null }] } }),
  item({ id: '4', name: '老论坛', login: { ...emptyLogin(), username: 'old', password: '9382716450', uris: [{ uri: 'http://bbs.example.com', match: null }] } }),
  item({ id: '5', name: '一个名字特别特别长的服务用来测试截断行为是否正常', login: { ...emptyLogin(), username: 'x', password: 'aaaaaaaaaa', uris: [{ uri: 'https://a-very-long-hostname-for-truncation.example.com', match: null }] } }),
  item({ id: '6', name: '云服务商', login: { ...emptyLogin(), username: 'me', password: 'kJ8#mPq2$vXn9!wZt4&bR', uris: [{ uri: 'https://cloud.example.com', match: null }] } }),
  item({
    id: '7', name: '信用卡', type: 'card', rawType: 3, login: null,
    card: { cardholderName: 'ME', brand: 'Visa', number: '4111', expMonth: '7', expYear: '2026', code: null },
  }),
];

/** 干净的库 —— 空状态也要看 */
const CLEAN: VaultItem[] = [
  item({ id: 'c1', name: 'GitHub', login: { ...emptyLogin(), username: 'me', password: 'kJ8#mPq2$vXn9!wZt4&bR' } }),
  item({ id: 'c2', name: '邮箱', login: { ...emptyLogin(), username: 'me', password: 'Xq7!vLm2#Rt9$Wz4&Kp8' } }),
];

const FOLDERS: VaultFolder[] = [
  { id: 'f1', name: '工作', nameFailed: false, updatedAt: 'x' },
  { id: 'f2', name: '个人', nameFailed: false, updatedAt: 'x' },
  { id: 'f3', name: '订阅服务', nameFailed: false, updatedAt: 'x' },
];

/**
 * 假的客户端 —— 只实现**渲染需要**的那一个方法。
 *
 * 目的是让三栏布局（含侧栏的文件夹管理）能在不启动原生壳、不登录的情况下
 * 被截图核对。点击类操作会抛错，但预览只用来看，不用来点。
 */
const fakeClient = {
  getSession: () => ({
    items: MESSY.map((i, n) => ({ ...i, folderId: n % 3 === 0 ? 'f1' : null })),
    folders: FOLDERS,
    account: { email: 'me@example.com', serverUrl: 'https://vault.example.com', userId: 'u', kdf: { kdf: 0, iterations: 1 } },
  }),
} as unknown as VaultClient;

/** 详情栏要看的是一条**内容齐全**的记录：用户名、密码、验证码、网址、备注都有 */
const DETAIL: VaultItem = item({
  id: 'd1', name: 'GitHub',
  login: {
    ...emptyLogin(),
    username: 'me@example.com',
    password: 'kJ8#mPq2$vXn9!wZt4&bR',
    totp: 'otpauth://totp/GitHub:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    uris: [{ uri: 'https://github.com', match: null }, { uri: 'https://gist.github.com', match: null }],
  },
  notes: '公司账号与个人账号是分开的两个。这个只用来登录公司组织，\n恢复代码放在保险柜里。',
  customFields: [{ name: '组织', value: 'acme', type: 0 }],
  passwordHistory: [{ password: 'old-pass-123', lastUsedDate: '2025-06-01T00:00:00Z' }],
});

/** 详情栏外面套一个和真实三栏一致的壳 —— 否则截图里的宽度是假的 */
function DetailPane({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full">
      <div className="w-[var(--rail-w)] shrink-0 border-r border-[var(--border-subtle)] bg-[var(--surface-chrome)]" />
      <div className="w-[var(--list-w)] shrink-0 border-r border-[var(--border-subtle)] bg-[var(--surface-content)]" />
      <div className="min-w-0 flex-1 overflow-y-auto bg-[var(--surface-paper)]">{children}</div>
    </div>
  );
}

const params = new URLSearchParams(location.search);
const which = params.get('screen') ?? 'messy';

/*
 * 「记住的账户」是存在 localStorage 里的，而无头浏览器每次都是全新 profile ——
 * 不种进去的话，连接屏永远只截得到空白表单那一态，看不到账户选择。
 * 这里种的是**假数据**，和这个文件里其他假数据一样，只为把界面撑到有代表性的状态。
 */
if (params.has('accounts')) {
  localStorage.setItem('coffer.accounts', JSON.stringify([
    { serverUrl: 'https://vault.example.com', email: 'me@example.com' },
    { serverUrl: 'https://vault.acme-corp.internal', email: 'zhang@acme.example' },
    { serverUrl: 'http://192.168.1.10:8080', email: 'admin@home.lan' },
  ]));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {which === 'import' ? (
      <ImportScreen client={fakeClient} onImported={() => {}} />
    ) : which === 'detail' ? (
      <DetailPane>
        <ItemDetail item={DETAIL} onEdit={() => {}} onDelete={() => {}} onToggleFavorite={() => {}} />
      </DetailPane>
    ) : which === 'detail-empty' ? (
      <DetailPane><EmptyDetail hasItems /></DetailPane>
    ) : which === 'form' ? (
      <ItemEditor client={fakeClient} item={null} onCancel={() => {}} onDone={() => {}} />
    ) : which === 'form-edit' ? (
      <ItemEditor client={fakeClient} item={DETAIL} onCancel={() => {}} onDone={() => {}} />
    ) : which === 'connect' ? (
      <Connect client={fakeClient} onConnected={() => {}} />
    ) : which === 'unlock' ? (
      <Unlock client={fakeClient} onUnlocked={() => {}} onDisconnect={() => {}} />
    ) : which === 'quick' ? (
      <div style={{ width: 620, height: 400 }}>
        <QuickAccess
          items={[
            { id: '1', name: 'GitHub', username: 'me@example.com', hasPassword: true, hasTotp: true },
            { id: '2', name: '公司 VPN', username: 'zhang', hasPassword: true, hasTotp: false },
            { id: '3', name: '一个名字特别特别长的服务用来测试截断', username: 'x', hasPassword: true, hasTotp: false },
            { id: '4', name: '云服务商', username: null, hasPassword: true, hasTotp: false },
          ]}
          locked={false}
          busy={false}
          notice={null}
          onQueryChange={() => {}}
          onPick={() => {}}
          onClose={() => {}}
        />
      </div>
    ) : which === 'vault' ? (
      <VaultView client={fakeClient} onLock={() => {}} />
    ) : (
      <SecurityReportView items={which === 'clean' ? CLEAN : MESSY} />
    )}
  </StrictMode>,
);
