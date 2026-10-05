import { useEffect, useState } from 'react';
import { ext } from '../ext-api';
import {
  IDENTITY_LABEL, IconAlert, IconArrowLeft, IconImport, IconPencil, IconStar, ItemIcon, Section, SecretField,
} from '@coffer/ui';
import { IconStore, attachmentBytes } from '@coffer/vault';
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
  /** 隐藏字段（type 1）的 `value` 是 `null` —— 要走揭示才拿得到，和密码同一个规矩 */
  customFields: { name: string; type: number; value: string | null }[];
  /** 只有日期 —— 值要走 `coffer:reveal-history` 才拿得到 */
  passwordHistory: { lastUsedDate: string }[];
  /** 只有元数据 —— 字节要单独要（见 `download`） */
  attachments: { id: string; fileName: string; size: string }[];
}


/** 字节数说人话 —— 附件列表里「1234567」没人读得出来是多大 */
function sizeText(size: string): string {
  const n = attachmentBytes({ size });
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ItemDetail({ item, icons, busy, onBack, onFill, onEdit }: {
  item: ItemSummary;
  icons: IconStore | null;
  busy: boolean;
  onBack: () => void;
  onFill: () => void;
  onEdit: () => void;
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
  /**
   * 下载一个附件。
   *
   * 字节从后台来（解密也在那边 —— 附件是加密存的，密钥在会话里）。
   * 拿到之后拼一个 Blob、造一个对象 URL、让一个隐藏的 `<a download>` 去点。
   *
   * ⚠️ **对象 URL 不能马上回收** —— 下载还没开始就把 blob 撤了，
   * 用户拿到的是一个失败。60 秒是个折中：足够大的文件起步，
   * 又不至于让几 MB 的字节在内存里躺到弹窗关掉。
   */
  async function download(a: { id: string; fileName: string }): Promise<void> {
    setError(null);
    try {
      const r = await ext.runtime.sendMessage({
        type: 'coffer:download-attachment', itemId: item.id, attachmentId: a.id,
      }) as { fileName?: string; base64?: string; error?: string };
      if (r?.error) throw new Error(r.error);
      const bin = atob(r.base64 ?? '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes]));
      const el = document.createElement('a');
      el.href = url;
      el.download = r.fileName || a.fileName;
      el.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : '下载失败');
    }
  }

  /*
   * 取一个字段的值。`copy` 那条会**顺手安排剪贴板清理**，揭示那条不会 ——
   * 所以这里按用途分成两个，而不是共用一个（见 SecretField 的 `revealValue`）。
   */
  function valueFor(field: 'username' | 'password' | 'totp', via: 'copy' | 'reveal'): () => Promise<string> {
    return async () => {
      const res = await ext.runtime.sendMessage({
        type: via === 'copy' ? 'coffer:copy' : 'coffer:reveal', itemId: item.id, field,
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
   * 但「看不了」和「点了才去看」是两回事 —— 后者是正常的密码管理器行为，
   * 前者是残的。所以密码和验证码走 `SecretField` 的惰性揭示：
   * 明文只在揭开那一刻由后台取一次，不揭开就永远不到弹窗里来。
   */
  const fields: {
    key: 'username' | 'password' | 'totp'; label: string; shown: string; masked?: boolean;
  }[] = [];
  // 用户名不遮 —— 它本来就在摘要里、在列表行里显示着，遮起来只是多一次点击
  if (item.username) fields.push({ key: 'username', label: '用户名', shown: item.username });
  /*
   * ⚠️ 密码和验证码**加揭示开关**（`masked`）。
   *
   * `shown` 是占位点，真值由 `SecretField` 在用户点「显示」那一刻
   * 通过 `getValue` 去后台取（见那边 `toggle` 的说明）。
   * 在此之前弹窗里**没有眼睛按钮**，而桌面端有 —— 同一屏一个有
   * 一个没有，用户只会觉得弹窗是残的。
   */
  if (item.hasPassword) fields.push({ key: 'password', label: '密码', shown: '••••••••••', masked: true });
  if (item.hasTotp) fields.push({ key: 'totp', label: '验证码', shown: '••••••', masked: true });

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
        <button
          type="button"
          onClick={onEdit}
          aria-label="编辑"
          title="编辑"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--ink-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
        >
          <IconPencil size={16} />
        </button>
        {item.favorite && <IconStar size={15} filled className="mr-1 shrink-0 text-[var(--caution)]" />}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        <div className="flex items-center gap-3">
          {/* ⚠️ 走 `ItemIcon` —— 和列表行、和桌面端同一条路径 */}
          <ItemIcon
            iconDomain={item.iconDomain}
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
                  {...(f.masked === true ? { masked: true, revealValue: valueFor(f.key, 'reveal') } : {})}
                  getValue={valueFor(f.key, 'copy')}
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

        {/*
          ⚠️ 自定义字段在弹窗里以前**完全不显示** —— 而它是「我把 PIN /
          安全问题答案存在这儿」的地方。桌面端一直有，弹窗没有。
        */}
        {extra && extra.customFields.length > 0 && (
          <Section title="自定义字段">
            {extra?.customFields.map((f, i) => (
              <SecretField
                key={`${f.name}-${i}`}
                label={f.name}
                /* 隐藏字段的值没过来，占位点由 `revealed` 补 —— 见 SecretField */
                value={f.value ?? '••••••••'}
                {...(f.value === null
                  ? {
                      masked: true,
                      revealValue: async () => {
                        const res = await ext.runtime.sendMessage({
                          type: 'coffer:reveal-custom', itemId: item.id, index: i,
                        }) as { value?: string; error?: string };
                        if (res?.error) throw new Error(res.error);
                        return res?.value ?? '';
                      },
                    }
                  : {})}
                onCopied={noLocalClear}
                onCopyError={(e) => setError(e instanceof Error ? e.message : '复制失败')}
              />
            ))}
          </Section>
        )}

        {extra && extra.attachments.length > 0 && (
          <Section title="附件">
            {extra.attachments.map((a) => (
              <div key={a.id} className="flex items-center gap-3 border-b border-[var(--border-subtle)] py-2.5 last:border-b-0">
                <span className="min-w-0 flex-1 truncate text-md" title={a.fileName}>{a.fileName}</span>
                <span className="shrink-0 text-xs tabular-nums text-[var(--ink-tertiary)]">
                  {sizeText(a.size)}
                </span>
                <button
                  type="button"
                  onClick={() => { void download(a); }}
                  aria-label={`下载 ${a.fileName}`}
                  title="下载"
                  className="shrink-0 rounded-[var(--radius-sm)] p-1.5 text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
                >
                  <IconImport size={14} />
                </button>
              </div>
            ))}
          </Section>
        )}

        {/* 历史密码：日期 + 遮着的值。要看哪一条就点那一条的眼睛 —— 明文不主动过来 */}
        {extra && extra.passwordHistory.length > 0 && (
          <Section title="历史密码">
            {extra.passwordHistory.map((h, i) => (
              <SecretField
                key={`${h.lastUsedDate}-${i}`}
                label={new Date(h.lastUsedDate).toLocaleDateString('zh-CN')}
                value={'••••••••'}
                masked
                revealValue={async () => {
                  const res = await ext.runtime.sendMessage({
                    type: 'coffer:reveal-history', itemId: item.id, index: i,
                  }) as { value?: string; error?: string };
                  if (res?.error) throw new Error(res.error);
                  return res?.value ?? '';
                }}
                onCopied={noLocalClear}
                onCopyError={(e) => setError(e instanceof Error ? e.message : '复制失败')}
              />
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
