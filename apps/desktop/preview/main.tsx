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
import { VaultView } from '../src/screens/VaultView';
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

const which = new URLSearchParams(location.search).get('screen') ?? 'messy';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {which === 'vault' ? (
      <VaultView client={fakeClient} onLock={() => {}} />
    ) : (
      <SecurityReportView items={which === 'clean' ? CLEAN : MESSY} />
    )}
  </StrictMode>,
);
