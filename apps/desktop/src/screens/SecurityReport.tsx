import { useMemo, useState } from 'react';
import {
  buildReport, checkBreaches,
  type VaultItem, type SecurityReport as Report,
} from '@coffer/vault';
import {
  SecurityReportView as SecurityReportBody, reportBrief, type BreachState,
} from '@coffer/ui';

/**
 * 安全报告 —— **桌面端这里只剩「怎么拿到数据」和外壳**。
 *
 * 版面本身在 `@coffer/ui` 的 `SecurityReportView`，和扩展弹窗**同一份代码**。
 *
 * ⚠️ 这一步是必须的，不是整理：两端各写一遍时，弹窗那份**少了整整两栏**
 * （已泄露的密码、即将到期）—— 前者恰恰是最该看到的一条。而类型检查、
 * 测试、构建全都不会报，看起来只是「弹窗简单一点」。详见共享组件顶部。
 *
 * 这里负责两件共享组件不该知道的事：
 *
 * 1. **报告是本地算的。** Vaultwarden 没有 `/api/reports/*`，所以
 *    `buildReport` 直接跑在这个进程里 —— 密码不必离开设备。
 * 2. **已泄露检查也在这里发起。** 它要联网查 Have I Been Pwned，
 *    由用户显式开启。
 *
 * ── 版面
 *
 * 顶部有和别的面板同高的 `.band`，标题在里面 —— 报告占满右半屏，
 * 如果它没有那条带子，从条目列表切过来时整个界面的骨架会塌掉一块。
 * （「N 条记录」在下面的评分卡里，这里不再重复一遍。）
 */
export function SecurityReportView({ items }: { items: readonly VaultItem[] }) {
  const [breached, setBreached] = useState<Report['breached']>([]);
  const [breachState, setBreachState] = useState<BreachState>('off');

  // `now` 固定成打开报告那一刻 —— 否则每次重渲染都会重算「即将过期」
  const [now] = useState(() => Date.now());
  const report = useMemo(() => buildReport(items, now, breached), [items, now, breached]);

  const brief = useMemo(
    () => reportBrief(report, (i) => (i.nameFailed ? '无法解密' : i.name)),
    [report],
  );

  /*
   * id → 显示名。
   *
   * ⚠️ 和 `reportBrief` 里那个 `displayName` 是**两件事**：那个负责把
   * 「这一条叫什么」写进 brief（用于「明文站点」那一栏，后台那边没有
   * `nameOf` 可用），这个负责查报告里**只有 id** 的那些引用。
   * 两条路径都要给出同样的答案，所以两处都判了 `nameFailed`。
   */
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const nameOf = (id: string) => {
    const it = byId.get(id);
    if (!it) return '（已不存在）';
    return it.nameFailed ? '无法解密' : it.name;
  };

  async function enableBreachCheck() {
    setBreachState('checking');
    try {
      setBreached(await checkBreaches(items));
      setBreachState('on');
    } catch {
      setBreachState('failed');
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶部的带子就是窗口的标题栏 —— 空白处可拖（见 VaultView 里那段注释） */}
      <header className="band shrink-0 px-8" data-tauri-drag-region="deep">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">安全报告</h2>
      </header>

      <SecurityReportBody
        report={brief}
        nameOf={nameOf}
        breach={{ state: breachState, onEnable: () => { void enableBreachCheck(); } }}
      />
    </div>
  );
}
