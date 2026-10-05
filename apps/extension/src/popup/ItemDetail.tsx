import { useEffect, useState } from 'react';
import { ext } from '../ext-api';
import {
  IDENTITY_LABEL, IconGlyph, IconAlert, IconArrowLeft, IconStar, Section, SecretField,
} from '@coffer/ui';
import { IconStore } from '@coffer/vault';
import type { ItemSummary } from './Popup';

/**
 * 第三层：一条记录的详情。
 *
 * ## 为什么这些动作从列表行搬到这儿
 *
 * 早先它们**全铺在列表的每一行里**：图标 + 名字 + 用户名 + 填充按钮 +
 * 分隔线 + 三个复制按钮 + 「30 秒后清空」。后果是每一条又宽又高 ——
 * 列表不像列表（一屏放不下几条），详情也不像详情（真正的信息只有名字和用户名）。
 *
 * 现在列表只回答「有哪些」，这里回答「这一条是什么、能对它做什么」。
 *
 * ## Material 的做法
 *
 * 详情是**盖住列表**的独立一屏，不是从旁边挤进来的一栏 —— 所以顶上要有一条
 * 带返回箭头的 app bar，否则用户不知道该往哪儿退。这条在 M3 里叫
 * top app bar，高度 56。
 *
 * ## ⚠️ 这里**不去后台取完整条目**
 *
 * 需要的字段（用户名、有没有密码、有没有验证码、网址）`ItemSummary` 里全有。
 * 明文密码只在点「复制」的那一刻由后台取一次 —— 它**从不进入这个组件**。
 * 详情屏没有理由看到它，能看到就多一处会泄漏的地方。
 */
/**
 * 弹窗这边**不用**自己挂「30 秒后清空」的定时器 —— 后台的离屏文档会清，
 * 而它活得比弹窗久。在弹窗里挂的话，用户复制完就关掉弹窗，
 * 定时器跟着消失，安全网刚好漏掉它要接住的那种情况。
 */
const noLocalClear = (): void => {};

/** `coffer:item` 回的展示字段 —— 没有密码，密码只在「复制」那一刻取 */
interface ExtraFields {
  notes: string | null;
  card: { cardholderName: string | null; brand: string | null; number: string | null;
          expMonth: string | null; expYear: string | null; code: string | null } | null;
  identity: Record<string, unknown> | null;
  sshKey: { publicKey: string | null; fingerprint: string | null; privateKey: string | null } | null;
  secureNote: { type: number } | null;
}


export function ItemDetail({ item, icons, busy, onBack, onFill }: {
  item: ItemSummary;
  icons: IconStore | null;
  busy: boolean;
  onBack: () => void;
  onFill: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  /*
   * 摘要里**没有**卡片号、身份信息、SSH 密钥 —— 列表接口刻意只回摘要。
   * 详情要用，就按需取**这一条**（见后台 `coffer:item` 的说明）。
   * 明文密码仍然不在这里：它只在点「复制」那一刻由后台取一次。
   */
  const [extra, setExtra] = useState<ExtraFields | null>(null);

  useEffect(() => {
    let alive = true;
    setExtra(null);
    void ext.runtime.sendMessage({ type: 'coffer:item', itemId: item.id })
      .then((r) => { if (alive) setExtra(r as ExtraFields); })
      .catch(() => { if (alive) setExtra(null); });
    return () => { alive = false; };
  }, [item.id]);

  /**
   * 取值那一步 —— 明文**只在复制那一刻过手**，不躺在组件状态里。
   *
   * 写剪贴板由 `CopyButton` 自己做（弹窗**有用户手势**，写失败时能当场报错；
   * 放到离屏文档里写就没人能告诉用户「这次没复制上」）。
   * 「30 秒后按值清空」则交给**后台**安排 —— 弹窗一关它的定时器就没了，
   * 而「复制完忘了剪贴板里还有密码」正是弹窗已经关掉的那种情况。
   */
  function valueFor(field: 'username' | 'password' | 'totp'): () => Promise<string> {
    return async () => {
      const res = await ext.runtime.sendMessage({
        type: 'coffer:copy', itemId: item.id, field,
      }) as { value?: string; error?: string };
      if (res?.error) throw new Error(res.error);
      return res?.value ?? '';
    };
  }

  /*
   * ⚠️ 这里的 `shown` 是**显示**用的，不是真值 —— 弹窗手里根本没有明文
   * （列表接口刻意只回摘要）。真值只在点「复制」那一刻由后台取一次，
   * 见上面的 `valueFor`。
   *
   * 所以这几个字段**没有「显示/隐藏」开关**：没有可以揭示的东西。
   * 桌面端那边有，因为明文就在它手里。
   */
  const fields: { key: 'username' | 'password' | 'totp'; label: string; shown: string }[] = [];
  if (item.username) fields.push({ key: 'username', label: '用户名', shown: item.username });
  if (item.hasPassword) fields.push({ key: 'password', label: '密码', shown: '••••••••••' });
  if (item.hasTotp) fields.push({ key: 'totp', label: '验证码', shown: '••••••' });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* top app bar —— M3 规格高度 56 */}
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] px-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回列表"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--ink-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
        >
          <IconArrowLeft size={18} />
        </button>
        {/*
          ⚠️ app bar 里**不重复条目名** —— 下面紧接着就是大图标 + 名字，
          同一个词出现两次只会让这一屏显得啰嗦。Material 的 detail 屏
          在大标题就在正下方时也是这么处理的。
        */}
        <span className="min-w-0 flex-1" />
        {item.favorite && <IconStar size={15} filled className="mr-1 shrink-0 text-[var(--caution)]" />}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        <div className="flex items-center gap-3">
          <IconGlyph
            domain={item.iconDomain}
            text={item.avatarText}
            hue={item.avatarHue}
            type={item.type}
            store={icons}
            size={44}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-lg font-medium leading-snug">{item.name}</span>
            {item.summary !== null && (
              <span className="mt-0.5 block truncate text-xs text-[var(--ink-tertiary)]">
                {item.summary}
              </span>
            )}
          </span>
        </div>

        {fields.length > 0 && (
          <div className="mt-5">
            {/*
              和桌面端**同一套零件**（`Section` + `SecretField`）——
              详情两边的分组方式和字段排布必须一致，否则「登录信息」
              在一边是一张卡、在另一边是几个散字段。
            */}
            <Section title="登录">
              {fields.map((f) => (
                <SecretField
                  key={f.key}
                  label={f.label}
                  value={f.shown}
                  getValue={valueFor(f.key)}
                  onCopied={noLocalClear}
                  onCopyError={(e) => setError(e instanceof Error ? e.message : '复制失败')}
                />
              ))}
            </Section>
          </div>
        )}

        {extra?.card && (
          <Section title="信用卡">
            {extra.card.cardholderName && <SecretField label="持卡人" value={extra.card.cardholderName} />}
            {extra.card.brand && <SecretField label="卡组织" value={extra.card.brand} />}
            {extra.card.number && <SecretField label="卡号" value={extra.card.number} masked />}
            {(extra.card.expMonth || extra.card.expYear) && (
              <SecretField label="有效期" value={`${extra.card.expMonth ?? ''}/${extra.card.expYear ?? ''}`} />
            )}
            {extra.card.code && <SecretField label="安全码" value={extra.card.code} masked />}
          </Section>
        )}

        {extra?.sshKey && (
          <Section title="SSH 密钥">
            {extra.sshKey.publicKey && <SecretField label="公钥" value={extra.sshKey.publicKey} />}
            {extra.sshKey.fingerprint && <SecretField label="指纹" value={extra.sshKey.fingerprint} />}
            {extra.sshKey.privateKey && <SecretField label="私钥" value={extra.sshKey.privateKey} masked />}
          </Section>
        )}

        {extra?.identity && (
          <Section title="身份信息">
            {Object.entries(extra.identity)
              .filter(([, v]) => typeof v === 'string' && v !== '')
              .map(([k, v]) => (
                <SecretField key={k} label={IDENTITY_LABEL[k] ?? k} value={v as string} />
              ))}
          </Section>
        )}

        {extra?.notes && (
          <Section title="备注">
            <p className="secret whitespace-pre-wrap py-2.5 text-md leading-relaxed">{extra.notes}</p>
          </Section>
        )}

        {item.uris.length > 0 && (
          <Section title="网址">
            {item.uris.map((u, i) => (
              <SecretField key={u} label={i === 0 ? '网址' : `网址 ${i + 1}`} value={u} />
            ))}
          </Section>
        )}

        {/*
          复制后会清空剪贴板，把这件事说出来 —— 否则用户过一会儿粘贴不出来
          会以为是坏了。放在动作**下面**，因为它是结果，不是警告。
        */}
        {fields.some((f) => f.key === 'password') && (
          <p className="mt-3 text-2xs text-[var(--ink-tertiary)]">
            复制密码后 30 秒会清空剪贴板。
          </p>
        )}

        {error && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-[var(--risk)]" role="alert">
            <IconAlert size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </p>
        )}

        {item.hasPassword && (
          <button
            type="button"
            onClick={onFill}
            disabled={busy}
            className="btn btn-primary mt-5 w-full py-2.5"
          >
            {busy ? '正在填充…' : '填充到当前页面'}
          </button>
        )}
      </div>
    </div>
  );
}
