import type { ReactNode } from 'react';
import { TypeIcon } from './icons';

/**
 * 导航目的地 —— 桌面端侧栏和弹窗 rail **共用这一份定义**。
 *
 * ## 为什么必须共用
 *
 * 两端各写一份的后果不是「样式不一致」，是**同一个类型在两个地方叫不同的名字**。
 * 真发生过：桌面端写的是「信用卡 / 安全笔记 / 身份信息 / SSH 密钥」，
 * 弹窗写的是「卡片 / 笔记 / 身份 / SSH」—— 用户在桌面端把一条归到「身份信息」，
 * 到弹窗里找不到那个词，只能猜「身份」是不是同一个东西。
 *
 * ## 类型词表
 *
 * ⚠️ **只有这一份。** `unknown` 也要有词：条目的类型字段来自服务端，
 * 遇到我们不认识的类型时显示成「未知类型」比显示成 `raw:7` 强。
 */
export const TYPE_LABEL: Record<string, string> = {
  login: '登录',
  secureNote: '安全笔记',
  card: '信用卡',
  identity: '身份信息',
  sshKey: 'SSH 密钥',
  unknown: '未知类型',
};

/** 类型的展示顺序 —— **不**按字母、不按数量，按「一个人最可能先找哪个」 */
export const TYPE_ORDER = ['login', 'card', 'identity', 'secureNote', 'sshKey'] as const;

export interface NavDestination {
  /** 稳定的键。类型用 `type:<条目类型>` 前缀，和固定项区分开 */
  key: string;
  label: string;
  icon: ReactNode;
  /** 这一类里有多少条。固定项（收藏等）不传 */
  count?: number;
}

/**
 * 从条目统计出**类型**目的地。
 *
 * ⚠️ 计数为 0 的类型**不出现** —— 列一堆「0」既占地方，又让人以为自己的东西少了。
 * 两端都是这条规则；弹窗早先列死了五个类型（其中常有空的），是这里改掉的。
 *
 * ⚠️ 顺序按 `TYPE_ORDER` 而不是按数量：数量排序会让整个导航在同步之后
 * **重新洗牌**，用户刚记住的位置就变了。桌面端早先按数量降序，也是这里统一的。
 */
export function typeDestinations(
  counts: ReadonlyMap<string, number>,
  iconSize: number,
): NavDestination[] {
  const known = TYPE_ORDER.filter((t) => (counts.get(t) ?? 0) > 0)
    .map((t) => ({ type: t as string, count: counts.get(t) ?? 0 }));
  // 服务端可能有我们不认识的类型 —— 它们也要能进去，排在已知的后面
  const unknown = [...counts.entries()]
    .filter(([t, n]) => n > 0 && !(TYPE_ORDER as readonly string[]).includes(t))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => ({ type, count }));

  return [...known, ...unknown].map(({ type, count }) => ({
    key: `type:${type}`,
    label: TYPE_LABEL[type] ?? type,
    icon: <TypeIcon type={type} size={iconSize} />,
    count,
  }));
}

/** 从条目列表直接统计每个类型有多少条 */
export function countByType(items: readonly { type: string }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.type, (m.get(i.type) ?? 0) + 1);
  return m;
}
