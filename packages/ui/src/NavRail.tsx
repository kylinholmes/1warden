import type { ReactNode } from 'react';
import { IconItems } from './icons';

/**
 * 导航栏 —— **桌面端侧栏和浏览器弹窗的 rail 是同一个组件**。
 *
 * ## 一种组件，两种密度
 *
 * | | 折叠 | 展开 |
 * |---|---|---|
 * | 宽 | 80（图标 + 下方小字） | 214（图标 + 文字 + 计数） |
 * | 选中 | 整行填充 + 强调色图标 | 同左 |
 *
 * 这不是「把两个组件拼在一起」：折叠和展开渲染的是**同一份条目**，
 * 只有排布方式不同（横排还是竖排）。所以「哪一档显示什么」不会漂 ——
 * 两端各写一遍时漂过的那种事（同一个类型在一边叫「信用卡」、另一边叫
 * 「卡片」）在这里没有发生的余地。
 *
 * ## 内容由调用方给，平台差异不在这里
 *
 * 桌面端有文件夹、安全报告、导入；弹窗只有分类和生成器。这个差别**不是
 * 组件内部的 if**，而是调用方 `groups` 里放了什么 —— 因为那些东西连着
 * 各自的数据和回调（文件夹要 `VaultClient` 的重命名/删除），
 * 塞进共享组件等于让 UI 层认识保险库。
 *
 * 平台常量（`./platform`）管的是另一类：同一件事在不同平台上**做法不同**
 * （复制后谁负责清剪贴板、能不能存文件）。那类才需要 `IS_DESKTOP` 那种分支。
 *
 * ## ⚠️ 玻璃面上不要用三级墨
 *
 * 桌面端的侧栏是玻璃（见那边 `--surface-glass` 的说明），文字最低要用
 * **次级墨**：三级墨压在实心面上本来就只有 4.94:1，玻璃再一稀释就掉到
 * 3.58:1。计数、账户邮箱、快捷键提示因此都上移一档。
 * 折叠态那个小字标签同理。
 */
export interface NavEntry {
  /** 稳定的键。调用方用它和 `current` 比较 */
  key: string;
  label: string;
  icon: ReactNode;
  /** 这一类里有多少条。不传就不显示计数 */
  count?: number;
  /**
   * 挂在同一个 `<li>` 里的附加内容（文件夹的「更多」菜单按钮）。
   * ⚠️ 折叠态会整块隐藏 —— 80px 里放不下一个浮在行尾的按钮。
   */
  extra?: ReactNode;
}

export interface NavGroup {
  /** React 的 key；也给将来做持久化的分组折叠留个稳定标识 */
  key: string;
  /** 展开态显示的分组标题。折叠态**不显示**（80px 里放不下） */
  title?: string;
  /** 标题右边的动作，比如「新建文件夹」。折叠态一并隐藏 */
  action?: ReactNode;
  /**
   * 常规条目。和 `render` 二选一。
   */
  entries?: NavEntry[];
  /**
   * **整个分组自己渲染**。
   *
   * 桌面端的文件夹那一节要就地改名、删除前还要确认 —— 那是一个
   * 「带内联编辑的列表」，不是一组导航项。硬塞进 `NavEntry` 的话，
   * 插槽会一路加到它变成一个通用渲染器，而那时共享组件就不剩什么了。
   *
   * 给了 `render` 就不看 `entries`；标题和 `action` 的排版仍然由本组件负责 ——
   * 分组的**外壳**是共用的，只有行是调用方自己的。
   */
  render?: (expanded: boolean) => ReactNode;
}

export interface NavRailProps {
  /** 顶部的品牌区。不传就整块不渲染 */
  brand?: ReactNode;
  /** 品牌区右边的动作（设置齿轮…） */
  brandAction?: ReactNode;
  groups: NavGroup[];
  /** 当前选中的键 */
  current: string;
  onSelect: (key: string) => void;
  /** 底部固定区（账户、锁定…）。**不参与滚动** —— 它俩是「你是谁 / 离开」，
      和上面「去哪儿看」不是一类东西，滚走了会让人找不着 */
  footer?: ReactNode;
  expanded: boolean;
  /** 点了品牌区就切换展开。不传则品牌区只是装饰 */
  onToggleExpanded?: () => void;
  collapsedWidth?: number;
  expandedWidth?: number;
  /** 玻璃面之类的差异走这里，不进组件 */
  className?: string;
  /** 无障碍标签 */
  label?: string;
}

const COLLAPSED = 80;
const EXPANDED = 214;

export function NavRail({
  brand, brandAction, groups, current, onSelect, footer,
  expanded, onToggleExpanded, collapsedWidth = COLLAPSED, expandedWidth = EXPANDED,
  className = '', label = '导航',
}: NavRailProps) {
  // 只有调用方给了**非默认**宽度时才写内联（那意味着它自己承担覆盖的责任）
  const widthsEqualDefaults = expandedWidth === EXPANDED && collapsedWidth === COLLAPSED;

  return (
    <nav
      aria-label={label}
      className={`vault-rail ${className} flex w-[var(--nav-w)] shrink-0 flex-col border-r border-[var(--border-subtle)] transition-[width] duration-[var(--dur-base)] ease-[var(--ease-enter)]`}
      data-expanded={expanded}
      /*
       * ⚠️ **宽度不由内联样式给。**
       *
       * 内联的 `width` 和**内联的自定义属性**都压过样式表里的规则 ——
       * 而桌面端要在**容器查询**里把它改窄（窗口窄了就把侧栏收成图标条）。
       * 写成内联的话那条规则永远不生效，表现是「标签藏了、宽度没变」，
       * 侧栏里空一大片。宽度定义在 `components.css` 的 `--nav-w` 上，
       * 调用方用自己的规则覆盖它。
       */
      style={widthsEqualDefaults ? undefined : { '--nav-w': `${expanded ? expandedWidth : collapsedWidth}px` } as React.CSSProperties}
    >
      {brand !== undefined && (
        <div className="band nav-band pl-[var(--traffic-inset)]" data-tauri-drag-region="deep">
          {onToggleExpanded === undefined ? (
            <div className="flex min-w-0 flex-1 items-center gap-2.5">{brand}</div>
          ) : (
            <button
              type="button"
              onClick={onToggleExpanded}
              aria-expanded={expanded}
              title={expanded ? '收起导航' : '展开导航'}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-sm)] py-1 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)]"
            >
              {brand}
            </button>
          )}
          {brandAction}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2.5 py-2.5">
        {groups.map((g) => (
          <div key={g.key}>
            {/*
              ⚠️ 折叠态整个标题行**不渲染**（不只是 CSS 藏起来）。
              80px 里放不下「类别」加一个「+」——而塞不下的东西半显示比不显示更糟：
              第一版把「锁定」两个字漏在外面，它在 80px 里换行成了两行。
            */}
            {expanded && (g.title !== undefined || g.action !== undefined) && (
              <div className="nav-group-head mt-3 mb-1 flex items-center justify-between pl-2.5 pr-1">
                {g.title !== undefined && (
                  <span className="nav-section-title text-xs font-medium text-[var(--ink-secondary)]">
                    {g.title}
                  </span>
                )}
                {g.action}
              </div>
            )}
            {g.render !== undefined ? (
              g.render(expanded)
            ) : (
              <ul className="space-y-0.5">
                {(g.entries ?? []).map((e) => (
                  <NavRow
                    key={e.key}
                    entry={e}
                    active={e.key === current}
                    expanded={expanded}
                    onClick={() => onSelect(e.key)}
                  />
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {footer !== undefined && (
        <div className="border-t border-[var(--border-subtle)] p-2.5">{footer}</div>
      )}
    </nav>
  );
}

/** 一个条目。折叠态竖排（图标在上、小字在下），展开态横排（图标 + 文字 + 计数） */
export function NavRow({ entry, active, expanded, onClick }: {
  entry: NavEntry;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      {/* 选中态用**填充 + 字重**，不用强调色文字 ——
          强调色留给「可以点的动作」，用它给导航项上色会让界面到处是青色 */}
      <button
        type="button"
        onClick={onClick}
        data-key={entry.key}
        aria-current={active ? 'page' : undefined}
        title={expanded ? undefined : entry.label}
        className={`nav-item flex w-full rounded-[var(--radius-sm)] transition-colors duration-[var(--dur-fast)] ${
          expanded
            ? 'items-center gap-2.5 px-2.5 py-[7px] text-left text-sm'
            : 'flex-col items-center gap-0.5 px-1 py-1.5'
        } ${
          active
            ? 'bg-[var(--surface-selected)] font-medium text-[var(--ink-primary)]'
            : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]'
        }`}
      >
        <span className="nav-icon shrink-0">
          {entry.icon}
        </span>
        <span
          className={
            expanded
              ? 'nav-label min-w-0 flex-1 truncate'
              : 'nav-label w-full truncate text-center text-2xs leading-none'
          }
        >
          {entry.label}
        </span>
        {expanded && entry.count !== undefined && (
          /* 计数是字，不是图形 —— 在玻璃上必须用次级墨（理由见文件顶部） */
          <span className="nav-count shrink-0 text-2xs tabular-nums text-[var(--ink-secondary)]">
            {entry.count}
          </span>
        )}
      </button>
      {entry.extra}
    </li>
  );
}

/**
 * **悬停抽屉** —— 把 `NavRail` 挂起来，不占用版面。
 *
 * ## 为什么不是常驻一条栏
 *
 * 弹窗里的横向空间是**内容**的。常驻 80px 的栏意味着每条记录的名字都少
 * 80px —— 而导航不是每时每刻都在用：打开弹窗的人十有八九是来拿某一条密码的，
 * 不是来切换分类的。
 *
 * 所以：左边缘留一条 **14px 的悬停带**，鼠标移上去（或者键盘 Tab 进去）
 * 面板才从左侧滑出、盖住内容。用完移开就收回去。
 *
 * ## 为什么用 CSS 的 `:hover` 而不是 React 状态
 *
 * 纯 CSS 的悬停**不会有「状态和指针不同步」那一类 bug**：鼠标移开、面板
 * 收起，这两件事由浏览器保证同时发生。用状态的话，得自己处理「鼠标从带子
 * 移到面板上」这段路程 —— 而那段路程里如果状态被清掉，面板会在手底下消失。
 *
 * ⚠️ 面板是 `.nav-drawer` 的**子元素**，所以鼠标移进面板时
 * `:hover` 仍然成立、面板不会闪走。这不是巧合，是它能工作的前提。
 *
 * ⚠️ `focus-within` 一起管：只用 `:hover` 的话，键盘用户永远打不开它。
 */
export function NavDrawer(
  /* 抽屉永远展开、宽度固定 —— 这几项由它自己管，不该让调用方操心 */
  props: Omit<NavRailProps, 'expanded' | 'onToggleExpanded' | 'collapsedWidth' | 'expandedWidth'>,
) {
  return (
    <div className="nav-drawer">
      <div className="nav-drawer-panel">
        <NavRail {...props} expanded />
      </div>
    </div>
  );
}

/**
 * 抽屉的**开关** —— 由调用方放在自己的顶栏里（搜索框前面），不在这里。
 *
 * ⚠️ 它一度是绝对定位到**窗口左上角**的，在桌面端正好压住 macOS 的
 * 红绿灯（那三个点是**系统**画的，在 WebView 之上，抢不过）。而且窗口
 * 左上角是系统的地盘，不该放应用自己的控件。
 *
 * 现在它是普通流内元素，位置交给各端的顶栏决定；悬停的联动靠
 * `.vault-shell:has(...)`（见 components.css）。
 */
export function NavTrigger() {
  return (
    <button type="button" className="nav-trigger" aria-label="导航" title="导航">
      <IconItems size={17} />
    </button>
  );
}
