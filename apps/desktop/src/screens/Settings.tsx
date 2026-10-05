import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { FloatingPanel } from '../components/FloatingPanel';
import { Segmented } from '../components/Segmented';
import { useShowTypes } from '../prefs';
import { getThemeMode, setThemeMode, subscribeTheme, type ThemeMode } from '../theme';
import {
  IconClose, IconGear, IconIdentity, IconInfo, IconKeyboard, IconPalette, IconShield,
} from '@coffer/ui';

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
 * 左侧一列分组、右侧内容，和主窗口的三栏是同一种骨架的缩小版 ——
 * 面板里的导航栏用 `--surface-chrome`，和主窗口侧栏同一层。
 * 这不是巧合：用户刚从这个面板的「左边那一列」点过来，
 * 那个位置本来就该是同一个东西。
 */

export type SectionId = 'account' | 'security' | 'appearance' | 'autofill' | 'about';

const SECTIONS: Array<{ id: SectionId; label: string; icon: ReactNode }> = [
  { id: 'account', label: '账户', icon: <IconIdentity size={16} /> },
  { id: 'security', label: '安全', icon: <IconShield size={16} /> },
  { id: 'appearance', label: '外观', icon: <IconPalette size={16} /> },
  { id: 'autofill', label: '自动填充', icon: <IconKeyboard size={16} /> },
  { id: 'about', label: '关于', icon: <IconInfo size={16} /> },
];

export function Settings({ open, account, serverUrl, onClose, initialSection = 'account' }: {
  open: boolean;
  account: string;
  serverUrl: string;
  onClose: () => void;
  /**
   * 打开时停在哪一组。
   *
   * 不是为测试留的口子 —— 它对应一条真实的路径：自动填充失败时，
   * 界面提示「需要辅助功能权限」，用户点过去应该**直接落在
   * 自动填充那一组**，而不是先看到「账户」再自己找。
   */
  initialSection?: SectionId;
}) {
  const [section, setSection] = useState<SectionId>(initialSection);
  /*
   * 主题的真相在 theme.ts、类别开关的真相在 prefs.ts（都是模块级 +
   * localStorage），组件只是它们的视图 ——
   * 用 useState 在这里存一份的话，预览页或别处改了主题，这个控件不会知道。
   */
  const theme = useSyncExternalStore(subscribeTheme, getThemeMode);
  const [showTypes, setShowTypes] = useShowTypes();

  return (
    <FloatingPanel
      open={open}
      onClose={onClose}
      labelledBy="settings-title"
      className="h-[min(520px,calc(100vh-32px))] max-w-[640px]"
      footer={
        <>
          {/* 底栏按分组说实话：外观那组的主题是真能用的，其余三组还没接 */}
          <span className="min-w-0 truncate">
            {section === 'appearance'
              ? '主题改动立即生效并会记住；这一组其余两项仍是占位'
              : '这一组仍是外壳：控件尚未接入，改动不会保存'}
          </span>
          <span className="shrink-0">
            <kbd className="text-[var(--text-2xs)]">esc</kbd> 关闭
          </span>
        </>
      }
    >
      <div className="panel-head">
        <IconGear size={15} className="shrink-0 text-[var(--ink-tertiary)]" />
        <h2 id="settings-title" className="min-w-0 flex-1 truncate text-[var(--text-md)] font-medium">
          设置
        </h2>
        <button onClick={onClose} aria-label="关闭设置" title="关闭  esc" className="btn btn-ghost -mr-1 p-1.5">
          <IconClose size={15} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/*
          分组导航用 tab 的语义（role="tablist"）而不是 aria-current 的链接：
          切换分组**不离开**这个面板，右侧内容是同一次交互里的另一块面板 ——
          这正是 tab 的定义。键盘的左右箭头也因此能直接切分组。
        */}
        <nav
          role="tablist"
          aria-label="设置分组"
          aria-orientation="vertical"
          className="w-[148px] shrink-0 overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--surface-chrome)] p-2"
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
                className={`flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-[7px] text-left text-[var(--text-sm)] transition-colors duration-[var(--dur-fast)] ${
                  active
                    ? 'bg-[var(--surface-selected)] font-medium text-[var(--ink-primary)]'
                    : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]'
                }`}
              >
                <span className={active ? 'text-[var(--accent)]' : 'text-[var(--ink-tertiary)]'}>{s.icon}</span>
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
              </button>
            );
          })}
        </nav>

        <div
          role="tabpanel"
          id={`settings-panel-${section}`}
          aria-labelledby={`settings-tab-${section}`}
          tabIndex={-1}
          className="min-w-0 flex-1 overflow-y-auto px-5 py-4 outline-none"
        >
          {section === 'account' && (
            <Group title="账户" hint="这些来自你连接的那台服务器，不在这里改">
              <Row label="邮箱" value={account || '—'} />
              <Row label="服务器" value={serverUrl || '—'} />
              <Row label="断开并清除本机数据" hint="保险库在服务器上的内容不受影响">
                <button className="btn btn-danger" disabled>断开连接</button>
              </Row>
            </Group>
          )}

          {section === 'security' && (
            <Group title="安全" hint="锁定与剪贴板的行为">
              <Row label="空闲后自动锁定" hint="切换窗口或系统休眠时也会立即锁定">
                <Select disabled value="15" options={[['5', '5 分钟'], ['15', '15 分钟'], ['60', '1 小时'], ['0', '不自动锁定']]} />
              </Row>
              <Row label="复制后清空剪贴板" hint="只在剪贴板里还是我们写进去的值时才清">
                <Select disabled value="30" options={[['10', '10 秒'], ['30', '30 秒'], ['60', '1 分钟'], ['0', '不清空']]} />
              </Row>
              <Row label="已泄露密码检查" hint="只发送 SHA-1 哈希的前 5 个字符">
                <Check disabled />
              </Row>
            </Group>
          )}

          {section === 'appearance' && (
            <Group title="外观" hint="界面本身的样子">
              {/*
                ⚠️ 三态，不是一个开关：「跟随系统」是**独立的一个选项**，
                不是「关」的意思。做成开关（亮/暗）的话，选过亮色的用户
                就再也回不到跟随系统了 —— 而「晚上自动变暗」这件事
                恰恰是很多人对系统主题的唯一用法。

                分段控件而不是下拉框：三个选项一眼全在，而且当前选的是哪个
                直接看得见（这是设置项，不是表单输入）。
              */}
              <Row label="主题" hint="改了立即生效，下次打开还是它">
                <Segmented<ThemeMode>
                  label="主题"
                  value={theme}
                  onChange={setThemeMode}
                  options={[
                    { value: 'system', label: '跟随系统' },
                    { value: 'light', label: '亮色' },
                    { value: 'dark', label: '暗色' },
                  ]}
                />
              </Row>
              {/*
                侧栏「类别」那一节。
                ⚠️ 默认**开着** —— 这个开关藏在设置里，而关掉之后侧栏
                完全没有入口。默认关等于这个功能不存在。
              */}
              <Row label="侧栏按类别分组" hint="在「文件夹」下面按条目类型（登录 / 信用卡 …）再分一组">
                <Segmented<'on' | 'off'>
                  label="侧栏按类别分组"
                  value={showTypes ? 'on' : 'off'}
                  onChange={(v) => setShowTypes(v === 'on')}
                  options={[{ value: 'on', label: '显示' }, { value: 'off', label: '隐藏' }]}
                />
              </Row>
              <Row label="列表密度" hint="一行里显示多少条记录">
                <Select disabled value="comfortable" options={[['comfortable', '标准'], ['compact', '紧凑']]} />
              </Row>
              <Row label="动效" hint="关闭后所有过渡立即完成">
                <Check disabled checked />
              </Row>
            </Group>
          )}

          {section === 'autofill' && (
            <Group title="自动填充" hint="让密码进到别的应用里">
              <Row label="桌面自动填充" hint="需要辅助功能权限，只会发送按键，不读取界面内容">
                <Check disabled />
              </Row>
              <Row label="浏览器扩展" hint="当前没有检测到已连接的浏览器">
                <span className="text-[var(--text-sm)] text-[var(--ink-tertiary)]">未连接</span>
              </Row>
              <Row label="快速面板快捷键">
                <Kbd>⌘</Kbd><Kbd>⇧</Kbd><Kbd>\</Kbd>
              </Row>
            </Group>
          )}

          {section === 'about' && (
            <Group title="关于" hint="Coffer 0.0.0">
              <Row label="数据在哪里" hint="条目在服务端加密，主密码与本机派生的密钥永不发送" />
              <Row label="许可" hint="自有实现，未使用禁止用于 Vaultwarden 的官方 SDK" />
              <Shortcuts />
            </Group>
          )}
        </div>
      </div>
    </FloatingPanel>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[var(--text-md)] font-medium">{title}</h3>
      {hint && <p className="mt-0.5 text-[var(--text-xs)] text-[var(--ink-tertiary)]">{hint}</p>}
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
    <div className="flex items-center gap-4 border-b border-[var(--border-subtle)] py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[var(--text-md)]">{label}</div>
        {hint && <div className="mt-0.5 text-[var(--text-xs)] leading-snug text-[var(--ink-tertiary)]">{hint}</div>}
      </div>
      {value !== undefined && (
        <div className="secret max-w-[240px] shrink-0 truncate text-[var(--text-md)] text-[var(--ink-secondary)]" title={value}>
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

function Check({ checked, disabled }: { checked?: boolean; disabled?: boolean }) {
  return <input type="checkbox" defaultChecked={checked} disabled={disabled} tabIndex={-1} />;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-well)] px-1.5 py-0.5 text-[var(--text-2xs)] text-[var(--ink-secondary)]">
      {children}
    </kbd>
  );
}

/** 快捷键一览 —— 面板里唯一「真的有用」的一组信息，所以它不叫占位 */
function Shortcuts() {
  const keys: Array<[string, string]> = [
    ['⌘⇧\\', '打开快速面板'],
    ['⌘F', '搜索条目'],
    ['⌘N', '新建条目'],
    ['⌘L', '锁定保险库'],
  ];
  return (
    <div className="border-t border-[var(--border-subtle)] py-3">
      <div className="mb-2 text-[var(--text-xs)] text-[var(--ink-tertiary)]">快捷键</div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
        {keys.map(([k, label]) => (
          <div key={k} className="flex items-center gap-2 text-[var(--text-sm)]">
            <span className="min-w-0 flex-1 truncate text-[var(--ink-secondary)]">{label}</span>
            <kbd className="secret shrink-0 text-[var(--text-2xs)] text-[var(--ink-tertiary)]">{k}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
