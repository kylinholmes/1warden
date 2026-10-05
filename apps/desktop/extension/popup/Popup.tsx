import { ext } from '../ext-api';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { IconStore, detectImportFormat, type ImportFormatId, type VaultItem } from '@coffer/vault';

import {
  IconAlert, IconClose, IconDice, IconGlobe, IconItems,
  IconFolder, IconImport, IconKeyboard, IconLock, IconPlus, IconSearch, IconShield, IconStar,
  ItemEditor, ItemIcon, ItemRow, NavDrawer, NavRow, NavTrigger, Section,
  ConnectScreen, GeneratorBody, ImportView, SecurityReportView,
  apiMessageOf, countByType,
  host, iconStoreFor, rememberAccount, useAccounts,
  typeDestinations,
  type BreachState, type ImportOutcome, type ImportPreview, type ReportBrief,
} from '@coffer/ui';

/** 导航目的地的键。类型项是 `type:<条目类型>` —— 见 `@coffer/ui` 的 destinations */
type Destination =
  | 'all' | 'favorites' | 'generator' | 'security' | 'import'
  | `type:${string}` | `folder:${string}`;

/*
 * 安全报告的展示形态是 `@coffer/ui` 的 `ReportBrief` —— **不是**这里自己的
 * 一个 interface。这里原本有一份，而它比桌面端那份少了两个字段
 * （`breached` / `unsecured[].uris`），于是弹窗的界面也就跟着少了两栏。
 * 一份类型定义写两遍，漂的是**功能**，不只是名字。
 */



import { ItemDetail } from './ItemDetail';

/**
 * 扩展弹窗。
 *
 * 弹窗的**壳**：三层布局的装配与状态，加上中间那一层（列表）。
 *
 * ── 三层（Material 的 navigation rail + list-detail）
 *
 *   1. `Rail.tsx`        去哪一类 —— 全部 / 收藏 / 类别 / 生成器
 *   2. 本文件            这一类里有什么 —— 搜索 + 分组列表
 *   3. `ItemDetail.tsx`  这一条是什么 —— 盖住列表，带返回
 *
 * ⚠️ 早先是「把桌面端的三栏压成一栏」：分类、列表、详情全糊在一起，
 * 于是每一行又宽又高、列表和详情都不像。三层的划分让每层只干一件事。
 *
 * 列表行本体来自 `@coffer/ui` 的 `ItemRow`，**和桌面端共用** ——
 * 这一行决定「同一条记录看起来是什么样」，两处各写一遍的后果是
 * 同一条在两个地方显示成不同的东西。
 */

/** ⚠️ 导出是为了让 preview 的假数据用**同一个类型** —— 抄一份就会漂 */
export interface ItemSummary {
  id: string;
  name: string;
  username: string | null;
  hasPassword: boolean;
  hasTotp: boolean;
  uris: string[];
  favorite: boolean;
  /** 所属文件夹。和桌面端对齐 —— 那个 `coffer:folders` 给名字，这里只带 id */
  folderId: string | null;

  /*
   * ── 显示用的字段 ──
   *
   * ⚠️ 和桌面端的快速面板同一个做法：弹窗**拿不到 `VaultItem`**
   * （它只从 background 收摘要），所以 `summaryOf` / `avatarOf` 那套规则
   * 在 background 那边算好、随摘要过来。不这样做的话规则要在两处各写一遍。
   */
  type: string;
  summary: string | null;
  iconDomain: string | null;
  avatarText: string;
  avatarHue: number;
}

interface Status {
  unlocked: boolean;
  account: { email: string; serverUrl: string } | null;
  itemCount: number;
}

/**
 * 待确认的「保存 / 更新」。
 *
 * ⚠️ **不含密码** —— background 只回展示需要的字段，明文在保存那一刻
 * 才由 background 自己取用。弹窗没有任何理由看到它。
 */
interface Pending {
  url: string;
  username: string | null;
  action: 'save' | 'update';
  itemId: string | null;
}

/** 与 background 约定的调用方式 */
async function send<T>(msg: Record<string, unknown>): Promise<T> {
  const res = await ext.runtime.sendMessage(msg) as T & { error?: string };
  if (res && typeof res === 'object' && 'error' in res && res.error) throw new Error(res.error);
  return res;
}

export function Popup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [items, setItems] = useState<ItemSummary[]>([]);
  /*
   * 站点图标的缓存。
   *
   * 弹窗自己有 host_permissions（匹配所有 http/https），所以**可以直接
   * fetch** 服务端的图标接口 —— 不用绕 background。桌面端那边不行
   * （跨源被 CORS 拦），它得走 Rust。这是两边唯一的分歧点。
   *
   * 和桌面端一样是**模块级单例**：弹窗每次打开都重建的话缓存等于没有，
   * 而服务端首次抓一个图标要 1.5 秒。
   */
  const icons = useMemo(() => {
    const url = status?.account?.serverUrl;
    if (!url) return null;
    /* 取图标走宿主 —— 桌面端走 Rust、扩展端直接 fetch，差异已被宿主吸收 */
    return iconStoreFor(url);
  }, [status?.account?.serverUrl]);
  const [tabUrl, setTabUrl] = useState('');
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  /**
   * 服务器要求两步验证时拿到的挑战。
   *
   * 它**不是错误** —— 是解锁流程的下一步（见 `@coffer/ui` 的 `TwoFactorForm`）。
   * 以前扩展端完全没有这一步，于是开了两步验证的 Vaultwarden 用户
   * 根本登不进来。
   */
  const [challenge, setChallenge] = useState<{ providers: number[] } | null>(null);
  /*
   * 记住的账户 —— 和桌面端**同一个存储、同一个 hook**（`@coffer/ui/accounts`）。
   * 弹窗以前完全没有这个功能：每次打开都要重敲服务器地址和邮箱。
   */
  const accounts = useAccounts();

  /*
   * ── 主列表与搜索
   *
   * ⚠️ 之前这里没有这两样，于是「本站没有匹配条目」是一条**死胡同**：
   * 只有一句话和一个生成器，用户够不到保险库里别的东西 —— 而那正是
   * 打开弹窗的常见理由之一（「我记得存过，叫什么来着」）。
   *
   * 现在：空 query = 浏览整个保险库（`searchItems` 在空查询下就是浏览模式，
   * 收藏优先、然后最近更新），有 query = 搜索。
   */
  const [query, setQuery] = useState('');
  const [browse, setBrowse] = useState<ItemSummary[]>([]);
  /** 搜索结果。`null` = 还没搜完 —— 和「搜到了 0 条」是两件事，不能混 */
  const [hits, setHits] = useState<ItemSummary[] | null>(null);

  /*
   * 导航上的类型项 —— 由**数据**来，两端共用同一份词表和顺序。
   * 建在 `browse`（整个库）上而不是当前筛选结果上：导航不该随筛选自己变。
   */
  const railTypes = useMemo(() => typeDestinations(countByType(browse), 20), [browse]);

  /*
   * ── 三层的状态
   *
   * `dest`   第一层 rail 选中的分类
   * `openId` 第三层正在看的那一条；`null` = 停在列表层
   *
   * 这两个都不是「模式」，是**位置** —— 详情盖住列表而不是换个模式，
   * 所以退回来（onBack）只是把 openId 清掉，列表原样还在，搜索词也还在。
   */
  const [dest, setDest] = useState<Destination>('all');
  /*
   * 文件夹 —— 和桌面端**对齐**（用户明确要求这些两边都要有）。
   * 单独一条消息：它是整个库的一份，跟着每条摘要重复几十遍没道理，
   * 而且它和条目的变化频率完全不同。
   */
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  /** 安全报告。只在切到那一项时拉 —— 它要跑一遍全库扫描 */
  const [report, setReport] = useState<ReportBrief | null>(null);
  /*
   * 已泄露密码的检查 —— **和 `report` 分开存**。
   *
   * 报告每次切过去都重拉（它只是本地算的），而这一项**必须由用户显式开启**
   * （它是本应用唯一会联系第三方的功能）。放在一起的话，离开再回来就会把
   * 上次的结果冲掉 —— 用户看到的是「刚查过怎么又要查一遍」。
   */
  const [breach, setBreach] = useState<{
    state: BreachState;
    found: { itemId: string; count: number }[];
  }>({ state: 'off', found: [] });

  const enableBreachCheck = useCallback(async () => {
    setBreach((b) => ({ ...b, state: 'checking' }));
    try {
      const r = await send<{ breached: { itemId: string; count: number }[] }>({
        type: 'coffer:breach-check',
      });
      setBreach({ state: 'on', found: r.breached });
    } catch {
      setBreach((b) => ({ ...b, state: 'failed' }));
    }
  }, []);
  const [openId, setOpenId] = useState<string | null>(null);
  /**
   * 新建条目那一屏开着没有。
   *
   * ⚠️ **只有新建，没有编辑** —— 编辑要先决定「打开时整条揭示给弹窗」
   * 还是「密码留空 = 不改」（读那条不变量 S1 的口子开不开）。
   * 新建不涉及这个问题：用户敲的是自己刚打的字。
   */
  const [editorOpen, setEditorOpen] = useState(false);

  // 解锁后拉一次主列表。锁定或登出时清掉 —— 留着的话下次解锁会先闪出旧数据
  useEffect(() => {
    if (!status?.unlocked) { setBrowse([]); return; }
    let alive = true;
    void send<{ items: ItemSummary[] }>({ type: 'coffer:search', query: '' })
      .then((r) => { if (alive) setBrowse(r.items); })
      // 拉不到主列表不该盖住整屏 —— 站点匹配还在，那才是最常见的用法
      .catch(() => { if (alive) setBrowse([]); });
    return () => { alive = false; };
  }, [status?.unlocked]);

  useEffect(() => {
    if (!status?.unlocked) { setFolders([]); return; }
    let alive = true;
    void send<{ folders: { id: string; name: string }[] }>({ type: 'coffer:folders' })
      .then((r) => { if (alive) setFolders(r.folders); })
      .catch(() => { if (alive) setFolders([]); });
    return () => { alive = false; };
  }, [status?.unlocked]);

  useEffect(() => {
    if (dest !== 'security' || !status?.unlocked) { setReport(null); return; }
    let alive = true;
    void send<{ report: ReportBrief | null }>({ type: 'coffer:security' })
      .then((r) => { if (alive) setReport(r.report); })
      .catch(() => { if (alive) setReport(null); });
    return () => { alive = false; };
  }, [dest, status?.unlocked]);

  useEffect(() => {
    const q = query.trim();
    if (q === '') { setHits(null); return; }
    let alive = true;
    setHits(null);
    /*
     * 防抖：每敲一个字都发一条消息会把 service worker 反复唤醒
     * （它空闲约 30 秒就被杀，每次都重新求值一遍整个模块）。
     */
    const t = setTimeout(() => {
      void send<{ items: ItemSummary[] }>({ type: 'coffer:search', query: q })
        .then((r) => { if (alive) setHits(r.items); })
        .catch(() => { if (alive) setHits([]); });
    }, 120);
    return () => { alive = false; clearTimeout(t); };
  }, [query]);

  /** 填充一条。抽出来是因为现在有**三个**列表可能触发它（本站 / 其他 / 搜索结果） */
  const fill = useCallback(async (itemId: string) => {
    if (tabId === undefined) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await send<{ ok: boolean; failed: unknown[] }>({
        type: 'coffer:fill', itemId, tabId,
      });
      if (r.ok) { setNotice('已填充'); window.close(); }
      else setError(`有 ${r.failed.length} 个字段没填成功 —— 页面可能改版了`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '填充失败');
    } finally { setBusy(false); }
  }, [tabId]);

  const refresh = useCallback(async () => {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    setTabUrl(tab?.url ?? '');
    setTabId(tab?.id);

    const st = await send<Status>({ type: 'coffer:status' });
    setStatus(st);
    if (!st.unlocked || !tab?.url) { setItems([]); setPending(null); return; }

    const { pending: p } = await send<{ pending: Pending | null }>({
      type: 'coffer:pending', ...(tab.id === undefined ? {} : { tabId: tab.id }),
    });
    setPending(p);

    // ⚠️ 匹配交给 background 做：它手里是**完整的**条目（含每个网址的
    // `match` 类型），而列表接口刻意只回摘要。把匹配放在这边就得先把
    // 完整 uris 送过来，那等于为了省一次消息把攻击面扩大一圈。
    const { items: matched } = await send<{ items: ItemSummary[] }>({
      type: 'coffer:matches', url: tab.url,
    });
    setItems(matched);
  }, []);

  useEffect(() => { void refresh().catch((e: unknown) => setError(String(e))); }, [refresh]);

  if (status === null) {
    return (
      <div className="flex flex-col">
        <PopupBand />
        <p className="p-4 text-sm text-[var(--ink-tertiary)]">正在载入…</p>
      </div>
    );
  }

  /*
   * 详情层要找得到那一条 —— 从三个列表里找，而不是只看当前这一个：
   * 用户可能搜完、点进去、又把搜索清掉，那时候当前列表里已经没有它了。
   */
  const openItem = openId === null ? null
    : [...items, ...browse, ...(hits ?? [])].find((i) => i.id === openId) ?? null;

  /** 当前分类里有没有这一条。分类体系和桌面端侧栏是同一套 —— 见 `Rail.tsx` */
  const inDest = (i: ItemSummary): boolean => {
    switch (dest) {
      case 'all': return true;
      case 'favorites': return i.favorite;
      case 'generator': return false;
      /* 安全报告、生成器、导入都不是筛选 —— 它们整屏替换列表 */
      case 'security': return false;
      case 'import': return false;
      default:
        return dest.startsWith('folder:')
          ? i.folderId === dest.slice('folder:'.length)
          : `type:${i.type}` === dest;
    }
  };

  return (
    /*
      布局类来自 `@coffer/ui/components.css` —— 和桌面端共用同一套容器查询。
      窄的时候详情盖住列表，宽的时候并排（见那边 `.vault-shell` 顶部的说明）。

      显式的宽和高，而不是让内容撑。弹窗该是个稳定的「窗口」：切分类、
      进详情都不该让它忽大忽小。560 留了余量（Chrome 的弹窗上限是 600）。

      ⚠️ **宽度这一条是必须的，不是审美选择。** `.vault-shell` 上有
      `container-type: inline-size`，而 inline-size 容器**算宽度时假装自己
      没有内容** —— 浏览器弹窗恰恰是按内容撑开的，于是它算出 0 宽，
      整个弹窗缩成一条线。桌面端没这个问题：Tauri 窗口有固定尺寸。

      （preview 截图也抓不到这个：截图工具总是给一个固定视口宽度，
      所以「弹窗撑不开」它看不见 —— 那是那个仪器的一个盲区。）
    */
    <div className="screen-in vault-shell h-[560px] w-[440px]">
      {/*
        ⚠️ 这个导航栏**和桌面端是同一个组件**（`@coffer/ui` 的 `NavRail`）——
        折叠 80 / 展开 214 是同一份条目的两种排布，不是两套实现。
        内容由这里给：桌面端多出文件夹、安全报告、导入，弹窗没有那些能力。
      */}
      {/*
        ⚠️ 详情层开着时**不渲染导航**。
        详情是一整屏（盖住列表），它自己那条 app bar 的左上角是**返回箭头** ——
        导航按钮也在那儿的话两者会撞在一起，而返回是那一屏唯一的退路。
        Material 同样把「详情屏」当作不暴露导航的一层。
      */}
      {openItem === null && (
      <NavDrawer
        label="保险库导航"
        current={dest}
        onSelect={(k) => { setDest(k as Destination); setOpenId(null); }}
        brand={
          <>
            <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[7px] bg-[var(--accent)] text-[var(--accent-ink)]">
              <IconLock size={13} />
            </span>
            <span className="min-w-0 truncate text-lg font-semibold tracking-[-0.01em]">Coffer</span>
          </>
        }
        groups={[
          {
            key: 'main',
            entries: [
              { key: 'all', label: '全部', icon: <IconItems size={20} /> },
              { key: 'favorites', label: '收藏', icon: <IconStar size={20} /> },
            ],
          },
          { key: 'types', title: '类别', entries: railTypes },
          /*
           * 文件夹分组。空库时**整个不出现** —— 和桌面端同一条规则
           * （「列一堆 0 既占地方，又让人以为自己的东西少了」）。
           */
          ...(folders.length > 0
            ? [{
                key: 'folders',
                title: '文件夹',
                entries: folders.map((f) => ({
                  key: `folder:${f.id}`,
                  label: f.name,
                  icon: <IconFolder size={20} />,
                })),
              }]
            : []),
          {
            key: 'tools',
            entries: [
              { key: 'security', label: '安全报告', icon: <IconShield size={20} /> },
              { key: 'import', label: '导入', icon: <IconImport size={20} /> },
              { key: 'generator', label: '生成', icon: <IconDice size={20} /> },
            ],
          },
        ]}
        footer={
          <NavRow
            entry={{ key: '__lock', label: '锁定', icon: <IconLock size={20} /> }}
            active={false}
            expanded
            onClick={() => {
              void (async () => {
                await send({ type: 'coffer:lock' });
                setOpenId(null);
                await refresh();
              })();
            }}
          />
        }
      />
      )}

      {/*
        ⚠️ **和桌面端同一个组件**（`@coffer/ui` 的 `ItemEditor`）。
        这里以浮层形式盖住 440px 的弹窗，桌面端是同一个浮层的宽版 ——
        要不要改成内联（不盖）是以后的事，先把「能新建」补上。

        `folders` 从已经拉回来的那份映射，不为它多发一次请求。
      */}
      <ItemEditor
        folders={folders.map((f) => ({ ...f, nameFailed: false, updatedAt: '' }))}
        onSave={async (draft) => {
          // 加密和落盘在后台 —— 弹窗不碰密钥
          const r = await send<{ item: VaultItem }>({ type: 'coffer:save-item', draft });
          await refresh();
          return r.item;
        }}
        item={null}
        open={editorOpen}
        onCancel={() => setEditorOpen(false)}
        onDone={() => setEditorOpen(false)}
      />

      <div className="vault-content" data-detail={openItem !== null}>
        {/*
          ⚠️ 只在**已解锁**时走这条全局横幅。未解锁时错误由 `ConnectScreen`
          自己画在表单下面 —— 那边和桌面端同一个位置，两处都画就成了同一条
          错误显示两遍。
        */}
        {error && status.unlocked && (
          <div className="shrink-0 px-3.5 pt-3"><Note tone="risk">{error}</Note></div>
        )}
        {notice && (
          <div className="shrink-0 px-3.5 pt-3"><Note tone="accent">{notice}</Note></div>
        )}

        <div className="vault-list">
        {!status.unlocked ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
            {/*
              ⚠️ **和桌面端同一个组件**：账户列表、快速解锁、完整表单、
              两步验证全在里面。这里以前是一份只有「完整表单 + 两步验证」的
              简化版 —— 回访用户每次打开弹窗都要重新敲服务器地址和邮箱，
              而这个自托管客户端上回访是**多数**。
            */}
            <ConnectScreen
              accounts={accounts}
              busy={busy}
              error={error}
              challenge={challenge}
              /* 扩展端**不传** `cert`：TLS 校验在浏览器手里，没有探测证书
                 这条路。自签证书只能靠系统信任库解决。 */
              onSubmit={async (c) => {
                setBusy(true); setError(null);
                try {
                  const r = await send<{ ok: boolean; twoFactor?: { providers: number[] } }>({
                    type: 'coffer:connect', ...c,
                  });
                  /*
                   * ⚠️ 两步验证**不是错误** —— 是流程的下一步。
                   * 以前这里没有这个分支，challenge 被当异常抛上来、
                   * 当成一般错误显示，用户永远没有输入验证码的机会。
                   */
                  if (r.twoFactor) { setChallenge(r.twoFactor); return; }
                  // 只记住服务器与邮箱 —— **绝不**记住主密码
                  void rememberAccount({ serverUrl: c.serverUrl, email: c.email });
                  await refresh();
                } catch (e) {
                  setError(apiMessageOf(e));
                } finally { setBusy(false); }
              }}
              onTwoFactor={async ({ code, provider, remember }) => {
                setBusy(true); setError(null);
                try {
                  await send({ type: 'coffer:connect-2fa', code, provider, remember });
                  setChallenge(null);
                  await refresh();
                } catch (e) {
                  setError(apiMessageOf(e));
                } finally { setBusy(false); }
              }}
            />
          </div>
        ) : (
          <>
            <header className="flex h-14 shrink-0 items-center border-b border-[var(--border-subtle)] pl-12 pr-3.5">
              <SiteLine url={tabUrl} account={status.account?.email ?? null} />
            </header>

            <div className="flex min-h-0 flex-1 flex-col gap-3 p-3.5">
              {pending && (
                <SavePrompt
                  pending={pending}
                  busy={busy}
                  onSave={async () => {
                    setBusy(true); setError(null);
                    try {
                      await send({ type: 'coffer:save-capture', ...(tabId === undefined ? {} : { tabId }) });
                      setPending(null);
                      setNotice(pending.action === 'update' ? '已更新' : '已保存');
                      window.close();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : '保存失败');
                    } finally { setBusy(false); }
                  }}
                  onDismiss={async () => {
                    await send({ type: 'coffer:dismiss-capture', ...(tabId === undefined ? {} : { tabId }) });
                    setPending(null);
                  }}
                />
              )}

              {dest === 'import' ? (
                <ImportScreen onImported={() => { void refresh(); }} />
              ) : dest === 'security' ? (
                report === null ? (
                  <p className="px-1 py-6 text-center text-xs text-[var(--ink-tertiary)]">正在检查…</p>
                ) : (
                  /*
                   * ⚠️ 和桌面端**同一个组件、同一个 `ReportBrief`**。
                   * 这里改动任何显示逻辑之前先想清楚：它同时是 PC 版那一页。
                   */
                  <SecurityReportView
                    report={{ ...report, breached: breach.found }}
                    nameOf={(id) => browse.find((b) => b.id === id)?.name ?? '(已不在列表里)'}
                    breach={{ state: breach.state, onEnable: () => { void enableBreachCheck(); } }}
                  />
                )
              ) : dest === 'generator' ? (
                /*
                 * ⚠️ 和桌面端**同一个** `GeneratorBody`。
                 * 这里以前是本文件里写的一个简化版：没有口令、只有两类字符，
                 * 而且结果被 `truncate` 截断 —— 生成 64 位密码，屏幕上只有
                 * `aB3$x…`，而用户正要把它抄走。
                 *
                 * 桌面端那个是浮层，这里不是（弹窗整屏就 440px，浮层没意义）——
                 * **两个外壳，一份内容**。
                 */
                <GeneratorBody className="min-h-0 flex-1 overflow-y-auto px-4 py-5" />
              ) : (
                <>
                  {/*
                    ⚠️ 导航开关 —— 和桌面端**同一条位置**：搜索框前面。

                    它一度不在这里，而理由是样式表里的一句话：「弹窗恒为抽屉，
                    所以不需要开关」。那句话把**状态**当成了**入口** ——
                    抽屉确实是恒开的那一档，但抽屉在流里宽度是 0（面板绝对定位），
                    而能打开它的三条规则（触发器 hover / 抽屉 hover / focus-within）
                    没有一条够得着。**结果是弹窗的导航根本打不开**：
                    没有侧栏、没有按钮，除了鼠标乱划没有任何路径。

                    这就是「两端各写一遍」那一族的又一次现身 —— 桌面端有这个按钮，
                    弹窗没有，而没有任何东西会报错。
                  */}
                  <div className="flex items-center gap-1.5">
                    <NavTrigger />
                    <div className="min-w-0 flex-1">
                      <SearchBox value={query} onChange={setQuery} />
                    </div>
                    {/* 新建。和桌面端一样在搜索框**后面** —— 主操作靠边，
                        搜索靠内容 */}
                    <button
                      type="button"
                      onClick={() => setEditorOpen(true)}
                      aria-label="新建条目"
                      title="新建条目"
                      className="btn btn-quiet shrink-0 p-1.5"
                    >
                      <IconPlus size={16} />
                    </button>
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                    {query.trim() !== '' ? (
                      hits === null ? (
                        <p className="px-1 py-4 text-center text-xs text-[var(--ink-tertiary)]">
                          正在搜索…
                        </p>
                      ) : hits.filter(inDest).length === 0 ? (
                        <Empty
                          reason={`没有找到和「${query.trim()}」有关的条目`}
                          hint="搜索会匹配名称、用户名、网址和备注"
                        />
                      ) : (
                        <ListSection
                          label={null}
                          items={hits.filter(inDest)}
                          icons={icons}
                          onOpen={setOpenId}
                        />
                      )
                    ) : (
                      <>
                        {dest === 'all' && items.length > 0 && (
                          <ListSection label="此站点" items={items} icons={icons} onOpen={setOpenId} />
                        )}
                        {/*
                          ⚠️ 没有匹配时**不能只给一句空状态** —— 那是一条死胡同。
                          改成一句提示 + 下面的完整列表：用户仍然够得到保险库里
                          别的东西，而这本来就是打开弹窗的常见理由之一。
                        */}
                        {dest === 'all' && items.length === 0 && tabUrl !== '' && (
                          <p className="px-2 text-2xs leading-relaxed text-[var(--ink-tertiary)]">
                            这个站点还没有匹配的条目 —— 在 Coffer 里给条目加上网址，这里就能匹配到
                          </p>
                        )}
                        <ListSection
                          label={dest === 'all' && items.length > 0 ? '其他条目' : null}
                          items={browse
                            .filter(inDest)
                            .filter((b) => !(dest === 'all' && items.some((m) => m.id === b.id)))}
                          icons={icons}
                          onOpen={setOpenId}
                        />
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        )}
        </div>

        {/*
          第三层。**常驻**，不随选中与否挂卸 —— 两个理由：
          · 退回来时滚动位置和搜索词都还在（早先条件渲染等于重建一次列表）
          · 宽屏下它是一栏，没选中时就该在那里显示占位（和桌面端一致）

          窄屏时它绝对定位盖住列表，`data-detail='false'` 会让它整块不显示 ——
          否则用户打开弹窗看到的是一句「选一条」，而列表不见了。
        */}
        {status.unlocked && (
          <div className="vault-detail">
            {openItem !== null ? (
              /* 「返回」是这个浮层唯一的退路，所以 app bar 必须在 */
              <ItemDetail
                item={openItem}
                icons={icons}
                busy={busy}
                onBack={() => setOpenId(null)}
                onFill={() => { void fill(openItem.id); }}
              />
            ) : (
              <EmptyDetail />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 顶部带子 —— 和其他界面同一条高度，弹窗里也保持这个骨架 */
function PopupBand({ unlocked, onLock }: { unlocked?: boolean; onLock?: () => void }) {
  return (
    <header className="band">
      <span className="grid h-[22px] w-[22px] place-items-center rounded-[7px] bg-[var(--accent)] text-[var(--accent-ink)]">
        <IconLock size={13} />
      </span>
      <span className="min-w-0 flex-1 truncate text-lg font-semibold tracking-[-0.01em]">
        Coffer
      </span>
      {unlocked && onLock && (
        <button onClick={onLock} className="btn btn-ghost gap-1.5" title="锁定保险库">
          <IconLock size={13} />
          锁定
        </button>
      )}
    </header>
  );
}

/**
 * 「要保存这条登录吗？」
 *
 * 放在最上面 —— 它是当前唯一需要用户做决定的东西。列表只是备选。
 * 措辞上明确说出是**哪个账号**：用户在同一个站点可能有多个账号，
 * 一句笼统的「保存密码？」会让他不知道该不该点。
 */
function SavePrompt({ pending, busy, onSave, onDismiss }: {
  pending: Pending;
  busy: boolean;
  onSave: () => void;
  onDismiss: () => void;
}) {
  let host = pending.url;
  try { host = new URL(pending.url).host; } catch { /* 原样显示 */ }

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--accent)] bg-[var(--accent-tint)] p-3">
      <p className="text-sm font-medium">
        {pending.action === 'update' ? '更新这条登录？' : '保存这条登录？'}
      </p>
      <p className="mt-0.5 truncate text-xs text-[var(--ink-secondary)]" title={pending.url}>
        {host}
        {pending.username ? ` · ${pending.username}` : ''}
      </p>
      <div className="mt-3 flex gap-2">
        <button onClick={onSave} disabled={busy} className="btn btn-primary flex-1 py-2">
          {busy ? '保存中…' : pending.action === 'update' ? '更新' : '保存'}
        </button>
        <button onClick={onDismiss} disabled={busy} className="btn btn-quiet py-2">不用</button>
      </div>
    </div>
  );
}

/** 当前站点 + 是哪个账户 —— 两个都要说，用户可能在多个账户间开着同一个站点 */
function SiteLine({ url, account }: { url: string; account: string | null }) {
  let host = url;
  try { host = new URL(url).host; } catch { /* 不是网址就原样显示 */ }
  return (
    <div className="flex items-center gap-2 px-0.5">
      <IconGlobe size={13} className="shrink-0 text-[var(--ink-tertiary)]" />
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--ink-secondary)]" title={url}>
        {host || '（无站点）'}
      </span>
      {account && (
        <span className="min-w-0 max-w-[45%] shrink-0 truncate text-xs text-[var(--ink-tertiary)]" title={account}>
          {account}
        </span>
      )}
    </div>
  );
}

/**
 * 一条匹配到的记录。
 *
 * 主力动作是**填充**，但 1Password 扩展里用得最多的其实是**复制** ——
 * 用户常常是「复制密码 → 去别处粘贴」，而不是在网页表单里填。
 * 所以两者都得在，而且复制要够快（一次点击，不用展开菜单）。
 */
/*
 * 条目在列表里的一行现在是 `@coffer/ui` 的 `ItemRow` —— 和桌面端**同一个**。
 * 这里早先那份把「填充 / 复制用户名 / 复制密码 / 复制验证码 / 30 秒后清空」
 * 全铺在行里，于是每条又宽又高。那些动作现在住第三层（`ItemDetail.tsx`）。
 */

/**
 * 搜索框。
 *
 * 没有它的话，「找不到匹配」的站点就是条死胡同 —— 用户没法去够保险库里
 * 别的东西。有了它，弹窗从「这个站点的查看器」变成「保险库的入口」。
 *
 * 用 `<label>` 包住输入框而不是配一个 `aria-label`：整块可点，
 * 点图标和留白处都能聚焦，弹窗里这一下省得不小。
 */
function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-paper)] px-2.5 py-1.5 transition-colors duration-[var(--dur-fast)] focus-within:border-[var(--accent)]">
      <IconSearch size={14} className="shrink-0 text-[var(--ink-tertiary)]" />
      <input
        type="search"
        value={value}
        placeholder="搜索保险库"
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink-primary)] outline-none placeholder:text-[var(--ink-tertiary)]"
      />
      {value !== '' && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="清除搜索"
          className="shrink-0 text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:text-[var(--ink-secondary)]"
        >
          <IconClose size={13} />
        </button>
      )}
    </label>
  );
}

/**
 * 一组带标题的条目。
 *
 * 分组标题是这里唯一的层级信号 —— 弹窗里没有侧栏、没有面包屑，
 * 「这些是本站的」和「这些是别的」只能靠一行小字说清楚。
 * 空组**整个不渲染**（包括标题）：标题下面什么都没有比没有标题更糟。
 */
/**
 * 一组条目。
 *
 * 行的本体来自 `@coffer/ui` 的 `ItemRow`（桌面端用同一个），这里只负责
 * 分组标题和「点进去」这件事。
 */
function ListSection({ label, items, icons, onOpen }: {
  label: string | null;
  items: ItemSummary[];
  icons: IconStore | null;
  onOpen: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-0.5">
      {label !== null && (
        <h2 className="px-2 pb-1 text-2xs font-medium text-[var(--ink-tertiary)]">{label}</h2>
      )}
      {items.map((it) => (
        <ItemRow
          key={it.id}
          icon={
            /* ⚠️ 走 `ItemIcon`，不直接调 `IconGlyph` —— 和桌面端同一条路径 */
            <ItemIcon
              iconDomain={it.iconDomain}
              text={it.avatarText}
              hue={it.avatarHue}
              type={it.type}
              store={icons}
            />
          }
          name={it.name}
          summary={it.summary}
          favorite={it.favorite}
          onClick={() => onOpen(it.id)}
        />
      ))}
    </section>
  );
}

/**
 * 导入 —— 和桌面端**同一套逻辑**（`@coffer/vault` 的 `parseImport` /
 * `importItems`），只是跑在后台。
 *
 * ⚠️ **两步，不是一步**：选完文件先看预览（多少条、多少文件夹、跳过多少行），
 * 确认了才真写。选错文件会让库里多出一堆垃圾，而删除比导入麻烦得多。
 */
/**
 * 导入 —— **界面本体和桌面端同一份**（`@coffer/ui` 的 `ImportView`）。
 *
 * 这里只有数据通道：弹窗**刻意**拿不到解析出来的明文条目（spec 不变量 S1），
 * 所以文件字节 base64 之后发给后台，由后台解析。
 *
 * ⚠️ 这份以前是个只报个数的简化版：「跳过 3 行 / 格式不认」、
 * 「已导入 187 条，3 条失败」—— **没有行号、没有原因、没有名字**。
 * 而导入是一次性、不可重来的操作，一条丢掉的密码要到几个月后登录
 * 某个网站时才会被发现，那时候已经无从回想是哪一步丢的。
 */
function ImportScreen({ onImported }: { onImported: () => void }) {
  const [data, setData] = useState<{ name: string; base64: string; bytes: Uint8Array } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportOutcome | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * 解析一份（或**换一个格式重解析同一份**）。
   *
   * ⚠️ `format` 一定要传下去：后台那边**用户显式选择压过自动识别**。
   * 不传的话换格式那个下拉就是个摆设。
   */
  async function parse(base64: string, fileName: string, format: ImportFormatId): Promise<void> {
    setError(null); setResult(null); setPreview(null);
    try {
      const r = await send<Omit<ImportPreview, 'fileName'>>({
        type: 'coffer:import-parse', dataBase64: base64, format,
      });
      setPreview({ ...r, fileName });
    } catch (e) {
      // 解析失败**留在原地**（文件还在），用户可以直接换个格式再试 ——
      // 而不是被退回选文件那一步，让他以为自己选错了文件
      setError(apiMessageOf(e));
    }
  }

  async function pick(file: File): Promise<void> {
    setError(null); setResult(null); setPreview(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // 二进制过消息通道必须 base64 —— 见后台 `coffer:import-parse` 的说明
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      const base64 = btoa(bin);
      setData({ name: file.name, base64, bytes });
      await parse(base64, file.name, 'auto');
    } catch (e) {
      setError(e instanceof Error ? e.message : '读不出这个文件');
    }
  }

  async function commit(): Promise<void> {
    if (data === null || preview === null) return;
    setProgress({ done: 0, total: preview.total });
    setError(null);
    try {
      const r = await send<ImportOutcome>({
        type: 'coffer:import-commit', dataBase64: data.base64, format: preview.format,
      });
      setResult(r);
      setPreview(null);
      onImported();
    } catch (e) {
      setError(apiMessageOf(e));
    } finally { setProgress(null); }
  }

  /*
   * 自动识别在这里算，不在后台 —— `detectImportFormat` 只看文件头，
   * 而**字节本来就在弹窗手里**（是它读的文件）。让后台多回一个字段的话，
   * 那个字段的含义会随「用户有没有手动选过」而变，是个容易搞错的状态。
   */
  const autoFormat = data === null ? null : detectImportFormat(data.bytes);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
      <ImportView
        preview={preview}
        progress={progress}
        result={result}
        error={error}
        hasFile={data !== null}
        autoFormat={autoFormat}
        onPick={(f) => { void pick(f); }}
        onFormatChange={(f) => {
          if (data !== null) void parse(data.base64, data.name, f);
        }}
        onRun={() => { void commit(); }}
        onReset={() => { setPreview(null); setResult(null); setError(null); setData(null); }}
      />
    </div>
  );
}

function EmptyDetail() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-[var(--radius-md)] bg-[var(--surface-well)] text-[var(--ink-tertiary)]">
        <IconKeyboard size={18} />
      </span>
      <p className="text-sm text-[var(--ink-secondary)]">选一条查看详情</p>
    </div>
  );
}

/** 空状态要说明**为什么**空，并给出下一步 —— 一句「没有结果」等于没说 */
function Empty({ reason, hint }: { reason: string; hint: string }) {
  return (
    <div className="card-well px-4 py-7 text-center">
      <span className="mx-auto mb-2.5 grid h-9 w-9 place-items-center rounded-full bg-[var(--surface-paper)] text-[var(--ink-tertiary)]">
        <IconSearch size={17} />
      </span>
      <p className="text-sm text-[var(--ink-secondary)]">{reason}</p>
      <p className="mt-1 text-xs text-[var(--ink-tertiary)]">{hint}</p>
    </div>
  );
}

function Note({ tone, children }: { tone: 'risk' | 'accent'; children: React.ReactNode }) {
  const color = tone === 'risk' ? 'var(--risk)' : 'var(--ink-secondary)';
  return (
    <p className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-well)] px-3 py-2 text-sm"
      role="status">
      {tone === 'risk' && <IconAlert size={14} className="mt-0.5 shrink-0" style={{ color }} />}
      <span className="min-w-0 flex-1" style={{ color }}>{children}</span>
    </p>
  );
}

/* 图标从 `@coffer/ui` 来 —— 和桌面端**同一份**。
 *
 * 这里原本有一份自己的拷贝，上面写着「两个 app 之间没有共享包，
 * 为一个图标集建一个不划算」。现在有了，而那份拷贝已经开始长歪：
 * 它的大小默认值是 14 而桌面端是 16；它不接受 `className`，
 * 于是弹窗里四处 `className=` 一直是**类型错误** ——
 * 只是从来没人在扩展端跑过 `tsc`（见根 tsconfig 的说明）。
 *
 * 「同一套画法写两遍」和「写一份」的差别，就在这几处。
 */
