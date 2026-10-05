import { useMemo, useState } from 'react';
import {
  buildReport, checkBreaches,
  type VaultItem, type SecurityReport as Report, type ScoreGrade,
} from '@coffer/vault';
import { IconAlert, IconCheck, IconSpinner } from '@coffer/ui';

/**
 * 安全报告（1Password 的 Watchtower 等价物）。
 *
 * Vaultwarden **完全没有** `/api/reports/*`，所以每一类检查都在本地算 ——
 * 这反而是好事：密码不需要离开设备。唯一的例外是「已泄露的密码」，
 * 它要查 Have I Been Pwned，所以**必须由用户显式开启**，
 * 而且要在开启前把代价讲清楚（见下面的说明文字）。
 *
 * ⚠️ 评分量表是**我们自己定的**。1Password 从未文档化它的算法 ——
 * 那个四位数的仪表盘只存在于截图里。权重写在 `health.ts` 里，
 * 界面上也照实说，不假装复刻。
 *
 * ── 版面
 *
 * 顶部有和别的面板同高的 `.band`，标题在里面 —— 报告占满右半屏，
 * 如果它没有那条带子，从条目列表切过来时整个界面的骨架会塌掉一块。
 */

const GRADE_LABEL: Record<ScoreGrade, string> = {
  excellent: '很好',
  good: '不错',
  fair: '一般',
  poor: '偏弱',
  critical: '危险',
};

const WEAK_REASON: Record<string, string> = {
  tooShort: '太短',
  common: '常见密码',
  commonWithSuffix: '常见密码加后缀',
  leetSubstitution: '字符替换后的常见密码',
  digitsOnly: '全是数字',
  repeatedChar: '重复字符',
};

export function SecurityReportView({ items }: { items: readonly VaultItem[] }) {
  const [breached, setBreached] = useState<Report['breached']>([]);
  const [breachState, setBreachState] = useState<'off' | 'checking' | 'on' | 'failed'>('off');

  // `now` 固定成打开报告那一刻 —— 否则每次重渲染都会重算「即将过期」
  const [now] = useState(() => Date.now());
  const report = useMemo(() => buildReport(items, now, breached), [items, now, breached]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const nameOf = (id: string) => {
    const it = byId.get(id);
    if (!it) return '（已不存在）';
    return it.nameFailed ? '无法解密' : it.name;
  };

  async function enableBreachCheck() {
    setBreachState('checking');
    try {
      const found = await checkBreaches(items);
      setBreached(found);
      setBreachState('on');
    } catch {
      setBreachState('failed');
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶部的带子就是窗口的标题栏 —— 空白处可拖（见 VaultView 里那段注释） */}
      <header className="band shrink-0 px-8" data-tauri-drag-region="deep">
        <h2 className="min-w-0 flex-1 truncate text-[var(--text-lg)] font-semibold">安全报告</h2>
        <span className="shrink-0 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
          {report.total} 条记录
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
        <div className="mx-auto w-full" style={{ maxWidth: 'var(--detail-w)' }}>
          <ScoreCard score={report.score} grade={report.grade} report={report} />

          {report.total === 0 ? (
            <p className="mt-8 text-center text-[var(--text-sm)] text-[var(--ink-tertiary)]">
              保险库里还没有条目。加了记录之后这里会给出检查结果。
            </p>
          ) : (
            <div className="mt-7 space-y-5">
              <Finding
                title="已泄露的密码"
                count={report.breached.length}
                empty="没有发现已泄露的密码"
                tone="risk"
                checked={breachState === 'on'}
              >
                {breachState !== 'on' ? (
                  <div className="px-4 py-3.5">
                    <p className="text-[var(--text-xs)] leading-[var(--lh-prose)] text-[var(--ink-secondary)]">
                      把密码的 <strong className="font-medium text-[var(--ink-primary)]">SHA-1 哈希前 5 个字符</strong>发给
                      Have I Been Pwned 查询，返回的候选在本地比对 ——
                      离开设备的只有这 5 个字符。这是本应用
                      <strong className="font-medium text-[var(--ink-primary)]">唯一</strong>会联系第三方的功能，默认关闭。
                    </p>
                    <button
                      onClick={() => { void enableBreachCheck(); }}
                      disabled={breachState === 'checking'}
                      className="btn btn-quiet mt-3 gap-1.5"
                    >
                      {breachState === 'checking' && <IconSpinner size={13} />}
                      {breachState === 'checking' ? '查询中…' : '开启检查'}
                    </button>
                    {breachState === 'failed' && (
                      <p className="mt-2.5 flex items-start gap-2 text-[var(--text-xs)] text-[var(--risk)]">
                        <IconAlert size={13} className="mt-0.5 shrink-0" />
                        <span>查询失败 —— 可能是网络不通。其余检查不受影响。</span>
                      </p>
                    )}
                  </div>
                ) : report.breached.length === 0 ? (
                  <Clean text="没有发现已泄露的密码" />
                ) : (
                  report.breached.map((f) => (
                    <Row key={f.itemId} label={nameOf(f.itemId)}
                      detail={`在泄露库里出现过 ${f.count.toLocaleString('zh-CN')} 次`} />
                  ))
                )}
              </Finding>

              <Finding title="弱密码" count={report.weak.length} empty="没有弱密码">
                {report.weak.map((f) => (
                  <Row key={f.itemId} label={nameOf(f.itemId)}
                    detail={WEAK_REASON[f.reason] ?? f.reason} />
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
                  <Row key={i.id} label={nameOf(i.id)}
                    detail={i.login?.uris.map((u) => u.uri).filter((u) => u.toLowerCase().startsWith('http://')).join('、') ?? ''} />
                ))}
              </Finding>

              <Finding title="即将到期" count={report.expiring.length} empty="近期没有到期的卡">
                {report.expiring.map((f) => (
                  <Row key={f.itemId} label={nameOf(f.itemId)}
                    detail={`有效期至 ${new Date(f.expiresAt).toLocaleDateString('zh-CN')}`} />
                ))}
              </Finding>
            </div>
          )}

          <p className="mt-9 border-t border-[var(--border-subtle)] pt-5 text-[var(--text-xs)] leading-[var(--lh-prose)] text-[var(--ink-tertiary)]">
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
  report: Report;
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
    <section className="card-well p-5">
      <div className="flex items-end gap-4">
        <span className="text-[var(--text-2xl)] font-semibold leading-none tabular-nums tracking-[-0.02em]" style={{ color }}>
          {score}
        </span>
        <span className="pb-0.5 text-[var(--text-md)] font-medium" style={{ color }}>
          {GRADE_LABEL[grade]}
        </span>
        <span className="ml-auto pb-1 text-[var(--text-xs)] text-[var(--ink-tertiary)]">满分 100</span>
      </div>

      {/* 轨道要看得见 —— 0 分时一条全空的槽也比一片什么都没有清楚 */}
      <div className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-[var(--border-subtle)]" role="img"
        aria-label={`安全评分 ${score} 分，满分 100 分`}>
        <div className="h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-enter)]"
          style={{ width: `${Math.max(score, 1.5)}%`, background: color }} />
      </div>

      <p className="mt-3.5 text-[var(--text-sm)] leading-snug text-[var(--ink-secondary)]">
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
  children: React.ReactNode;
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
        <h3 className="min-w-0 flex-1 truncate text-[var(--text-md)] font-medium">{title}</h3>
        {!checked ? (
          <span className="shrink-0 rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-[var(--text-2xs)] font-medium text-[var(--ink-tertiary)]">
            未检查
          </span>
        ) : clean ? (
          <span className="flex shrink-0 items-center gap-1 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
            <IconCheck size={13} />
            没问题
          </span>
        ) : (
          <span className="shrink-0 rounded-full px-2 py-0.5 text-[var(--text-2xs)] font-semibold tabular-nums"
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
  return <p className="px-4 py-3.5 text-[var(--text-xs)] text-[var(--ink-tertiary)]">{text}</p>;
}

function Row({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--border-subtle)] px-4 py-2.5 last:border-b-0">
      <span className="min-w-0 shrink-0 truncate text-[var(--text-md)]">{label}</span>
      <span className="min-w-0 truncate text-right text-[var(--text-xs)] text-[var(--ink-tertiary)]" title={detail}>
        {detail}
      </span>
    </div>
  );
}
