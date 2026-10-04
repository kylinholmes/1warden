/**
 * 图标集 —— 内联 SVG，不引外部资源。
 *
 * ⚠️ 为什么不用 emoji（上一版用的是 🔑💳👤📝）：
 *
 * 1. emoji 是**全彩**的。整个界面是克制的灰调 + 一个强调色，
 *    而一排 emoji 自带十几种颜色，视觉重心全跑到图标上去了。
 * 2. emoji 的字形由系统决定。同一个 🔑 在 macOS、Windows 上是两套画法，
 *    大小、基线、笔画粗细都不一致 —— 列表行看着就「不齐」。
 * 3. emoji 表达不了「收藏」「已泄露」这类状态，只能再叠一个符号上去。
 *
 * 统一规格：24×24 网格、1.75 描边、圆角端点。
 * 笔画粗细一致，光学大小才一致 —— 这是「整」的来源。
 */
import type { SVGProps } from 'react';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** 视觉尺寸（px）。默认 16 —— 和 --text-md 的正文配着用 */
  size?: number;
}

/**
 * 所有图标共用的外壳。
 *
 * `aria-hidden` 是默认的：图标在这里一律是**装饰**，
 * 它旁边的文字已经把事情说清楚了。需要独立表意的图标由使用处
 * 自己挂 `aria-label`（或用 `.sr-only` 文字），不要把含义塞进图形里。
 */
function Svg({ size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    />
  );
}

/* ── 条目类型 ─────────────────────────────────────────── */

export const IconKey = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="3.5" />
    <path d="M10.6 12.4 19 4M16.5 6.5 19 9M14 9l2.5 2.5" />
  </Svg>
);

export const IconCard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="M2.5 9.5h19" />
    <path d="M6.5 14.5h3" />
  </Svg>
);

export const IconIdentity = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </Svg>
);

export const IconNote = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h8.5L19 7.5V21H6z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h7M9 17h4.5" />
  </Svg>
);

export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
    <path d="M7 10l2.5 2.5L7 15M12.5 15h5" />
  </Svg>
);

export const IconUnknown = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.4" />
    <path d="M12 17.2h.01" />
  </Svg>
);

/* ── 界面 ─────────────────────────────────────────────── */

/** 侧栏的「全部」—— 一堆条目，不是某个具体类型 */
export const IconItems = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="6" rx="2" />
    <rect x="3" y="14" width="18" height="6" rx="2" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconStar = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Svg {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z" />
  </Svg>
);

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 2.8 4.5 6v6c0 4.4 3.1 7.7 7.5 9.2 4.4-1.5 7.5-4.8 7.5-9.2V6z" />
    <path d="m9 12 2.2 2.2L15.4 10" />
  </Svg>
);

export const IconImport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v11" />
    <path d="m7.5 9.8 4.5 4.5 4.5-4.5" />
    <path d="M4 16.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.5" />
  </Svg>
);

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7.5A2 2 0 0 1 5 5.5h3.6l1.8 2.2H19a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
    <path d="M15.5 5.5v-1a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const IconEye = ({ off, ...p }: IconProps & { off?: boolean }) => (
  <Svg {...p}>
    {off ? (
      <>
        <path d="M4 4.5 20 20" />
        <path d="M9.9 5.4A9.5 9.5 0 0 1 12 5.2c5.2 0 8.8 4.4 9.7 6.1a2 2 0 0 1 0 1.4 15 15 0 0 1-3 3.7" />
        <path d="M6.5 7.2A15 15 0 0 0 2.3 11.3a2 2 0 0 0 0 1.4C3.2 14.4 6.8 18.8 12 18.8a9.6 9.6 0 0 0 4-.9" />
        <path d="M10.1 10.3a2.6 2.6 0 0 0 3.6 3.6" />
      </>
    ) : (
      <>
        <path d="M2.3 11.3C3.2 9.6 6.8 5.2 12 5.2s8.8 4.4 9.7 6.1a2 2 0 0 1 0 1.4C20.8 14.4 17.2 18.8 12 18.8S3.2 14.4 2.3 12.7a2 2 0 0 1 0-1.4" />
        <circle cx="12" cy="12" r="2.7" />
      </>
    )}
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 6.5h15M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
    <path d="M6.5 6.5 7.6 19a2 2 0 0 0 2 1.9h4.8a2 2 0 0 0 2-1.9l1.1-12.5" />
    <path d="M10.5 10.5v6M13.5 10.5v6" />
  </Svg>
);

export const IconPencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15.6 4.6a2.2 2.2 0 0 1 3.1 0l.7.7a2.2 2.2 0 0 1 0 3.1L8.2 19.6 4 20.8l1.2-4.2z" />
  </Svg>
);

export const IconMore = (p: IconProps) => (
  <Svg {...p} strokeWidth={2.4}>
    <path d="M6 12h.01M12 12h.01M18 12h.01" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Svg>
);

export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 12H5" />
    <path d="m11 6-6 6 6 6" />
  </Svg>
);

export const IconServer = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </Svg>
);

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 3.9 1.9 18.3a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0" />
    <path d="M12 9v4.5M12 17.5h.01" />
  </Svg>
);

export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3.2 9.5h17.6M3.2 14.5h17.6" />
    <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" />
  </Svg>
);

export const IconKeyboard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="6.5" width="19" height="11" rx="2.5" />
    <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 13.8h8" />
  </Svg>
);

export const IconSpinner = ({ size = 16, ...p }: IconProps) => (
  <Svg {...p} size={size} className={`spin ${p.className ?? ''}`}>
    <path d="M12 3.5a8.5 8.5 0 1 1-6 2.5" />
  </Svg>
);

export const IconGear = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9.1a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);

export const IconPalette = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3a9 9 0 0 0 0 18 2 2 0 0 0 1.6-3.2 2 2 0 0 1 1.6-3.2H18a3 3 0 0 0 3-3 9 9 0 0 0-9-8.6" />
    <path d="M7.5 10.5h.01M10.5 7h.01M14.5 7h.01M17.5 10h.01" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </Svg>
);

/** 条目类型 → 图标。和 `.tile[data-type]` 的配色一一对应 */
export function TypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  switch (type) {
    case 'login': return <IconKey size={size} />;
    case 'card': return <IconCard size={size} />;
    case 'identity': return <IconIdentity size={size} />;
    case 'secureNote': return <IconNote size={size} />;
    case 'sshKey': return <IconTerminal size={size} />;
    default: return <IconUnknown size={size} />;
  }
}
