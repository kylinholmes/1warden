import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 浮在主界面之上的一层 —— 设置面板、删除确认、将来的任何对话框都走这里。
 *
 * ## 为什么要有这个文件
 *
 * 在这之前，界面上唯一一个浮层是删除确认框，它把「遮罩 + 面板 + 取消」
 * 写在自己身上：没有 Esc、点遮罩不关、焦点留在背后的列表上（Tab 能从
 * 对话框里走出去）。设置面板需要同一套东西，如果照抄一遍，就会有两套
 * 各自漏掉一点的浮层 —— 用户眼里的「弹出来的窗口」只有一个概念。
 *
 * ## 交互契约
 *
 * 这些不是可选项，是「弹出一个浮层」这件事的定义：
 *
 *   Esc 关闭          键盘用户的唯一出口，没有它就被困在里面了
 *   点遮罩关闭        鼠标用户的第一反应
 *   焦点进得去        打开时焦点移到面板上；`Tab` 在里面循环，不跑到背后
 *   焦点回得来        关闭后焦点回到**打开它的那个按钮**上 ——
 *                    否则键盘用户被丢回文档开头，得重新 Tab 十几下
 *   退场动画播完再卸  否则关得「啪」一下，看不出这一层是从上面收走的
 *
 * ## 和快速面板的关系
 *
 * 快速面板（`quick.html`）共用的是**视觉**，不是这里的逻辑：它跑在另一个
 * OS 窗口里，窗口边界本身就是它的遮罩，焦点也出不去 —— 焦点陷阱和点外部
 * 关闭对它没有意义，硬套只会多一层空转。它复用 `.panel` 那组样式类。
 */

/** 退场动画的兜底时长。取 3 档动效里最长的那档 —— 动画没跑起来也不卡住。 */
const EXIT_FALLBACK_MS = 400;

/**
 * 让一个节点在「已关闭」之后再多留一会儿，把退场动画播完。
 *
 * `onAnimationEnd` 是主路径；定时器是兜底 —— `prefers-reduced-motion` 下
 * 时长被压到 0.01ms，某些情况下 animationend 仍会触发，但万一浏览器
 * 因为别的原因没派发（元素被 `display:none` 的祖先盖住等），
 * 定时器保证这个节点一定会被卸掉，不会永远挂在 DOM 里。
 */
function usePresence(open: boolean): { mounted: boolean; leaving: boolean; onExited: () => void } {
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (open) {
      setLeaving(false);
      setMounted(true);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    const t = setTimeout(() => { setLeaving(false); setMounted(false); }, EXIT_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  const onExited = useCallback(() => { setLeaving(false); setMounted(false); }, []);
  return { mounted, leaving, onExited };
}

/** 面板里能拿到焦点的元素。和浏览器自己的 Tab 顺序规则一致。 */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function FloatingPanel({
  open, onClose, labelledBy, className = '', children, footer,
}: {
  open: boolean;
  onClose: () => void;
  /** 面板标题元素的 id —— 屏幕阅读器靠它念出「这是个什么窗口」 */
  labelledBy: string;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { mounted, leaving, onExited } = usePresence(open);
  const panelRef = useRef<HTMLDivElement>(null);
  /** 打开之前焦点在谁身上 —— 关闭时还给它 */
  const restoreRef = useRef<HTMLElement | null>(null);

  // 打开时：记住来处、把焦点移进面板
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    // 焦点给面板**本身**而不是第一个控件：这样屏幕阅读器先念标题，
    // 也不会有一个控件莫名其妙地带着焦点环（用户还没做任何操作）
    panelRef.current?.focus();
    return () => {
      const target = restoreRef.current;
      restoreRef.current = null;
      // 触发按钮可能已经不在了（比如它所在的视图被换掉）——
      // isConnected 挡一下，否则 focus() 会把焦点丢给 body
      if (target?.isConnected) target.focus();
    };
  }, [open]);

  // Esc 关闭 + Tab 循环
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // 阻止冒泡：背后的界面（比如保险库里的 ⌘F/⌘L 监听）不该同时响应
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === panel);
      if (items.length === 0) { e.preventDefault(); panel.focus(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      // 焦点在面板上（还没进到控件里）时，Tab 应该进第一个、Shift+Tab 进最后一个
      if (active === panel) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      {/* 遮罩只负责「点它关闭」。用 onMouseDown 而不是 onClick：
          在面板里按下、拖到遮罩上再松手不该把窗口关掉 */}
      <div
        className={`scrim ${leaving ? 'scrim-out' : 'scrim-in'}`}
        onMouseDown={(e) => { e.preventDefault(); onClose(); }}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onExited(); }}
        className={`panel relative flex max-h-[min(680px,calc(100vh-32px))] w-full flex-col outline-none ${leaving ? 'panel-out' : 'panel-in'} ${className}`}
      >
        {children}
        {footer && <div className="panel-foot">{footer}</div>}
      </div>
    </div>
  );
}
