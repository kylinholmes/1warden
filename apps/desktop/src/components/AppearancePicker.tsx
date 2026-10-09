import { useLocalStore, useStoreField, useStoreSnapshot } from '@1warden/state/react';
import { useLayoutEffect, useId, useRef, type CSSProperties } from 'react';
import { IconCheck, IconChevronDown, Segmented } from '@1warden/ui';
import { getResolvedTheme, getThemeMode, getThemePalette, getIconStyle, setThemeMode, setThemePalette, setIconStyle, subscribeTheme, type ThemeMode, type IconStyle } from '../theme';
import { getPalette, PALETTES, type ThemePalette } from '../theme-palettes';

const MODES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' },
];

export function AppearancePicker({ onChange }: { onChange?: () => void } = {}) {
  const mode = useStoreSnapshot(subscribeTheme, getThemeMode);
  const palette = useStoreSnapshot(subscribeTheme, getThemePalette);
  const resolved = useStoreSnapshot(subscribeTheme, getResolvedTheme);
  const iconStyle = useStoreSnapshot(subscribeTheme, getIconStyle);
  const viewStore = useLocalStore(() => {
    const open = false;
    return { open };
  });
  const [open, setOpen] = useStoreField(viewStore, 'open');
  const trigger = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = getPalette(palette);
  const colors = selected[resolved];
  function focusOption(option: HTMLElement | undefined | null) {
    if (!option) return;
    option.focus({ preventScroll: true });
    const list = option.parentElement!;
    const top = option.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + option.offsetHeight - list.clientHeight;
  }
  useLayoutEffect(() => {
    if (!open) return;
    const list = document.getElementById(id)!;
    const control = container.current!;
    const position = () => {
      const boundary = control.closest('[role="tabpanel"], [role="region"]')?.getBoundingClientRect();
      const anchor = control.getBoundingClientRect();
      const below = (boundary?.bottom ?? innerHeight) - anchor.bottom - 8;
      const above = anchor.top - (boundary?.top ?? 0) - 8;
      const up = below < 160 && above > below;
      list.style.top = up ? 'auto' : '100%'; list.style.bottom = up ? '100%' : 'auto';
      list.style.maxHeight = `${Math.min(224, Math.max(80, up ? above : below))}px`;
    };
    position(); focusOption(document.getElementById(`${id}-${palette}`));
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', position);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', position); };
  }, [open, id, palette]);
  function choose(value: ThemePalette) { setThemePalette(value); onChange?.(); setOpen(false); trigger.current?.focus(); }
  return <section className="appearance-picker">
    <h3 className="text-md font-medium">视觉风格</h3>
    <p className="mt-0.5 text-xs text-[var(--ink-tertiary)]">明暗与配色独立选择，立即在本机预览</p>
    <div className="card mt-3 appearance-mode-row">
      <span className="text-md">模式</span>
      <div className="appearance-modes" role="group" aria-label="明暗模式">
        {MODES.map(option => <button key={option.value} type="button" className="appearance-mode"
          aria-pressed={mode === option.value} onClick={() => { setThemeMode(option.value); onChange?.(); }}>
          <span className={`appearance-mode-preview mode-${option.value}`} aria-hidden="true"><i /><i /><i /></span>
          <span>{option.label}</span>
        </button>)}
      </div>
    </div>
    <div className="card mt-3 appearance-palette-card">
      <div ref={container} className="appearance-palette-control" data-escape-scope={open || undefined} onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }} onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
        }
      }}>
        <span id={`${id}-label`} className="text-md">配色方案</span>
        <button ref={trigger} type="button" className="palette-trigger" aria-label={`配色方案：${selected.name}`}
          aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
          onClick={() => setOpen(!open)} onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
          }}>
          <span className="palette-letter" style={{ color: colors[5], background: colors[3] }}>Aa</span>
          <span className="min-w-0 flex-1 truncate">{selected.name}</span><IconChevronDown size={15} />
        </button>
        {open && <div id={id} role="listbox" aria-labelledby={`${id}-label`} className="palette-options"
          onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
            const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length;
            focusOption(nodes[next]);
          }}>
          <div className="palette-options-label" role="presentation">内置配色</div>
          {PALETTES.map(item => <button key={item.id} id={`${id}-${item.id}`} role="option" type="button"
            aria-selected={palette === item.id} tabIndex={palette === item.id ? 0 : -1} onClick={() => choose(item.id)}>
            <span className="palette-letter" style={{ background: item[resolved][3], color: item[resolved][5] }}>Aa</span>
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            {palette === item.id && <IconCheck size={16} />}
          </button>)}
        </div>}
      </div>
      <div className="appearance-swatches" aria-label="当前方案颜色">
        {[["强调色", colors[5]], ["背景", colors[3]], ["前景", colors[4]]].map(([label, color]) =>
          <div key={label}><span>{label}</span><span className="palette-color"><i style={{ '--swatch': color } as CSSProperties} />{color!.toUpperCase()}</span></div>)}
      </div>
    </div>
    <div className="card mt-3 flex flex-wrap items-center gap-3 p-4">
      <div className="min-w-[120px] flex-1">
        <p className="text-md">图标样式</p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--ink-tertiary)]">原貌保留素材自带背景；统一底板添加圆角背景。深色单色矢量随主题显示，彩色原图保持原色。</p>
      </div>
      <Segmented<IconStyle> label="图标样式" value={iconStyle} onChange={value => { setIconStyle(value); onChange?.(); }}
        options={[{ value: 'original', label: '原貌' }, { value: 'plate', label: '统一底板' }]} />
    </div>
  </section>;
}
