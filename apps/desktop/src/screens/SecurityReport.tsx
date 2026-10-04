import { useMemo, useState } from 'react';
import {
  buildReport, checkBreaches,
  type VaultItem, type SecurityReport as Report, type ScoreGrade,
} from '@coffer/vault';

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
    <div className="mx-auto max-w-2xl p-8">
      <h2 className="mb-6 text-[var(--text-xl)] font-semibold tracking-tight">安全报告</h2>

      <ScoreCard score={report.score} grade={report.grade} />

      {report.total === 0 ? (
        <p className="mt-6 text-center text-[var(--text-sm)] text-[var(--ink-tertiary)]">
          保险库里还没有条目。
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          <Finding
            title="已泄露的密码"
            count={report.breached.length}
            empty="没有发现已泄露的密码"
            tone="risk"
            checked={breachState === 'on'}
          >
            {breachState !== 'on' ? (
              <div className="px-4 py-3">
                <p className="mb-2 text-[var(--text-xs)] leading-relaxed text-[var(--ink-secondary)]">
                  把密码的 <strong className="font-medium">SHA-1 哈希前 5 个字符</strong>发给
                  Have I Been Pwned 查询，返回的候选在本地比对 ——
                  离开设备的只有这 5 个字符。这是本应用
                  <strong className="font-medium">唯一</strong>会联系第三方的功能，默认关闭。
                </p>
                <button
                  onClick={() => { void enableBreachCheck(); }}
                  disabled={breachState === 'checking'}
                  className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-2.5 py-1 text-[var(--text-xs)] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  {breachState === 'checking' ? '查询中…' : '开启检查'}
                </button>
                {breachState === 'failed' && (
                  <p className="mt-1.5 text-[var(--text-xs)] text-[var(--risk)]">
                    查询失败 —— 可能是网络不通。其余检查不受影响。
                  </p>
                )}
              </div>
            ) : report.breached.length === 0 ? (
              <p className="px-4 py-3 text-[var(--text-xs)] text-[var(--ink-tertiary)]">
                没有发现已泄露的密码
              </p>
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

      <p className="mt-8 text-[var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
        所有检查都在本地完成。「已泄露的密码」需要联网查询，默认关闭。
        评分的权重由 Coffer 自己定义，与 1Password 的算法无关。
      </p>
    </div>
  );
}

/**
 * 评分卡。
 *
 * 刻意不做成 1Password 那种四位数仪表盘 —— 那个数字的算法官方从未公开，
 * 复刻它的外观只会暗示我们有同样的依据，而实际上没有。
 */
function ScoreCard({ score, grade }: { score: number; grade: ScoreGrade }) {
  const color = grade === 'excellent' || grade === 'good' ? 'var(--safe)'
    : grade === 'fair' ? 'var(--caution)'
    : 'var(--risk)';

  return (
    <div className="rounded-[var(--radius-lg)] bg-[var(--surface-raised)] p-6"
      style={{ boxShadow: 'var(--elev-1)' }}>
      <div className="flex items-baseline gap-3">
        <span className="text-[var(--text-2xl)] font-semibold tabular-nums" style={{ color }}>
          {score}
        </span>
        <span className="text-[var(--text-sm)] text-[var(--ink-secondary)]">
          {GRADE_LABEL[grade]}
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full"
        style={{ background: 'var(--border-subtle)' }}>
        <div className="h-full rounded-full transition-[width] duration-[var(--dur-slow)]"
          style={{ width: `${score}%`, background: color }} />
      </div>
    </div>
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
  return (
    <section className="rounded-[var(--radius-lg)] bg-[var(--surface-raised)]"
      style={{ boxShadow: 'var(--elev-1)' }}>
      <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2.5">
        <h3 className="text-[var(--text-sm)] font-medium">{title}</h3>
        <span className="text-[var(--text-xs)] tabular-nums"
          style={{ color: clean ? 'var(--ink-tertiary)' : tone === 'risk' ? 'var(--risk)' : 'var(--caution)' }}>
          {!checked ? '未检查' : clean ? '✓' : count}
        </span>
      </header>
      {clean && tone !== 'risk' ? (
        <p className="px-4 py-3 text-[var(--text-xs)] text-[var(--ink-tertiary)]">{empty}</p>
      ) : (
        <div>{children}</div>
      )}
    </section>
  );
}

function Row({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--border-subtle)] px-4 py-2 last:border-0">
      <span className="min-w-0 shrink-0 truncate text-[var(--text-sm)]">{label}</span>
      <span className="min-w-0 truncate text-right text-[var(--text-xs)] text-[var(--ink-tertiary)]" title={detail}>
        {detail}
      </span>
    </div>
  );
}
