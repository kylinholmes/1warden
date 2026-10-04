/**
 * 界面预览 —— 用固定的假数据渲染各个界面，供截图核对排版。
 *
 * ⚠️ 这里的数据是**编造的**，只为把界面撑到有代表性的状态：
 * 有发现项的、干净的、字段长度极端的。真实数据不进来。
 *
 * 构建：`bun run preview:build`（产物 `dist-preview/`，不打包进产品）
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SecurityReportView } from '../src/screens/SecurityReport';
import { VaultView, ItemDetail, EmptyDetail } from '../src/screens/VaultView';
import { QuickAccess } from '../src/screens/QuickAccess';
import { Settings, type SectionId } from '../src/screens/Settings';
import { ImportScreen } from '../src/screens/Import';
import { ItemEditor } from '../src/screens/ItemEditor';
import { Connect } from '../src/screens/Connect';
import { Unlock } from '../src/screens/Unlock';
import { ToastProvider, useToast, type ToastInput } from '../src/components/Toast';
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

/*
 * ── 动效的定格 ──────────────────────────────────────────────
 *
 * 静图证明不了动效，但**卡时间点去拍动画中间帧**同样证明不了 ——
 * 每次拍到的进度都不一样。所以把动画定住：`?at=<毫秒>` 让页面在
 * 指定时刻把所有正在跑的 CSS 动画设到 `currentTime = at` 然后暂停，
 * 于是同一张图每次都能重现。
 *
 * 定格要在动画**开始之后**再执行，所以由触发动作的那一方调用
 * （下面几个 Preview 组件里的 `scheduleFreeze`）。
 */
const atParam = new URLSearchParams(location.search).get('at');
const freezeAt = atParam === null ? null : Number(atParam);

function freezeAllAnimations(offset: number): void {
  for (const a of document.getAnimations()) {
    /*
      ⚠️ 只定格**正在跑**的动画。
      一开始没写这个判断，于是页面加载时那批已经播完的进场动画（整屏淡入）
      也被倒回到 `offset` 处 —— 结果每张图里整个界面都蒙着一层半透明，
      而且倒回哪一帧取决于那批动画当时有没有被回收，两次拍同一张图都不一样。
      「已结束的不动」这一条，是让关键帧可复现的关键。
    */
    if (a.playState !== 'running') continue;
    try {
      a.currentTime = offset;
      a.pause();
    } catch { /* 设不了就跳过，不影响其余 */ }
  }
}

/**
 * 等到真的**有动画在跑**了，再定格。
 *
 * ⚠️ 不能用「setTimeout 固定毫秒」代替。React 从 setState 到把新的 class
 * 落到 DOM 上、浏览器再据此创建动画，中间隔了多少帧是不确定的；
 * 猜早了我们定格的是一批已经播完的旧动画，猜晚了中间帧已经过去了 ——
 * 两种都表现为「这张图像是没定格」。盯住「有没有在跑的动画」才是稳的。
 */
function scheduleFreeze(offset: number): void {
  const deadline = performance.now() + 800;
  const tick = (): void => {
    const running = document.getAnimations().filter((a) => a.playState === 'running');
    if (running.length === 0 && performance.now() < deadline) {
      requestAnimationFrame(tick);
      return;
    }
    for (const a of running) {
      try {
        a.currentTime = offset;
        a.pause();
      } catch { /* 设不了就跳过 */ }
    }
  };
  requestAnimationFrame(tick);
}

/**
 * 用负延迟 + `animation-play-state: paused` 定格（见 preview.css）。
 * 用于**退场**动画 —— 它不能走上面的 JS 定格，理由写在那条规则上方。
 */
function cssFreeze(offset: number): void {
  document.documentElement.style.setProperty('--freeze-out', String(offset));
  document.documentElement.dataset.freezeOut = '1';
}

/**
 * 设置面板的预览。
 *
 *   flow=open    一开始关着，700ms 时打开 —— 配 `?at=` 定格**进场**关键帧
 *   flow=exit    一直开着，用 CSS 负延迟定格**退场**关键帧（见 preview.css）
 *   flow=settled 默认，静止的开着的样子
 */
function SettingsPreview({ flow }: { flow: string }) {
  const [open, setOpen] = useState(flow !== 'open');

  useEffect(() => {
    if (flow === 'exit') {
      if (freezeAt !== null) cssFreeze(freezeAt);
      return;
    }
    if (flow !== 'open') return;
    const t = setTimeout(() => {
      setOpen(true);
      if (freezeAt !== null) scheduleFreeze(freezeAt);
    }, 700);
    return () => clearTimeout(t);
  }, [flow]);

  return (
    <>
      <VaultView client={fakeClient} onLock={() => {}} />
      <Settings
        open={open}
        account="me@example.com"
        serverUrl="https://vault.example.com"
        onClose={() => setOpen(false)}
        initialSection={(new URLSearchParams(location.search).get('section') ?? 'account') as SectionId}
      />
    </>
  );
}

/**
 * 提示条的预览。
 *
 * `variant=all`    四种语气一次全上（把可见上限调到 4，只为了拍全）
 * `variant=trio`   连发五条不同的 —— 拍到的是**上限 3 条**，其余排队
 * `variant=repeat` 同一条连发五次 —— 拍到的是「合并成一条」而不是五条
 */
const FIXTURES: Record<string, ToastInput[]> = {
  all: [
    { tone: 'success', message: '已保存「GitHub」' },
    { tone: 'warning', message: '有 3 条密码重复使用，建议改掉其中两条' },
    { tone: 'danger', message: '没能更改收藏：网络连接超时，请稍后重试' },
    { tone: 'neutral', message: '已永久删除「老论坛」' },
  ],
  trio: [
    { tone: 'success', message: '已保存「GitHub」' },
    { tone: 'success', message: '已保存「公司 VPN」' },
    { tone: 'success', message: '已保存「邮箱（主）」' },
    { tone: 'neutral', message: '第 4 条：它应该排在队里，看不见' },
    { tone: 'neutral', message: '第 5 条：同上' },
  ],
  repeat: [
    { tone: 'success', message: '已复制密码' },
  ],
};

function ToastFixtures({ variant }: { variant: string }) {
  const toast = useToast();
  useEffect(() => {
    /*
      `exit` 走的是**真实路径**：发一条短命的提示（duration 覆盖），
      等它自己到期 → 组件把它标成 leaving → 退场动画起来 → 定格。
      没有兜底卸载这类会半路插手的东西，所以 JS 定格够用。
    */
    if (variant === 'exit') {
      const timers = [
        setTimeout(() => toast.show({ tone: 'success', message: '已保存「GitHub」', duration: 900 }), 700),
        // 到期在 1600ms；定格从 1550ms 开始盯着「有没有动画在跑」
        setTimeout(() => { if (freezeAt !== null) scheduleFreeze(freezeAt); }, 1550),
      ];
      return () => { for (const t of timers) clearTimeout(t); };
    }
    const list = FIXTURES[variant] ?? FIXTURES.all!;
    const times = variant === 'repeat' ? [0, 1, 2, 3, 4] : list.map((_, i) => i);
    const timers = times.map((n, i) => setTimeout(() => {
      toast.show(list[variant === 'repeat' ? 0 : i]!);
      if (i === times.length - 1 && freezeAt !== null) scheduleFreeze(freezeAt);
    }, 600 + n * 120));
    return () => { for (const t of timers) clearTimeout(t); };
    // 只在挂载时发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function ToastPreview({ variant }: { variant: string }) {
  return (
    <ToastProvider maxVisible={variant === 'all' ? 4 : 3}>
      <VaultView client={fakeClient} onLock={() => {}} />
      <ToastFixtures variant={variant} />
    </ToastProvider>
  );
}

/*
 * 整棵树都包在 ToastProvider 里：VaultView 会用 useToast()（保存、删除、
 * 收藏失败都要发提示条），没有 Provider 它会直接抛错 —— 抛出来的结果是
 * 一张全白的截图，而截图本身是「成功」的。
 * 提示条自己的预览再在里面套一层，好把可见上限调大。
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
    {which === 'settings' ? (
      <SettingsPreview flow={params.get('flow') ?? 'settled'} />
    ) : which === 'toasts' ? (
      <ToastPreview variant={params.get('variant') ?? 'all'} />
    ) : which === 'import' ? (
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
    </ToastProvider>
  </StrictMode>,
);
