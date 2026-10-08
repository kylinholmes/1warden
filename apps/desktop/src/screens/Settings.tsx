import { useLocalStore, useStoreField } from '@1warden/state/react';
import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { primaryShortcut, quickShortcut, detectOs } from '../platform';
import type { ApplicationClient, ApplicationCapabilities } from '../application/types';
import { BrandMark, FloatingPanel, PageHeader, isCompactLayout, useCompactLayout } from '@1warden/ui';
import { AccountAppearance } from '../components/AccountAppearance';
import {
  IconChevronDown, IconInfo, IconKeyboard, IconPalette, IconShield,
} from '@1warden/ui';

/**
 * 设置面板 —— 容器、分组、交互是真的；**「外观」这一组已经接入**，
 * 其余三组仍是外壳。
 *
 * ## 为什么先把外壳做扎实
 *
 * 设置面板是那种「先有骨架、再长肉」的东西：分组怎么切、窗口多大、
 * 键盘怎么进出，这些定下来之后，往里加一条设置就是加一行。
 * 反过来先做实现，等发现分组不对时，设置项已经到处引用了。
 *
 * ## 占位的诚实
 *
 * 底栏那句「尚未接入」按**分组**说 —— 全部改成「已接入」是撒谎，
 * 而全局留着那句又会让用户以为刚改的主题也没保存。
 * 没接的控件一律 `disabled`，不做「看着能用、点了没反应」的样子：
 * 密码管理器里最不能容忍的就是开关骗人，用户以为自己关掉了
 * 「已泄露检查」，那是个安全问题，不是体验问题。
 *
 * ## 版面
 *
 * 所有平台按可用宽度：足够宽时左右分栏，窄窗口逐级进入子页面。
 * 返回目录时保留刚访问的分组焦点；显式指定 initialSection 时支持直达。
 * 宽屏和主窗口的三栏是同一种骨架的缩小版 ——
 * 面板里的导航栏用 `--surface-chrome`，和主窗口侧栏同一层。
 * 这不是巧合：用户刚从这个面板的「左边那一列」点过来，
 * 那个位置本来就该是同一个东西。
 */

export type SectionId = 'security' | 'appearance' | 'autofill' | 'about';

const SECTIONS: Array<{ id: SectionId; label: string; icon: ReactNode }> = [
  { id: 'security', label: '安全', icon: <IconShield size={16} /> },
  { id: 'appearance', label: '外观', icon: <IconPalette size={16} /> },
  { id: 'autofill', label: '自动填充', icon: <IconKeyboard size={16} /> },
  { id: 'about', label: '关于', icon: <IconInfo size={16} /> },
];

declare const __PLATFORM__: 'desktop' | 'extension' | 'mobile' | undefined;
// Keep this import behind the literal build define so other targets emit no updater chunk.
const DesktopAppUpdates = typeof __PLATFORM__ !== 'undefined' && __PLATFORM__ === 'desktop'
  ? lazy(() => import('../components/AppUpdates')) : null;
const DesktopQuickSearchSettings = typeof __PLATFORM__ !== 'undefined' && __PLATFORM__ === 'desktop'
  ? lazy(() => import('../components/QuickSearchSettings')) : null;

export function Settings({ client, open, onClose, initialSection, capabilities = { native: false, browser: false, saveAttachments: false } }: {
  client?: ApplicationClient;
  open: boolean;
  account: string;
  serverUrl: string;
  onClose: () => void;
  capabilities?: ApplicationCapabilities;
  onDisconnect?: () => Promise<void>;
  /**
   * 打开时停在哪一组。
   *
   * 不是为测试留的口子 —— 它对应一条真实的路径：自动填充失败时，
   * 界面提示「需要辅助功能权限」，用户点过去应该**直接落在
   * 自动填充那一组**，而不是先看到默认分组再自己找。
   */
  initialSection?: SectionId;
}) {
  const compact = useCompactLayout();
  const viewStore = useLocalStore(() => {
    const page = (initialSection ?? (isCompactLayout() ? null : 'appearance')) as SectionId | null;
    return { page };
  });
  const [page, setPage] = useStoreField(viewStore, 'page');
  const section = page ?? 'appearance';
  const showingDirectory = compact && page === null;
  const contentRef = useRef<HTMLDivElement>(null);
  const lastSection = useRef<SectionId>(section);
  useEffect(() => {
    if (open) setPage(initialSection ?? (isCompactLayout() ? null : 'appearance'));
  }, [open, initialSection]);
  // Remember the visible default section when expanding the directory to a wide layout.
  useEffect(() => { if (open && !compact && page === null) setPage('appearance'); }, [open, compact, page]);
  useEffect(() => {
    if (!open || !compact) return;
    if (page) contentRef.current?.focus({ preventScroll: true });
    else document.getElementById(`settings-link-${lastSection.current}`)?.focus({ preventScroll: true });
  }, [open, compact, page]);
  function setSection(next: SectionId) { lastSection.current = next; setPage(next); }
  function back() { setPage(null); }
  /*
   * 主题的真相在 theme.ts、类别开关的真相在 prefs.ts（都是模块级 +
   * localStorage），组件只是它们的视图 ——
   * 在这里单独复制主题的话，预览页或别处改了主题，这个控件不会知道。
   */

  return (
    <FloatingPanel
      open={open}
      onClose={compact && page ? back : onClose}
      labelledBy="settings-title"
      className="h-[min(520px,calc(100vh-32px))] max-w-[640px]"
      footer={
        <>
          {/* 底栏按分组说实话：外观那组的主题是真能用的，其余三组还没接 */}
          <span className="min-w-0 truncate">
            {showingDirectory ? '1Warden' : section === 'appearance'
              ? '主题与类别显示立即生效并自动同步'
              : section === 'security' ? '灰色选项暂不可调整'
              : section === 'autofill' ? '在条目详情中使用自动填充'
              : '1Warden'}
          </span>
          {!compact && <span className="shrink-0">
            <kbd className="text-2xs">esc</kbd> {compact && page ? '返回' : '关闭'}
          </span>}
        </>
      }
    >
      <PageHeader panel title="设置" titleId="settings-title" onBack={compact && page ? back : onClose}
        backLabel={compact && page ? '返回设置目录' : '返回上一页'} onClose={onClose}
        breadcrumbs={showingDirectory ? [{ label: '设置' }] : [
          { label: '设置', ...(compact ? { onSelect: back } : {}) },
          { label: SECTIONS.find(s => s.id === section)!.label },
        ]} />

      <div className="flex min-h-0 flex-1">
        {showingDirectory && <nav aria-label="设置目录" className="min-w-0 flex-1 overflow-y-auto p-4">
          <p className="mb-4 text-sm text-[var(--ink-tertiary)]">调整应用行为与使用偏好</p>
          <div className="card overflow-hidden">
            {SECTIONS.map((s) => <button key={s.id} id={`settings-link-${s.id}`} onClick={() => setSection(s.id)}
              className="flex min-h-14 w-full items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3 text-left last:border-b-0 hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)]">
              <span className="text-[var(--accent)]">{s.icon}</span>
              <span className="flex-1 text-md">{s.label}</span>
              <IconChevronDown size={16} className="-rotate-90 text-[var(--ink-tertiary)]" />
            </button>)}
          </div>
        </nav>}
        {/*
          分组导航用 tab 的语义（role="tablist"）而不是 aria-current 的链接：
          切换分组**不离开**这个面板，右侧内容是同一次交互里的另一块面板 ——
          这正是 tab 的定义。键盘的左右箭头也因此能直接切分组。
        */}
        {!compact && <nav
          role="tablist"
          aria-label="设置分组"
          aria-orientation="vertical"
          className="w-[120px] sm:w-[148px] shrink-0 overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--surface-chrome)] p-2"
        >
          {SECTIONS.map((s) => {
            const active = s.id === section;
            return (
              <button
                key={s.id}
                role="tab"
                id={`settings-tab-${s.id}`}
                aria-selected={active}
                aria-controls={`settings-panel-${s.id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => setSection(s.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                  e.preventDefault();
                  const i = SECTIONS.findIndex((x) => x.id === section);
                  const next = SECTIONS[(i + (e.key === 'ArrowDown' ? 1 : SECTIONS.length - 1)) % SECTIONS.length]!;
                  setSection(next.id);
                  // 焦点跟着选中项走 —— 否则箭头键改了内容而焦点还停在原处，
                  // 下一次 Tab 会从错误的位置继续
                  document.getElementById(`settings-tab-${next.id}`)?.focus();
                }}
                className={`flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-[7px] text-left text-sm transition-colors duration-[var(--dur-fast)] ${
                  active
                    ? 'bg-[var(--surface-selected)] font-medium text-[var(--ink-primary)]'
                    : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]'
                }`}
              >
                <span style={{ color: `var(--${({ account: 'accent', security: 'teal', appearance: 'violet', autofill: 'rose', about: 'accent' })[s.id]})` }}>{s.icon}</span>
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
              </button>
            );
          })}
        </nav>}

        {!showingDirectory && <div
          ref={contentRef}
          role={compact ? 'region' : 'tabpanel'}
          id={`settings-panel-${section}`}
          aria-labelledby={compact ? 'settings-title' : `settings-tab-${section}`}
          tabIndex={-1}
          className="min-w-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 outline-none"
        >
          {section === 'security' && (
            <Group title="安全" hint="锁定与剪贴板的行为">
              <Row label="解锁后自动锁定" hint="解锁 15 分钟后自动锁定；重新打开界面不会延长期限">
                <Select disabled value="15" options={[['5', '5 分钟'], ['15', '15 分钟'], ['60', '1 小时'], ['0', '不自动锁定']]} />
              </Row>
              <Row label="复制后清空剪贴板" hint="只在剪贴板里还是我们写进去的值时才清">
                <Select disabled value="30" options={[['10', '10 秒'], ['30', '30 秒'], ['60', '1 分钟'], ['0', '不清空']]} />
              </Row>
              <Row label="已泄露密码检查" hint="在安全报告中按需开启检查；只发送 SHA-1 哈希的前 5 个字符" />
            </Group>
          )}

          {section === 'appearance' && (<div className="space-y-6">
            <AccountAppearance {...(client ? { client } : {})} />
            {DesktopQuickSearchSettings && capabilities.native && <Suspense fallback={null}><DesktopQuickSearchSettings /></Suspense>}
          </div>)}

          {section === 'autofill' && (
            <Group title="自动填充" hint={capabilities.browser ? '在当前浏览器中使用已保存的登录' : '让密码进到其他应用里'}>
              {capabilities.browser && <>
                <Row label="填充到当前页面" hint="打开登录条目的详情后点击填充；当前网站的匹配项显示在列表上方" />
                <Row label="保存登录" hint="在网站登录后，可在列表上方保存或更新登录信息" />
              </>}
              {capabilities.native && <>
                <Row label="桌面自动填充" hint={detectOs() === 'win' ? '在条目详情中向当前窗口发送按键；不支持管理员权限窗口' : '在条目详情中输入到其他应用；需要辅助功能权限'} />
                <Row label="快速面板快捷键"><Kbd>{quickShortcut()}</Kbd></Row>
              </>}
              {!capabilities.native && !capabilities.browser && <Row label="复制登录信息" hint="在条目详情中复制用户名、密码或验证码" />}
            </Group>
          )}

          {section === 'about' && (
            <Group title="关于" hint="1Warden">
              <div className="flex items-center gap-3 py-4"><BrandMark size={48} /><span className="text-lg font-semibold">1Warden</span></div>
              {DesktopAppUpdates && capabilities.native && <Suspense fallback={null}><DesktopAppUpdates /></Suspense>}
              <Row label="数据在哪里" hint="条目在服务端加密，主密码与本机派生的密钥永不发送" />
              <Row label="许可" hint="自有实现，未使用禁止用于 Vaultwarden 的官方 SDK" />
              {!compact && <Shortcuts native={capabilities.native} />}
            </Group>
          )}
        </div>}
      </div>
    </FloatingPanel>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-md font-medium">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-[var(--ink-tertiary)]">{hint}</p>}
      <div className="card mt-3 px-4">{children}</div>
    </section>
  );
}

/**
 * 一行设置。
 *
 * 左标签右控件的骨架，和详情页的字段行是同一条基线 ——
 * 用户在两个地方看到的「一行东西」应该是同一种东西。
 * 没有 controls 时就是一条只读的信息行（账户那一组）。
 */
function Row({ label, hint, value, children }: {
  label: string;
  hint?: string;
  value?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] py-3 last:border-b-0">
      <div className="min-w-[120px] flex-1">
        <div className="text-md">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-snug text-[var(--ink-tertiary)]">{hint}</div>}
      </div>
      {value !== undefined && (
        <div className="secret max-w-full truncate text-md text-[var(--ink-secondary)]" title={value}>
          {value}
        </div>
      )}
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  );
}

function Select({ value, options, disabled }: {
  value: string;
  options: Array<[string, string]>;
  disabled?: boolean;
}) {
  return (
    <select className="field w-[146px] py-1.5" defaultValue={value} disabled={disabled} tabIndex={-1}>
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-well)] px-1.5 py-0.5 text-2xs text-[var(--ink-secondary)]">
      {children}
    </kbd>
  );
}

/** 快捷键一览 —— 面板里唯一「真的有用」的一组信息，所以它不叫占位 */
function Shortcuts({ native }: { native: boolean }) {
  const keys: Array<[string, string]> = [
    ...(native ? [[quickShortcut(), '打开快速面板'] as [string, string]] : []),
    [primaryShortcut('F'), '搜索条目'],
    [primaryShortcut('N'), '新建条目'],
    [primaryShortcut('L'), '锁定保险库'],
  ];
  return (
    <div className="border-t border-[var(--border-subtle)] py-3">
      <div className="mb-2 text-xs text-[var(--ink-tertiary)]">快捷键</div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
        {keys.map(([k, label]) => (
          <div key={k} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-[var(--ink-secondary)]">{label}</span>
            <kbd className="secret shrink-0 text-2xs text-[var(--ink-tertiary)]">{k}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
