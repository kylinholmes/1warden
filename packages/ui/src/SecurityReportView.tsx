import type { ReactNode } from 'react';
import type { ScoreGrade, SecurityReport } from '@coffer/vault';
import { GRADE_LABEL, WEAK_REASON } from './report-labels';
import { IconAlert, IconCheck, IconSpinner } from './icons';

/**
 * 安全报告（1Password 的 Watchtower 等价物）—— **两端共用这一份**。
 *
 * ## 为什么必须共用
 *
 * 这份报告以前是两个 app 里各写一遍，而它们**漂得很远**。同一个
 * `buildReport` 算出来的数据，两边显示成：
 *
 * | | 桌面端 | 弹窗（合并前） |
 * |---|---|---|
 * | 已泄露的密码 | 一整块（说明 + 开启按钮 + 未检查徽章） | **完全没有** |
 * | 即将到期 | 有 | **完全没有** |
 * | 重复使用 | 一组一行，列出所有相关条目 | 每个条目一行，只写「N 条共用」 |
 * | 明文站点 | 显示具体的 `http://` 网址 | 只写「网址是 http」 |
 * | 评分 | 分数 + 进度条 + 一句话结论 | 只有数字 |
 *
 * 前两行不是「样式不一致」，是**功能缺失** —— 弹窗的用户根本看不到
 * 自己有密码泄露了，而那条正是最该看到的。而且没有任何东西会报错：
 * 类型检查过、测试过、构建过，看起来只是「弹窗简单一点」。
 *
 * ## ⚠️ 为什么不直接收 `SecurityReport`
 *
 * 因为 `SecurityReport.unsecured` 是 `VaultItem[]` —— **完整条目、带明文密码**。
 * 扩展端的弹窗**刻意**拿不到完整条目（只在后台待着，spec 不变量 S1），
 * 所以它只能给 `{id, name, uris}`。
 *
 * 于是这里有 `ReportBrief`：**报告里显示得出来的一切，没有一样需要明文**。
 * 两端各自把领域对象映射成它（桌面端用下面的 `reportBrief`，扩展端在后台
 * 映射好顺着消息过来），然后渲染同一份代码。
 */

/** 报告里**显示得出来**的部分。故意不含任何明文。 */
export interface ReportBrief {
  total: number;
  score: number;
  grade: ScoreGrade;
  breached: { itemId: string; count: number }[];
  weak: { itemId: string; reason: string }[];
  reused: { itemIds: string[]; count: number }[];
  /** `uris` 只留 `http://` 的那些 —— 这一栏的**全部意义**就是那个不安全的网址 */
  unsecured: { id: string; name: string; uris: string[] }[];
  expiring: { itemId: string; expiresAt: string }[];
}

/** 「已泄露的密码」那一栏的状态 —— 它要联网，必须用户显式开启 */
export type BreachState = 'off' | 'checking' | 'on' | 'failed';

/**
 * 桌面端的映射：领域对象 → 显示用的 brief。
 *
 * ⚠️ `nameFailed` 的判断放在这里，不放在组件里 —— 组件拿到的 `nameOf`
 * 只是「id → 显示名」，它不知道名字解不开这回事。
 */
export function reportBrief(
  report: SecurityReport,
  displayName: (item: { name: string; nameFailed?: boolean }) => string,
): ReportBrief {
  return {
    total: report.total,
    score: report.score,
    grade: report.grade,
    breached: report.breached.map((b) => ({ itemId: b.itemId, count: b.count })),
    weak: report.weak.map((w) => ({ itemId: w.itemId, reason: w.reason })),
    reused: report.reused.map((g) => ({ itemIds: g.itemIds, count: g.count })),
    unsecured: report.unsecured.map((i) => ({
      id: i.id,
      name: displayName(i),
      uris: (i.login?.uris ?? [])
        .map((u) => u.uri)
        .filter((u) => u.toLowerCase().startsWith('http://')),
    })),
    expiring: report.expiring.map((e) => ({ itemId: e.itemId, expiresAt: e.expiresAt })),
  };
}

export function SecurityReportView({
  report,
  nameOf,
  breach,
}: {
  report: ReportBrief;
  /** 报告里只有 id —— 显示名由调用方查（桌面端查内存，弹窗查已加载的列表） */
  nameOf: (id: string) => string;
  /** 「已泄露的密码」的开关注入。桌面端本地查，扩展端走后台消息 */
  breach: { state: BreachState; onEnable: () => void };
}) {
  const checked = breach.state === 'on';

  return (
    /*
     * ⚠️ `@container` 挂在**根**上，留白挂在**里面**那一层。
     *
     * 容器查询问的是「**祖先**里最近的那个容器」，元素问不到自己 ——
     * 两层写在一层上的话，`@[640px]:` 永远不会命中。
     *
     * 这也是「PC 版拖窄就是扩展端」这条验收标准在报告这一页的落点：
     * 同一份标记，宽的时候留白大、窄的时候留白小。
     */
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 @[640px]:px-8 @[640px]:py-7">
        <div className="mx-auto w-full" style={{ maxWidth: 'var(--detail-w)' }}>
          <ScoreCard score={report.score} grade={report.grade} report={report} />

          {report.total === 0 ? (
            <p className="mt-8 text-center text-sm text-[var(--ink-tertiary)]">
              保险库里还没有条目。加了记录之后这里会给出检查结果。
            </p>
          ) : (
            <div className="mt-5 space-y-4 @[640px]:mt-7 @[640px]:space-y-5">
              <Finding
                title="已泄露的密码"
                count={report.breached.length}
                empty="没有发现已泄露的密码"
                tone="risk"
                checked={checked}
              >
                {!checked ? (
                  <div className="px-4 py-3.5">
                    <p className="text-xs leading-[var(--lh-prose)] text-[var(--ink-secondary)]">
                      把密码的 <strong className="font-medium text-[var(--ink-primary)]">SHA-1 哈希前 5 个字符</strong>发给
                      Have I Been Pwned 查询，返回的候选在本地比对 ——
                      离开设备的只有这 5 个字符。这是本应用
                      <strong className="font-medium text-[var(--ink-primary)]">唯一</strong>会联系第三方的功能，默认关闭。
                    </p>
                    <button
                      onClick={breach.onEnable}
                      disabled={breach.state === 'checking'}
                      className="btn btn-quiet mt-3 gap-1.5"
                    >
                      {breach.state === 'checking' && <IconSpinner size={13} />}
                      {breach.state === 'checking' ? '查询中…' : '开启检查'}
                    </button>
                    {breach.state === 'failed' && (
                      <p className="mt-2.5 flex items-start gap-2 text-xs text-[var(--risk)]">
                        <IconAlert size={13} className="mt-0.5 shrink-0" />
                        <span>查询失败 —— 可能是网络不通。其余检查不受影响。</span>
                      </p>
                    )}
                  </div>
                ) : report.breached.length === 0 ? (
                  <Clean text="没有发现已泄露的密码" />
                ) : (
                  report.breached.map((f) => (
                    <Row
                      key={f.itemId}
                      label={nameOf(f.itemId)}
                      detail={`在泄露库里出现过 ${f.count.toLocaleString('zh-CN')} 次`}
                    />
                  ))
                )}
              </Finding>

              <Finding title="弱密码" count={report.weak.length} empty="没有弱密码">
                {report.weak.map((f) => (
                  <Row
                    key={f.itemId}
                    label={nameOf(f.itemId)}
                    detail={WEAK_REASON[f.reason] ?? f.reason}
                  />
                ))}
              </Finding>

              <Finding
                title="重复使用的密码"
                count={report.reused.reduce((n, g) => n + g.count, 0)}
                empty="没有重复使用的密码"
              >
                {report.reused.map((g) => (
                  <Row
                    key={g.itemIds.join(',')}
                    label={`${g.count} 条共用同一个密码`}
                    detail={g.itemIds.map(nameOf).join('、')}
                  />
                ))}
              </Finding>

              <Finding title="使用明文 HTTP 的站点" count={report.unsecured.length} empty="没有明文站点">
                {report.unsecured.map((i) => (
                  /*
                   * ⚠️ 这里用 brief 自带的 `i.name`，**不走 `nameOf`** ——
                   * 那一栏的条目在扩展端只存在于后台，如果弹窗的列表还没拉回来，
                   * `nameOf` 会回「（已不在列表里）」：一个把「还没加载」
                   * 说成「已经没了」的错话。名字是这里唯一需要跨过来的东西，
                   * 所以它跟着 brief 一起过来。
                   */
                  <Row key={i.id} label={i.name} detail={i.uris.join('、')} />
                ))}
              </Finding>

              <Finding title="即将到期" count={report.expiring.length} empty="近期没有到期的卡">
                {report.expiring.map((f) => (
                  <Row
                    key={f.itemId}
                    label={nameOf(f.itemId)}
                    detail={`有效期至 ${new Date(f.expiresAt).toLocaleDateString('zh-CN')}`}
                  />
                ))}
              </Finding>
            </div>
          )}

          <p className="mt-7 border-t border-[var(--border-subtle)] pt-5 text-xs leading-[var(--lh-prose)] text-[var(--ink-tertiary)] @[640px]:mt-9">
            所有检查都在本地完成。「已泄露的密码」需要联网查询，默认关闭。
            评分的权重由 Coffer 自己定义，与 1Password 的算法无关。
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * 评分。
 *
 * 刻意不做成 1Password 那种四位数仪表盘 —— 那个数字的算法官方从未公开，
 * 复刻它的外观只会暗示我们有同样的依据，而实际上没有。
 *
 * 做成一栏可以读的结论：分数、评级、**具体是哪几件事**。
 * 光给一个 32 分，用户不知道下一步该干什么；把「5 条弱密码、2 组重复」
 * 摆在旁边，他就知道该去改哪一条了。
 */
function ScoreCard({ score, grade, report }: {
  score: number;
  grade: ScoreGrade;
  report: ReportBrief;
}) {
  const color = grade === 'excellent' || grade === 'good' ? 'var(--safe)'
    : grade === 'fair' ? 'var(--caution)'
    : 'var(--risk)';

  // 只说存在的那几项 —— 罗列一堆「0 条」是在浪费用户读的时间
  const issues: string[] = [];
  if (report.breached.length) issues.push(`${report.breached.length} 条已泄露`);
  if (report.weak.length) issues.push(`${report.weak.length} 条弱密码`);
  const reused = report.reused.reduce((n, g) => n + g.count, 0);
  if (reused) issues.push(`${reused} 条重复使用`);
  if (report.unsecured.length) issues.push(`${report.unsecured.length} 个明文站点`);
  if (report.expiring.length) issues.push(`${report.expiring.length} 张卡即将到期`);

  return (
    <section className="card-well shrink-0 p-4 @[640px]:p-5">
      <div className="flex items-end gap-3 @[640px]:gap-4">
        <span className="text-2xl font-semibold leading-none tabular-nums tracking-[-0.02em]" style={{ color }}>
          {score}
        </span>
        <span className="pb-0.5 text-md font-medium" style={{ color }}>
          {GRADE_LABEL[grade]}
        </span>
        <span className="ml-auto pb-1 text-xs text-[var(--ink-tertiary)]">
          {report.total} 条记录
        </span>
      </div>

      {/* 轨道要看得见 —— 0 分时一条全空的槽也比一片什么都没有清楚 */}
      <div className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-[var(--border-subtle)]" role="img"
        aria-label={`安全评分 ${score} 分，满分 100 分`}>
        <div className="h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-enter)]"
          style={{ width: `${Math.max(score, 1.5)}%`, background: color }} />
      </div>

      <p className="mt-3.5 text-sm leading-snug text-[var(--ink-secondary)]">
        {issues.length === 0
          ? '没有发现明显的问题。'
          : <>发现 <span className="font-medium text-[var(--ink-primary)]">{issues.join(' · ')}</span>。</>}
      </p>
    </section>
  );
}

function Finding({ title, count, empty, children, tone, checked = true }: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
  tone?: 'risk';
  /**
   * 这一类检查**跑过了没有**。
   *
   * ⚠️ 默认 true，但「已泄露的密码」必须显式传 —— 它要联网、要用户开启。
   * 没跑过就画一个 ✓，等于告诉用户「查过了，干净」，
   * 而实际上我们根本不知道。**没检查 ≠ 干净**，这种话不能含糊。
   */
  checked?: boolean;
}) {
  const clean = count === 0 && checked;
  const color = clean ? 'var(--ink-tertiary)' : tone === 'risk' ? 'var(--risk)' : 'var(--caution)';

  return (
    <section className="card">
      <header className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
        <h3 className="min-w-0 flex-1 truncate text-md font-medium">{title}</h3>
        {!checked ? (
          <span className="shrink-0 rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-2xs font-medium text-[var(--ink-tertiary)]">
            未检查
          </span>
        ) : clean ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--ink-tertiary)]">
            <IconCheck size={13} />
            没问题
          </span>
        ) : (
          <span className="shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold tabular-nums"
            style={{ background: `color-mix(in oklab, ${color} 15%, transparent)`, color }}>
            {count}
          </span>
        )}
      </header>
      {clean && tone !== 'risk' ? <Clean text={empty} /> : <div>{children}</div>}
    </section>
  );
}

function Clean({ text }: { text: string }) {
  return <p className="px-4 py-3.5 text-xs text-[var(--ink-tertiary)]">{text}</p>;
}

function Row({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--border-subtle)] px-4 py-2.5 last:border-b-0">
      <span className="min-w-0 shrink-0 truncate text-md">{label}</span>
      <span className="min-w-0 truncate text-right text-xs text-[var(--ink-tertiary)]" title={detail}>
        {detail}
      </span>
    </div>
  );
}
