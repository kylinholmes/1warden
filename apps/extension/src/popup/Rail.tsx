import { TypeIcon, IconDice, IconItems, IconStar, IconLock } from '@coffer/ui';

/**
 * 弹窗最左侧的导航栏 —— **Material 3 的 navigation rail**。
 *
 * ## 为什么是这一个形状
 *
 * 弹窗只有一条，桌面端是三栏。早先的做法是「把三栏压成一条」——
 * 于是分类、列表、详情全糊在同一列里：每一行又宽又高（图标 + 名字 +
 * 用户名 + 填充按钮 + 分隔线 + 三个复制按钮 + 「30 秒后清空」），
 * 列表不像列表、详情不像详情。
 *
 * 拆成三层之后，每层只干一件事：
 *
 *   1. rail    —— 去哪一类（本文件）
 *   2. 列表    —— 这一类里有什么（`Popup.tsx`）
 *   3. 详情    —— 这一条是什么、能对它做什么（`ItemDetail.tsx`）
 *
 * ## M3 的具体规格（照抄，不自己发明）
 *
 * - 折叠态容器宽 **80**；每项是「图标装在一枚 56×32 的胶囊里 + 下方标签」
 * - 选中时**胶囊填充**、图标转强调色 —— 这是 rail 最显眼的那个信号，
 *   比只给文字换个颜色明确得多
 * - 展开态（M3 叫 expanded rail）容器宽 200，标签移到图标**右侧**、字号升一档
 * - 分组之间留空档，不画线：rail 本身已经很窄，横线会把每一格切得很碎
 *
 * ## ⚠️ 类别那几项和桌面端是同一套
 *
 * 桌面端侧栏也是「全部 / 收藏 / 类别（登录·卡片·身份·笔记·SSH）/ 生成器」。
 * 两端的**分类体系**必须一致 —— 用户在桌面端把某条放进「身份」，
 * 在弹窗里就该在同一个地方找到它。
 */
export type Destination =
  | 'all' | 'favorites'
  | 'login' | 'card' | 'identity' | 'secureNote' | 'sshKey'
  | 'generator';

interface Entry {
  key: Destination;
  label: string;
  /** 折叠态那个图标 */
  icon: React.ReactNode;
}

const EXPANDED_W = 200;
const COLLAPSED_W = 80;

/** 类别那几项的图标用 `TypeIcon` —— 和条目列表里的类型图标是同一套画法 */
function groups(): Entry[][] {
  return [
    [
      { key: 'all', label: '全部', icon: <IconItems size={20} /> },
      { key: 'favorites', label: '收藏', icon: <IconStar size={20} /> },
    ],
    [
      { key: 'login', label: '登录', icon: <TypeIcon type="login" size={20} /> },
      { key: 'card', label: '卡片', icon: <TypeIcon type="card" size={20} /> },
      { key: 'identity', label: '身份', icon: <TypeIcon type="identity" size={20} /> },
      { key: 'secureNote', label: '笔记', icon: <TypeIcon type="secureNote" size={20} /> },
      { key: 'sshKey', label: 'SSH', icon: <TypeIcon type="sshKey" size={20} /> },
    ],
    [
      { key: 'generator', label: '生成', icon: <IconDice size={20} /> },
    ],
  ];
}

export function Rail({ current, onSelect, expanded, onToggleExpanded, onLock }: {
  current: Destination;
  onSelect: (d: Destination) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  onLock: () => void;
}) {
  return (
    <nav
      aria-label="导航"
      /*
       * 宽度变化要有过渡 —— rail 展开/收起是这一屏最显眼的动作，
       * 瞬移会看起来像重渲染了一下。
       */
      className="flex shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-glass)] py-2.5 transition-[width] duration-[var(--dur-base)] ease-[var(--ease-enter)]"
      style={{ width: expanded ? EXPANDED_W : COLLAPSED_W }}
    >
      {/*
        顶部：品牌 + 展开开关。整个是一条按钮 —— 折叠态下它是唯一的
        展开入口，做小了会点不中。
      */}
      <button
        type="button"
        onClick={onToggleExpanded}
        title={expanded ? '收起导航' : '展开导航'}
        aria-expanded={expanded}
        className={`mx-3 mb-2 flex h-9 items-center gap-2.5 rounded-[var(--radius-sm)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] ${
          expanded ? 'px-2' : 'justify-center'
        }`}
      >
        <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[7px] bg-[var(--accent)] text-[var(--accent-ink)]">
          <IconLock size={13} />
        </span>
        {expanded && (
          <span className="min-w-0 truncate text-md font-semibold tracking-[-0.01em]">Coffer</span>
        )}
      </button>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3">
        {groups().map((group, gi) => (
          <div key={gi} className="flex flex-col gap-0.5">
            {group.map((e) => (
              <RailItem
                key={e.key}
                icon={e.icon}
                label={e.label}
                selected={current === e.key}
                expanded={expanded}
                onClick={() => onSelect(e.key)}
              />
            ))}
          </div>
        ))}
      </div>

      {/*
        锁定放最下面：它和上面那些是**不同性质**的动作 ——
        上面是「去哪儿看」，这个是「把门关上」。混在一列里容易误点。
      */}
      <div className="mt-2 px-3">
        <RailItem
          icon={<IconLock size={20} />}
          label="锁定"
          selected={false}
          expanded={expanded}
          onClick={onLock}
        />
      </div>
    </nav>
  );
}

function RailItem({ icon, label, selected, expanded, onClick }: {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? 'page' : undefined}
      title={expanded ? undefined : label}
      className={`flex items-center rounded-[var(--radius-md)] transition-colors duration-[var(--dur-fast)] ${
        expanded ? 'h-10 flex-row gap-3 px-2' : 'flex-col gap-0.5 py-0.5'
      } ${selected ? '' : 'hover:bg-[var(--surface-hover)]'}`}
    >
      {/*
        M3 的胶囊指示器。折叠态 56×32，展开态收成 32×32 ——
        展开时标签已经在右边了，再撑 56 宽会把文字推得太远。
      */}
      <span
        className={`grid shrink-0 place-items-center rounded-full transition-colors duration-[var(--dur-fast)] ${
          expanded ? 'h-8 w-8' : 'h-8 w-14'
        } ${selected ? 'bg-[var(--surface-selected)] text-[var(--accent)]' : 'text-[var(--ink-secondary)]'}`}
      >
        {icon}
      </span>
      <span
        className={`truncate ${
          expanded ? 'min-w-0 flex-1 text-left text-sm' : 'w-full text-center text-2xs leading-none'
        } ${selected ? 'font-medium text-[var(--ink-primary)]' : 'text-[var(--ink-secondary)]'}`}
      >
        {label}
      </span>
    </button>
  );
}
