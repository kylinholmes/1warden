import { useLocalStore, useStoreField } from '@1warden/state/react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconAlert, IconCheck, IconClose, IconInfo } from '@1warden/ui';

/**
 * 提示条 —— 那些「没有别的地方可放」的即时反馈。
 *
 * ## 什么时候该用它（这条比实现重要）
 *
 * 提示条是**抢注意力**的东西：它出现在用户没在看的地方，还带计时器。
 * 所以只有一种情况值得用 —— **动作的结果没有别的地方能显示**：
 *
 *   编辑器保存后自己关掉了      结果是「存了没有」，界面上已经没有它的位置 → 提示条
 *   条目被删掉、从列表里消失了  同上 → 提示条
 *   收藏按钮的请求失败了        原本连 catch 都没有，静默失败 → 提示条
 *
 * 反过来，**复制不进提示条**。复制按钮旁边本来就会把图标换成勾、
 * 文字换成「已复制」，反馈就长在手指底下的位置 —— 那是比屏幕角落更好的
 * 位置。再加一条提示条是同一件事说两遍，而且会让人开始怀疑
 * 「是不是有两件事发生了」。这一条是对任务清单的有意偏离，理由在此。
 *
 * ## 排队与堆叠
 *
 * 可见 3 条，多的排在后头等着（第 4 条会挤掉前面正在读的那条）。
 * 同一条消息**在可见时再来一次**不新开一条，只把它的计时器重置 ——
 * 连续点五次收藏不该换来二十秒的提示条雨。
 *
 * ## 计时
 *
 *   成功 / 中性   4s / 5s
 *   警告          7s
 *   错误          **不自动消失**
 *
 * 错误不自动消失是刻意的，理由不是「错误更重要」这种空话：
 * 用户按下一个按钮后**会转去看别的地方** —— 这正是密码管理器的常态
 * （复制的密码要贴到另一个窗口里）。等他转回来，提示条已经没了，
 * 而「刚才为什么失败」是**只能从这个提示条上读到**的信息，
 * 界面上没有第二份。一条会自己消失的错误提示，等于没提示。
 * 它的出口是右上角的关闭按钮 —— 一直在，不藏到悬停里。
 *
 * 鼠标移到提示条上、或键盘焦点进去时，计时暂停（重新计时，给足阅读时间）。
 *
 * ## 无障碍
 *
 * 每一条自己带 `role` 和 `aria-live`，而不是在容器上设一次：
 * 屏幕阅读器是**在节点插入时**读它的 live 属性，节点带着属性一起进来
 * 才会被念出来。容器常驻在 DOM 里（空的时候也渲染），
 * 否则有些阅读器会错过第一条第。
 *
 *   成功 / 中性 → role="status"  aria-live="polite"    排队念，不打断
 *   警告 / 错误 → role="alert"   aria-live="assertive" 立刻念
 *
 * ⚠️ 没有做「按 Esc 关掉提示条」。Esc 在这个应用里已经有一个意思：
 * 关掉当前浮层。允许它在没有浮层时去关提示条，就会出现「我明明在关
 * 设置面板，怎么少了半条通知」这种错位 —— 一个键干两件事，
 * 迟早会在错误的时机干错那一件。关闭按钮是键盘可达的（Tab 能到），
 * 这就是它的出口。
 */

export type ToastTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface ToastInput {
  tone: ToastTone;
  message: string;
  /**
   * 覆盖该语气的默认存活时长（毫秒）。
   *
   * 有真实用途：批量导入跑完的那条提示，用户要读的是一串数字，
   * 4 秒不够；而「正在导入 187 条」这种进度条如果做成提示条，
   * 它就不该自己消失。默认值对绝大多数情况是对的，所以它是可选项。
   */
  duration?: number;
}

export interface ToastApi {
  show: (input: ToastInput) => void;
}

/** 可见上限。再多就盖住界面了，而提示条不该是主角。 */
const MAX_VISIBLE = 3;

/** 各语气的存活时长（毫秒）。`Infinity` = 不自动消失。 */
const DURATION: Record<ToastTone, number> = {
  success: 4000,
  neutral: 5000,
  warning: 7000,
  danger: Number.POSITIVE_INFINITY,
};

interface Record_ {
  id: number;
  tone: ToastTone;
  message: string;
  status: 'queued' | 'open' | 'leaving';
  /** 实际生效的存活时长，来自语气默认值或调用方的覆盖 */
  duration: number;
  /** 每重置一次计时器 +1 —— 是 effect 的依赖，也是「这条重来过」的标记 */
  nonce: number;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  // 抛错而不是给一个空实现：静默失效的提示条比没有提示条更难查
  if (!api) throw new Error('useToast 必须在 ToastProvider 里使用');
  return api;
}

export function ToastProvider({ children, maxVisible = MAX_VISIBLE }: {
  children: ReactNode;
  /** 可见条数上限。默认 3；预览页会调大，好把四种语气一次拍全。 */
  maxVisible?: number;
}) {
  const viewStore = useLocalStore(() => {
    const records = ([]) as Record_[];
    return { records, bottom: 16 };
  });
  const [records, setRecords] = useStoreField(viewStore, 'records');
  const [bottom, setBottom] = useStoreField(viewStore, 'bottom');
  const regionRef = useRef<HTMLElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);
  const lastOutsideFocus = useRef<HTMLElement | null>(null);
  // Keep one portal host for the provider's lifetime. Moving the host, rather
  // than changing the portal target, preserves notification timers and focus.
  const notificationHost = useMemo(() => {
    if (typeof document === 'undefined') return null;
    const host = document.createElement('div');
    host.style.display = 'contents';
    return host;
  }, []);
  useLayoutEffect(() => {
    if (!notificationHost) return;
    function placeNotifications() {
      const panels = document.querySelectorAll<HTMLElement>('.floating-layer[data-open="true"] .panel');
      const parent = panels.item(panels.length - 1) ?? fallbackRef.current;
      if (!parent || notificationHost!.parentElement === parent) return;
      const active = document.activeElement;
      parent.append(notificationHost!);
      // appendChild can blur a focused descendant. Preserve keyboard position
      // when a parent dialog closes, but opening a dialog still focuses its title.
      if (active instanceof HTMLElement && notificationHost!.contains(active)) active.focus({ preventScroll: true });
    }
    function rememberFocus(event: FocusEvent) {
      if (event.target instanceof HTMLElement && !notificationHost!.contains(event.target)) {
        lastOutsideFocus.current = event.target;
      }
    }
    // Dialogs can open after a persistent error is shown. Put its controls
    // inside the top dialog's DOM/a11y tree, not outside an aria-modal boundary.
    const changes = new MutationObserver(placeNotifications);
    changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-open'] });
    document.addEventListener('focusin', rememberFocus);
    placeNotifications();
    return () => { changes.disconnect(); document.removeEventListener('focusin', rememberFocus); notificationHost.remove(); };
  }, [notificationHost]);
  const visible = records.some(record => record.status !== 'queued');
  useLayoutEffect(() => {
    if (!visible) return;
    let footer: Element | null = null;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    function measure() {
      const panels = document.querySelectorAll('.floating-layer[data-open="true"] .panel');
      const current = panels.item(panels.length - 1)?.querySelector('.panel-foot') ?? null;
      if (footer !== current) { resize?.disconnect(); footer = current; if (footer) resize?.observe(footer); }
      const bounds = footer?.getBoundingClientRect();
      const region = regionRef.current?.getBoundingClientRect();
      // Notifications must not cover the active dialog's actions. Measure the
      // actual footer (including wrapping/safe areas), not a guessed row height.
      const overlaps = bounds && region && bounds.left < region.right && bounds.right > region.left
        && bounds.bottom > window.innerHeight - 16 - region.height;
      setBottom(overlaps ? Math.max(16, window.innerHeight - bounds.top + 12) : 16);
    }
    const changes = new MutationObserver(measure);
    changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-open'] });
    window.addEventListener('resize', measure);
    document.addEventListener('animationend', measure, true);
    measure();
    return () => { resize?.disconnect(); changes.disconnect(); window.removeEventListener('resize', measure); document.removeEventListener('animationend', measure, true); };
  }, [visible, setBottom]);
  const nextId = useRef(1);

  const show = useCallback((input: ToastInput) => {
    setRecords((rs) => {
      // 同一条消息已经在屏幕上 → 不新开，重置它的计时器
      const dupe = rs.findIndex(
        (r) => r.status !== 'leaving' && r.tone === input.tone && r.message === input.message,
      );
      if (dupe >= 0) {
        const next = rs.slice();
        next[dupe] = { ...next[dupe]!, nonce: next[dupe]!.nonce + 1 };
        return next;
      }
      const id = nextId.current++;
      const openCount = rs.filter((r) => r.status === 'open').length;
      return [...rs, {
        id, tone: input.tone, message: input.message, nonce: 0,
        duration: input.duration ?? DURATION[input.tone],
        status: openCount < maxVisible ? 'open' : 'queued',
      }];
    });
  }, []);

  const dismiss = useCallback((id: number) => {
    const item = regionRef.current?.querySelector(`[data-toast-id="${id}"]`);
    if (item?.contains(document.activeElement)) {
      const next = Array.from(regionRef.current!.querySelectorAll<HTMLElement>('li:not([inert]) .toast-close'))
        .find(button => !item.contains(button));
      const panel = regionRef.current!.closest<HTMLElement>('[role="dialog"]');
      const previous = lastOutsideFocus.current;
      const canRestore = previous?.isConnected && !previous.closest('[inert]') && !previous.matches(':disabled')
        && (!panel || panel.contains(previous));
      (next ?? (canRestore ? previous : panel))?.focus({ preventScroll: true });
    }
    setRecords((rs) => rs.map((r) => (r.id === id ? { ...r, status: 'leaving' } : r)));
  }, []);

  /** 退场动画播完 —— 真正摘掉它 */
  const remove = useCallback((id: number) => {
    setRecords((rs) => rs.filter((r) => r.id !== id));
  }, []);

  // 有空位就把排队的那条放进来。依赖 records、又在里面 setRecords ——
  // 收敛条件很明确：要么补满 MAX_VISIBLE，要么没有排队的了。
  useEffect(() => {
    setRecords((rs) => {
      let slots = maxVisible - rs.filter((r) => r.status === 'open').length;
      if (slots <= 0) return rs;
      let changed = false;
      const next = rs.map((r) => {
        if (slots > 0 && r.status === 'queued') { slots -= 1; changed = true; return { ...r, status: 'open' as const }; }
        return r;
      });
      return changed ? next : rs;
    });
  }, [records, maxVisible]);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div ref={fallbackRef} className="contents" />
      {/*
        容器常驻（空的时候也留一个空的 ol）—— 见文件头关于 live region
        必须在插入前就存在的那一段。
        pointer-events-none 落在容器上、auto 落在每一条上：
        没有提示条时右下角那一片不该挡住底下的按钮。
      */}
      {notificationHost && createPortal(<section ref={regionRef} aria-label="通知" className="pointer-events-none fixed right-4 z-[60]" style={{ bottom }}>
        <ol className="flex flex-col gap-2">
          {/*
            ⚠️ 排队的**不渲染**。
            这条一开始漏了：records 里连 queued 的一起 map 出来，
            于是「超过 3 条就排队」变成了「全都显示」—— 上限形同虚设。
            静图看不出来（画面上就是一堆提示条），只有把 5 条一起发才露馅。
          */}
          {records.filter((r) => r.status !== 'queued').map((r) => (
            <ToastItem key={r.id} rec={r} onDismiss={dismiss} onExited={remove} />
          ))}
        </ol>
      </section>, notificationHost)}
    </ToastContext.Provider>
  );
}

const ICON = {
  success: IconCheck,
  warning: IconAlert,
  danger: IconAlert,
  neutral: IconInfo,
} as const;

function ToastItem({ rec, onDismiss, onExited }: {
  rec: Record_;
  onDismiss: (id: number) => void;
  onExited: (id: number) => void;
}) {
  const viewStore = useLocalStore(() => {
    const paused = false;
    return { paused };
  });
  const [paused, setPaused] = useStoreField(viewStore, 'paused');
  const duration = rec.duration;
  const Icon = ICON[rec.tone];

  /*
   * 计时器。
   *
   * 暂停时不记住「还剩多少」，而是**重新给满**：用户把鼠标移上来就是要读，
   * 那就给他完整的一段时间。记住剩余毫秒会做出「读了 3 秒、还剩 1 秒」
   * 这种精确但没用的行为。
   *
   * `nonce` 在依赖里 —— 同一条消息再次到来时它会变，于是计时器重来。
   */
  useEffect(() => {
    if (rec.status !== 'open' || paused || duration === Number.POSITIVE_INFINITY) return;
    const t = setTimeout(() => onDismiss(rec.id), duration);
    return () => clearTimeout(t);
  }, [rec.status, rec.nonce, rec.id, paused, duration, onDismiss]);

  const assertive = rec.tone === 'danger' || rec.tone === 'warning';

  return (
    <li
      // 插入时属性就在节点上，阅读器才会念 —— 见文件头
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      aria-atomic="true"
      inert={rec.status === 'leaving'}
      aria-hidden={rec.status === 'leaving' || undefined}
      data-toast-id={rec.id}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onAnimationEnd={(e) => { if (rec.status === 'leaving' && e.target === e.currentTarget) onExited(rec.id); }}
      className={`toast pointer-events-auto ${rec.status === 'leaving' ? 'toast-out' : 'toast-in'}`}
      data-tone={rec.tone}
    >
      <span className="toast-icon"><Icon size={15} /></span>
      <p className="min-w-0 flex-1 break-words pt-px text-sm leading-snug">{rec.message}</p>
      <button onClick={() => onDismiss(rec.id)} aria-label="关闭通知" title="关闭" className="toast-close mt-px">
        <IconClose size={13} />
      </button>
    </li>
  );
}
