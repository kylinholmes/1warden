import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconCopy } from './icons';

/**
 * 复制到剪贴板，**N 秒后自动清空**（若期间用户没复制别的东西）。
 *
 * 30 秒这个数是三处共用的约定（这里、扩展、快速面板的 use-quick-bridge），
 * 因为剪贴板是明文密码离开这个应用之后唯一还留着它的地方 ——
 * 自动清空是「复制」这个动作的收尾，不是附加功能。
 *
 * ⚠️ 只在剪贴板里**还是我们写进去的那个值**时才清：
 * 用户完全可能复制完密码后又复制了别的东西，那时清掉的是别人的内容。
 *
 * 反馈长在按钮上（图标变勾、文字变「已复制」），不发提示条 ——
 * 理由见 Toast.tsx 顶部那段：同一件事说两遍会让人怀疑发生了两件事。
 */
export function CopyButton({ value, className = 'btn btn-ghost shrink-0 gap-1.5' }: {
  value: string;
  /** 外观由使用处决定 —— 详情页是安静的小按钮，生成器里它是主操作 */
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        setCopied(false);
        try {
          const current = await navigator.clipboard.readText();
          if (current === value) await navigator.clipboard.writeText('');
        } catch { /* 读剪贴板可能被拒绝，那就保持原样 */ }
      }, 30_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      onClick={() => { void copy(); }}
      title={copied ? '已复制' : '复制（30 秒后自动清空剪贴板）'}
      aria-label="复制"
      data-state={copied ? 'ok' : undefined}
      className={className}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      {copied ? '已复制' : '复制'}
    </button>
  );
}
