import { useState } from 'react';
import { ext } from '../ext-api';
import { IconGlyph, IconAlert, IconArrowLeft, IconCheck, IconCopy, IconGlobe, IconStar } from '@coffer/ui';
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
export function ItemDetail({ item, icons, busy, onBack, onFill }: {
  item: ItemSummary;
  icons: IconStore | null;
  busy: boolean;
  onBack: () => void;
  onFill: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function copy(field: 'username' | 'password' | 'totp') {
    setError(null);
    try {
      /*
       * 后台取出明文并安排好「30 秒后清理」，值回到这里由我们写剪贴板。
       * 写在这里而不是后台：弹窗**有用户手势**，而且写失败时能当场报错 ——
       * 放到离屏文档里写就没人能告诉用户「这次没复制上」。
       */
      const res = await ext.runtime.sendMessage({
        type: 'coffer:copy', itemId: item.id, field,
      }) as { value?: string; error?: string };
      if (res?.error) throw new Error(res.error);
      await navigator.clipboard.writeText(res?.value ?? '');
      setCopied(field);
      setTimeout(() => setCopied(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : '复制失败');
    }
  }

  const fields: { key: 'username' | 'password' | 'totp'; label: string; value: string }[] = [];
  if (item.username) fields.push({ key: 'username', label: '用户名', value: item.username });
  if (item.hasPassword) fields.push({ key: 'password', label: '密码', value: '••••••••••' });
  if (item.hasTotp) fields.push({ key: 'totp', label: '验证码', value: '••••••' });

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
          <dl className="mt-4 flex flex-col">
            {fields.map((f) => (
              <div
                key={f.key}
                className="flex items-center gap-3 border-b border-[var(--border-subtle)] py-2.5 last:border-b-0"
              >
                <dt className="w-16 shrink-0 text-xs text-[var(--ink-tertiary)]">{f.label}</dt>
                <dd className="min-w-0 flex-1">
                  <span className="secret block truncate text-md">{f.value}</span>
                </dd>
                <button
                  type="button"
                  onClick={() => { void copy(f.key); }}
                  aria-label={`复制${f.label}`}
                  className="flex shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--ink-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
                >
                  {copied === f.key ? <IconCheck size={13} /> : <IconCopy size={13} />}
                  {copied === f.key ? '已复制' : '复制'}
                </button>
              </div>
            ))}
          </dl>
        )}

        {item.uris.length > 0 && (
          <div className="mt-4">
            <h2 className="mb-1.5 text-xs text-[var(--ink-tertiary)]">网址</h2>
            <ul className="flex flex-col gap-1">
              {item.uris.map((u) => (
                <li key={u} className="flex items-center gap-2 text-sm text-[var(--ink-secondary)]">
                  <IconGlobe size={13} className="shrink-0 text-[var(--ink-tertiary)]" />
                  <span className="secret min-w-0 truncate">{u}</span>
                </li>
              ))}
            </ul>
          </div>
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
