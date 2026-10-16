import { useId, useLayoutEffect, useRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { useLocalStore, useStoreField } from '@1warden/state/react';
import { IconCheck, IconChevronDown } from './icons';

export interface SelectOption { value: string; label: string; disabled?: boolean; suffix?: ReactNode }
export interface SelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'children'> {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}

/** A select-only combobox. Focus stays on its trigger, so a popup never escapes
 * the surrounding dialog's focus trap. The HTML popover top layer escapes scroll
 * clipping without a body portal (which would land in an inert background). */
export function Select({ value, options, onChange, placeholder = '请选择', className = '',
  disabled, id: suppliedId, onKeyDown, onBlur, ...props }: SelectProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const popupId = `${id}-options`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', at: 0 });
  const store = useLocalStore(() => ({ open: false, active: -1 }));
  const [open, setOpen] = useStoreField(store, 'open');
  const [active, setActive] = useStoreField(store, 'active');
  const selected = options.find(option => option.value === value);
  const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const close = () => { setOpen(false); search.current.text = ''; };
  const show = (edge?: 'first' | 'last') => {
    if (disabled || trigger.current?.matches(':disabled') || trigger.current?.closest('[inert]')) return;
    const current = options.findIndex(option => option.value === value && !option.disabled);
    setActive(edge === 'last' ? enabled.at(-1) ?? -1 : edge === 'first' ? enabled[0] ?? -1 : current >= 0 ? current : enabled[0] ?? -1);
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (disabled || trigger.current?.matches(':disabled') || !option || option.disabled || trigger.current?.closest('[inert]')) return;
    close();
    trigger.current?.focus({ preventScroll: true });
    if (option.value !== value) onChange(option.value);
  };

  useLayoutEffect(() => {
    if (!open || disabled) { if (disabled) setOpen(false); return; }
    const anchor = trigger.current!;
    const list = popup.current!;
    const viewport = window.visualViewport;
    const ancestors: HTMLElement[] = [];
    const scrollPositions = new Map<Element, { top: number; left: number; x: boolean; y: boolean }>();
    for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
      ancestors.push(parent);
      const style = getComputedStyle(parent);
      const x = /^(auto|scroll)$/.test(style.overflowX);
      const y = /^(auto|scroll)$/.test(style.overflowY);
      if (x || y) scrollPositions.set(parent, { top: parent.scrollTop, left: parent.scrollLeft, x, y });
    }
    const position = () => {
      if (anchor.closest('[inert]') || anchor.matches(':disabled') || !anchor.isConnected) { close(); return; }
      const rect = anchor.getBoundingClientRect();
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const above = rect.top - topEdge - 12;
      const below = topEdge + height - rect.bottom - 12;
      const up = below < 192 && above > below;
      const maxHeight = Math.max(0, Math.min(288, up ? above : below));
      const popupWidth = Math.min(Math.max(rect.width, 180), width - 16);
      Object.assign(list.style, { width: `${popupWidth}px`, maxHeight: `${maxHeight}px`,
        left: `${Math.max(leftEdge + 8, Math.min(rect.left, leftEdge + width - popupWidth - 8))}px`,
        top: `${up ? rect.top - Math.min(list.scrollHeight, maxHeight) - 4 : rect.bottom + 4}px` });
    };
    // Keep the popup in its modal's DOM subtree; showPopover promotes only its
    // painting, not DOM ownership or inherited theme variables.
    list.showPopover?.();
    position();
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!anchor.contains(target) && !list.contains(target)) close();
    };
    // Only scrolling an actual user-scrollable pane dismisses the popup. During
    // a slide-in, Edge can clamp an overflow:hidden shell's programmatic scroll
    // position on every frame; that is layout movement, not a user dismissal.
    const scroll = (event: Event) => {
      if (list.contains(event.target as Node)) return;
      const target = event.target === document ? document.scrollingElement : event.target as Element;
      const initial = target ? scrollPositions.get(target) : undefined;
      if (target && initial && ((initial.y && target.scrollTop !== initial.top) || (initial.x && target.scrollLeft !== initial.left))) close();
      else position();
    };
    // A top-layer popup does not inherit its dialog's transform. Follow finite
    // ancestor entrance animations until they finish, then stop frame sampling.
    const animations = ancestors.flatMap(element => element.getAnimations?.() ?? [])
      .filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity);
    let frame = 0;
    const followAnimation = () => {
      position();
      if (animations.some(animation => animation.playState === 'running')) frame = requestAnimationFrame(followAnimation);
    };
    if (animations.length) frame = requestAnimationFrame(followAnimation);
    const ancestorChange = new MutationObserver(position);
    ancestorChange.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['inert', 'disabled'] });
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(position) : null;
    resize?.observe(anchor);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('blur', close);
    viewport?.addEventListener('resize', position);
    viewport?.addEventListener('scroll', position);
    return () => {
      list.hidePopover?.();
      cancelAnimationFrame(frame);
      ancestorChange.disconnect(); resize?.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('blur', close);
      viewport?.removeEventListener('resize', position);
      viewport?.removeEventListener('scroll', position);
    };
  }, [open, disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const list = popup.current;
    const option = list?.children[active] as HTMLElement | undefined;
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [active, open]);

  function key(event: KeyboardEvent<HTMLButtonElement>) {
    onKeyDown?.(event);
    if (event.key === 'Tab') { close(); return; }
    if (event.defaultPrevented || disabled || trigger.current?.matches(':disabled')) return;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const edge = event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined;
      if (!open) { show(edge); return; }
      const index = enabled.indexOf(active);
      setActive(edge === 'first' ? enabled[0] ?? -1 : edge === 'last' ? enabled.at(-1) ?? -1
        : enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length] ?? -1);
      return;
    }
    if (event.key === 'Enter' || (event.key === ' ' && !search.current.text)) {
      event.preventDefault(); event.stopPropagation();
      if (open) choose(active); else show();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const previous = now - search.current.at < 700 ? search.current.text : '';
      const text = `${previous}${event.key}`.toLocaleLowerCase();
      search.current = { text, at: now };
      const query = [...text].every(char => char === text[0]) ? text[0]! : text;
      const start = open ? active : options.findIndex(option => option.value === value);
      const ordered = [...enabled.filter(index => index > start), ...enabled.filter(index => index <= start)];
      const match = ordered.find(index => options[index]!.label.toLocaleLowerCase().startsWith(query));
      if (!open) show();
      if (match !== undefined) setActive(match);
    }
  }

  return <>
    <button {...props} ref={trigger} id={id} type="button" role="combobox" value={value}
      className={`field select-control ${className}`} disabled={disabled}
      aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? popupId : undefined}
      aria-activedescendant={open && options[active] ? `${popupId}-${active}` : undefined}
      data-escape-scope={open || undefined} onKeyDown={key}
      onBlur={event => { onBlur?.(event); if (event.relatedTarget && !popup.current?.contains(event.relatedTarget)) close(); }}
      onClick={() => { if (open) close(); else show(); }}>
      <span className="select-value">{selected?.label ?? (value ? `已保存：${value}` : placeholder)}</span>
      {selected?.suffix}
      <IconChevronDown size={15} className="select-chevron" />
    </button>
    {open && <div ref={popup} id={popupId} role="listbox" popover="manual" className="select-popup"
      aria-label={props['aria-label']} aria-labelledby={props['aria-labelledby'] ?? (!props['aria-label'] ? id : undefined)}
      data-select-popup data-escape-scope="true">
      {options.map((option, index) => <div key={option.value} id={`${popupId}-${index}`} role="option"
        aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
        data-value={option.value} data-active={index === active || undefined} className="select-option"
        onMouseDown={event => event.preventDefault()}
        onPointerMove={() => { if (!option.disabled) setActive(index); }}
        onClick={event => { event.preventDefault(); choose(index); }}>
        <span className="min-w-0 flex-1 truncate">{option.label}</span>{option.suffix}<span className="select-check" aria-hidden="true">{option.value === value && <IconCheck size={15} />}</span>
      </div>)}
      {options.length === 0 && <div className="select-empty">暂无可选项</div>}
    </div>}
  </>;
}
