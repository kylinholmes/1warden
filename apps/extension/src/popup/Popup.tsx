import { ext } from '../ext-api';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { generatePassword, passwordStrength } from '@coffer/crypto';
import { IconStore } from '@coffer/vault';

import {
  CopyButton, IconAlert, IconClose, IconDice, IconGlobe, IconGlyph, IconItems, IconKey,
  IconFolder, IconImport, IconKeyboard, IconLock, IconSearch, IconShield, IconSpinner, IconStar,
  ItemRow, NavDrawer, NavRow, Section,
  GRADE_LABEL, STRENGTH_LABELS, WEAK_REASON, apiMessageOf, countByType, crackSentence,
  host, iconStoreFor,
  scheduleClipboardClear, typeDestinations,
} from '@coffer/ui';

/** 导航目的地的键。类型项是 `type:<条目类型>` —— 见 `@coffer/ui` 的 destinations */
type Destination =
  | 'all' | 'favorites' | 'generator' | 'security' | 'import'
  | `type:${string}` | `folder:${string}`;

/**
 * 安全报告的**展示形态** —— 后台把 `VaultItem` 降级成了 id/名字，
 * 完整条目不出后台（见 `coffer:security` 的说明）。
 */
interface ReportBrief {
  total: number;
  score: number;
  grade: 'excellent' | 'good' | 'fair' | 'poor' | 'critical';
  reused: { itemIds: string[]; count: number }[];
  weak: { itemId: string; reason: string }[];
  expiring: { itemId: string; expiresAt: string }[];
  unsecured: { id: string; name: string }[];
}



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
  const [openId, setOpenId] = useState<string | null>(null);

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

      <div className="vault-content" data-detail={openItem !== null}>
        {error && (
          <div className="shrink-0 px-3.5 pt-3"><Note tone="risk">{error}</Note></div>
        )}
        {notice && (
          <div className="shrink-0 px-3.5 pt-3"><Note tone="accent">{notice}</Note></div>
        )}

        <div className="vault-list">
        {!status.unlocked ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
            <ConnectForm busy={busy} onSubmit={async (p) => {
              setBusy(true); setError(null);
              try {
                await send({ type: 'coffer:connect', ...p });
                await refresh();
              } catch (e) {
                setError(apiMessageOf(e));
              } finally { setBusy(false); }
            }} />
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
                <SecurityReport
                  report={report}
                  nameOf={(id) => browse.find((b) => b.id === id)?.name ?? '(已不在列表里)'}
                />
              ) : dest === 'generator' ? (
                <Generator />
              ) : (
                <>
                  <SearchBox value={query} onChange={setQuery} />

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
            <IconGlyph
              domain={it.iconDomain}
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
 * 安全报告 —— 和桌面端**同一份逻辑**（`@coffer/vault` 的 `buildReport`），
 * 只是算在后台、这里只负责显示。
 *
 * ⚠️ 每一项都只列**名字**：报告里的条目引用在后台就降级成了 id/名字，
 * 完整条目（带明文密码）不出后台。
 */
function SecurityReport({ report, nameOf }: {
  report: ReportBrief | null;
  /** 报告里只有 id —— 名字从已经加载的列表里查 */
  nameOf: (id: string) => string;
}) {
  if (report === null) {
    return <p className="px-1 py-6 text-center text-xs text-[var(--ink-tertiary)]">正在检查…</p>;
  }

  const risk = report.grade === 'critical' || report.grade === 'poor';
  const groups: { key: string; title: string; rows: { id: string; label: string; note: string }[] }[] = [
    {
      key: 'weak',
      title: `弱密码（${report.weak.length}）`,
      rows: report.weak.map((w) => ({
        id: w.itemId,
        label: nameOf(w.itemId),
        note: WEAK_REASON[w.reason] ?? w.reason,
      })),
    },
    {
      key: 'reused',
      title: `重复使用（${report.reused.reduce((n, g) => n + g.count, 0)}）`,
      rows: report.reused.flatMap((g) => g.itemIds.map((id) => ({
        id, label: nameOf(id), note: `${g.count} 条共用`,
      }))),
    },
    {
      key: 'unsecured',
      title: `明文站点（${report.unsecured.length}）`,
      rows: report.unsecured.map((u) => ({ id: u.id, label: u.name, note: '网址是 http' })),
    },
  ].filter((g) => g.rows.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {/*
        ⚠️ `shrink-0` 不能省：这是 flex 纵列的子项，而 flex 子项默认
        `flex-shrink: 1` —— 内容比容器高时它会被**压扁**，加上 `.card`
        自带的 `overflow: hidden`，分数就被裁掉一半。
      */}
      <div className="card shrink-0 p-3.5">
        <div className="flex items-baseline gap-2">
          <span className={`text-2xl font-semibold tabular-nums ${risk ? 'text-[var(--risk)]' : 'text-[var(--safe)]'}`}>
            {report.score}
          </span>
          <span className="text-md text-[var(--ink-secondary)]">{GRADE_LABEL[report.grade]}</span>
          <span className="ml-auto text-xs text-[var(--ink-tertiary)]">{report.total} 条记录</span>
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-[var(--ink-tertiary)]">
          没有发现明显的问题
        </p>
      ) : (
        groups.map((g) => (
          <Section key={g.key} title={g.title}>
            {g.rows.map((r, i) => (
              <div key={`${r.id}-${i}`} className="flex items-center gap-3 border-b border-[var(--border-subtle)] py-2 last:border-b-0">
                <span className="min-w-0 flex-1 truncate text-md">{r.label}</span>
                <span className="shrink-0 text-xs text-[var(--ink-tertiary)]">{r.note}</span>
              </div>
            ))}
          </Section>
        ))
      )}

      <p className="px-1 text-2xs leading-relaxed text-[var(--ink-tertiary)]">
        这只是本地检查。已泄露密码的查询（Have I Been Pwned）需要单独开启，
        因为它是本应用唯一会联系第三方的功能。
      </p>
    </div>
  );
}

/**
 * 导入 —— 和桌面端**同一套逻辑**（`@coffer/vault` 的 `parseImport` /
 * `importItems`），只是跑在后台。
 *
 * ⚠️ **两步，不是一步**：选完文件先看预览（多少条、多少文件夹、跳过多少行），
 * 确认了才真写。选错文件会让库里多出一堆垃圾，而删除比导入麻烦得多。
 */
function ImportScreen({ onImported }: { onImported: () => void }) {
  const [data, setData] = useState<{ name: string; base64: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<{ created: number; failed: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File): Promise<void> {
    setBusy(true); setError(null); setPreview(null); setDone(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      // 二进制过消息通道必须 base64 —— 见后台 `coffer:import-parse` 的说明
      let bin = '';
      for (const b of buf) bin += String.fromCharCode(b);
      const base64 = btoa(bin);
      setData({ name: file.name, base64 });
      setPreview(await send<Preview>({ type: 'coffer:import-parse', dataBase64: base64 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : '读不出这个文件');
    } finally { setBusy(false); }
  }

  async function commit(): Promise<void> {
    if (data === null) return;
    setBusy(true); setError(null);
    try {
      const r = await send<{ created: number; failed: unknown[] }>({
        type: 'coffer:import-commit', dataBase64: data.base64,
      });
      setDone({ created: r.created, failed: r.failed.length });
      setPreview(null);
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败');
    } finally { setBusy(false); }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <label className={`btn btn-quiet w-full cursor-default py-2.5 ${busy ? 'opacity-45' : ''}`}>
        选择文件
        <input
          type="file" accept=".1pux,.csv,.json,.kdbx,.xml" className="hidden"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pick(f);
            e.target.value = '';   // 同一个文件选两次也要能触发
          }}
        />
      </label>

      {preview !== null && (
        <Section title="将要导入">
          <div className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1 truncate text-md">{data?.name}</span>
            <span className="shrink-0 text-xs text-[var(--ink-tertiary)]">{preview.formatLabel}</span>
          </div>
          <div className="flex items-center gap-3 border-t border-[var(--border-subtle)] py-2">
            <span className="min-w-0 flex-1 text-md">{preview.items} 条记录</span>
            <span className="shrink-0 text-xs text-[var(--ink-tertiary)]">
              {preview.folders} 个文件夹
            </span>
          </div>
          {preview.skipped > 0 && (
            <div className="flex items-center gap-3 border-t border-[var(--border-subtle)] py-2">
              <span className="min-w-0 flex-1 text-md text-[var(--caution)]">
                跳过 {preview.skipped} 行
              </span>
              <span className="shrink-0 text-xs text-[var(--ink-tertiary)]">格式不认</span>
            </div>
          )}
        </Section>
      )}

      {preview !== null && (
        <button type="button" onClick={() => { void commit(); }} disabled={busy}
          className="btn btn-primary w-full py-2.5">
          {busy ? '正在导入…' : `导入 ${preview.items} 条`}
        </button>
      )}

      {done && (
        <Note tone="accent">
          已导入 {done.created} 条{done.failed > 0 ? `，${done.failed} 条失败` : ''}
        </Note>
      )}

      {error && <Note tone="risk">{error}</Note>}

      <p className="px-1 text-2xs leading-relaxed text-[var(--ink-tertiary)]">
        支持 1PUX（1Password）、Bitwarden JSON、KeePass、CSV。
        文件在本地解析，不会上传到任何地方。
      </p>
    </div>
  );
}

/** `coffer:import-parse` 回的预览 */
interface Preview {
  format: string;
  formatLabel: string;
  folders: number;
  items: number;
  skipped: number;
}

/** 详情栏的占位。宽屏下这一栏一直在这儿，空着要有话说 */
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

/**
 * 连接表单（还没登录时）。
 *
 * 版面对齐桌面端的 `Connect.tsx` —— 两端是同一个产品，这一屏又是新用户
 * 见到的**第一屏**，两边长得不一样的话「统一」就无从谈起。
 *
 * 和早先相比改了三处，都是那一屏显得「丑」的具体原因：
 *
 * 1. **标签可见**，不再靠 placeholder。placeholder 一打字就没了，
 *    用户回看时不知道那一格原来要填什么；读屏软件也读不到它当标签用。
 * 2. **说明文字挪到最下面**。它是一句安心的脚注（「永不发送到服务器」），
 *    不是操作指引，摆在第一个输入框上面会把表单的起点压下去。
 * 3. **间距分组**：字段之间 `gap-4`、按钮和脚注各自分开，
 *    早先全部 `gap-2.5` 等距 —— 等距等于没有分组。
 */
function ConnectForm({ busy, onSubmit }: {
  busy: boolean;
  onSubmit: (p: { serverUrl: string; email: string; masterPassword: string }) => void;
}) {
  const [serverUrl, setServerUrl] = useState('');
  const [email, setEmail] = useState('');
  const [masterPassword, setMasterPassword] = useState('');

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => {
      e.preventDefault();
      onSubmit({ serverUrl: serverUrl.trim(), email: email.trim(), masterPassword });
    }}>
      <h1 className="text-md font-medium text-[var(--ink-secondary)]">
        连接到你的 Vaultwarden
      </h1>

      <Field label="服务器地址">
        <input required type="url" value={serverUrl} autoFocus
          placeholder="https://vault.example.com"
          onChange={(e) => setServerUrl(e.target.value)}
          className="field text-sm" />
      </Field>

      <Field label="邮箱">
        <input required type="email" value={email}
          autoFocus={serverUrl !== ''}
          onChange={(e) => setEmail(e.target.value)}
          className="field text-sm" />
      </Field>

      <Field label="主密码">
        <input required type="password" value={masterPassword} disabled={busy}
          onChange={(e) => setMasterPassword(e.target.value)}
          className="field secret text-sm" />
      </Field>

      <button type="submit" disabled={busy} className="btn btn-primary w-full py-2.5">
        {busy && <IconSpinner size={15} />}
        {busy ? '正在解锁…' : '解锁'}
      </button>

      {/*
        ⚠️ 这里就是将来放「连接到本地 Coffer 服务」的位置 —— 一个安静按钮，
        和上面那个主动作分开。现在不放：一个按不动的入口比没有入口更糟。
      */}
      <p className="text-xs leading-relaxed text-[var(--ink-tertiary)]">
        主密码只在本地用于派生密钥，<strong className="font-medium">永不发送到服务器</strong>。
      </p>
    </form>
  );
}

/** 带可见标签的字段 —— 和桌面端 `Connect.tsx` 里那个一致 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-[var(--ink-secondary)]">
        {label}
      </span>
      {children}
    </label>
  );
}

/** 生成器默认只暴露三项 —— 与 1Password 一致，其余收起来 */
function Generator() {
  const [length, setLength] = useState(20);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [value, setValue] = useState('');

  useEffect(() => {
    setValue(generatePassword({ length, digits, symbols }));
  }, [length, digits, symbols]);

  const strength = value ? passwordStrength(value) : null;

  return (
    <div className="card p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-xs font-medium text-[var(--ink-tertiary)]">
          生成密码
        </span>
        <button onClick={() => setValue(generatePassword({ length, digits, symbols }))}
          className="btn btn-ghost shrink-0">换一个</button>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <code className="secret min-w-0 flex-1 truncate rounded-[var(--radius-sm)] bg-[var(--surface-well)] px-2 py-1.5 text-sm">
          {value}
        </code>
        {/*
          和别处**同一个** `CopyButton` —— 早先这里是内联的一份，
          连「30 秒后按值清空」都自己写了一遍（而且那份定时器随弹窗关闭而消失，
          和详情里走后台离屏文档的那条路径并不一致）。
        */}
        <CopyButton
          getValue={async () => value}
          onCopied={scheduleClipboardClear}
          className="btn btn-quiet shrink-0 gap-1.5 text-[var(--accent)]"
          iconSize={12}
        />
      </div>

      <label className="mt-2.5 flex items-center gap-2 text-xs text-[var(--ink-secondary)]">
        长度
        <input type="range" min={8} max={64} value={length}
          onChange={(e) => setLength(Number(e.target.value))} className="flex-1" />
        <span className="tnum w-6 text-right">{length}</span>
      </label>
      <div className="mt-1.5 flex gap-4 text-xs text-[var(--ink-secondary)]">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={digits} onChange={(e) => setDigits(e.target.checked)} />
          包含数字
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={symbols} onChange={(e) => setSymbols(e.target.checked)} />
          包含符号
        </label>
      </div>

      {strength && (
        <div className="mt-2.5 flex items-center gap-2.5">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--border-subtle)]">
            <div className="h-full rounded-full transition-[width] duration-[var(--dur-base)]" style={{
              width: `${Math.min(100, (strength.score / 4) * 100)}%`,
              background: strength.score >= 3 ? 'var(--safe)' : strength.score >= 2 ? 'var(--caution)' : 'var(--risk)',
            }} />
          </div>
          {/*
            ⚠️ 说的是**结论**，不只是熵值。
            「约 131 位熵」是个没有结论的数字 —— 普通用户不知道 131 是好还是坏。
            词表和桌面端共用（`@coffer/ui` 的 `strength.ts`），两端同一套说法。
          */}
          <span className="shrink-0 text-2xs text-[var(--ink-tertiary)]">
            {STRENGTH_LABELS[strength.score] ?? ''}
          </span>
        </div>
      )}
      {strength && (
        <p className="mt-1 text-2xs text-[var(--ink-tertiary)]">
          {crackSentence(strength.entropyBits, strength.score)}
        </p>
      )}
    </div>
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
