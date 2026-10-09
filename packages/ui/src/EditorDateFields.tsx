import { useId, useRef, type ClipboardEvent, type MouseEvent, type PointerEvent } from 'react';

const GROUP_CLASS = 'field segmented-date-field flex min-w-0 items-center gap-1.5 focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent-tint)]';
const SEGMENT_CLASS = 'date-segment min-w-0 border-0 bg-transparent p-0 font-mono text-center tabular-nums placeholder:text-[var(--ink-tertiary)]';
const HINT_CLASS = 'mt-1 text-xs text-[var(--ink-tertiary)]';

/** Year-first dates are unambiguous; never guess between MM/DD and DD/MM. */
function completeDate(value: string | null | undefined): [string, string, string] | null {
  const match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/.exec(value?.trim() ?? '');
  return match ? [match[1]!, match[3]!, match[4]!] : null;
}

function completeExpiry(value: string | null | undefined): [string, string] | null {
  const match = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(value?.trim() ?? '');
  return match ? [match[1]!, match[2]!.length === 2 ? `20${match[2]}` : match[2]!] : null;
}

/** The whole frame is an input hit area; padding clicks must not blur/normalize an active slot. */
function focusSegment(event: MouseEvent<HTMLDivElement> | PointerEvent<HTMLDivElement>) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('input')) return;
  event.preventDefault();
  const slots = [...event.currentTarget.querySelectorAll<HTMLInputElement>('input')];
  const active = slots.find(slot => slot === event.currentTarget.ownerDocument.activeElement);
  if (active) return;
  const next = slots.find(slot => slot.value === '') ?? slots.at(-1);
  next?.focus();
  next?.select();
}

function validDate(year: string, month: string, day: string): boolean {
  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day)) return false;
  const y = Number(year), m = Number(month), d = Number(day);
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1]!;
}

export interface EditorDateFieldProps {
  value: string;
  label: string;
  onChange: (value: string) => void;
}

/** One frame, three editable slots; draft strings also retain incomplete dates. */
export function EditorDateField({ value, label, onChange }: EditorDateFieldProps) {
  const hintId = useId();
  // Only a value actually edited here may be padded on blur. Reading an older
  // unpadded date, or merely focusing it, must never alter the saved string.
  const lastTyped = useRef<string | null>(null);
  // Once the raw fallback is edited, retain that textbox for this session.
  // Clearing or completing a legacy date must not unmount the focused input.
  // The controlled value update supplies the render; this is not draft state.
  const rawEditing = useRef(false);
  const match = /^(\d{0,4})-(\d{0,2})-(\d{0,2})$/.exec(value);
  const parts = value === '' ? ['', '', ''] : match ? [match[1]!, match[2]!, match[3]!] : null;
  if (rawEditing.current || !parts) return <div className="min-w-0">
    <input type="text" className="field min-w-0" value={value} aria-label={label}
      aria-describedby={hintId} autoComplete="off" spellCheck={false}
      onChange={event => { rawEditing.current = true; lastTyped.current = null; onChange(event.target.value); }} />
    <p id={hintId} className={HINT_CLASS}>已保留原日期；可直接编辑，完整日期使用 YYYY-MM-DD。</p>
  </div>;

  const [year, month, day] = parts as [string, string, string];
  const invalid = year.length === 4 && month !== '' && day !== '' && !validDate(year, month, day);
  function assignDate(updated: readonly string[]) {
    const serialized = updated.every(part => part === '') ? '' : updated.join('-');
    lastTyped.current = serialized;
    onChange(serialized);
  }
  function pasteDate(event: ClipboardEvent<HTMLInputElement>) {
    const date = completeDate(event.clipboardData.getData('text'));
    if (!date) return;
    event.preventDefault();
    assignDate(date);
  }
  function change(index: number, next: string, inserted: string | null | undefined) {
    // Native multi-character insertText can append to a populated slot. Its
    // complete date owns the whole group, just like an explicit paste does.
    const date = completeDate(inserted) ?? completeDate(next);
    if (date) { assignDate(date); return; }
    if (!/^\d*$/.test(next) || next.length > (index === 0 ? 4 : 2)) return;
    const updated = [...parts!];
    updated[index] = next;
    assignDate(updated);
  }
  return <div className="min-w-0">
    <div role="group" aria-label={label} className={GROUP_CLASS}
      onPointerDown={focusSegment} onClick={focusSegment}
      onBlur={event => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        const edited = lastTyped.current === value;
        lastTyped.current = null;
        if (!edited || !validDate(year, month, day)) return;
        const canonical = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        if (canonical !== value) onChange(canonical);
      }}>
      {parts.map((part, index) => <span key={index} className="flex shrink-0 items-center gap-1.5">
        {index > 0 && <span aria-hidden="true" className="text-[var(--ink-tertiary)]">/</span>}
        <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false}
          className={`${SEGMENT_CLASS} ${index === 0 ? 'w-[4.5ch]' : 'w-[2.5ch]'}`}
          placeholder={['YYYY', 'MM', 'DD'][index]}
          aria-label={`${label}${['年份', '月份', '日期'][index]}`}
          aria-describedby={invalid ? hintId : undefined} aria-invalid={invalid || undefined}
          value={part} onPaste={pasteDate}
          onChange={event => change(index, event.target.value, (event.nativeEvent as InputEvent).data)} />
      </span>)}
    </div>
    {invalid && <p id={hintId} className={HINT_CLASS}>日期无效，当前输入已保留，请检查年月日。</p>}
  </div>;
}

export interface EditorCardExpiryProps {
  month: string;
  year: string;
  onChange: (month: string, year: string) => void;
}

function validMonth(value: string): boolean {
  return /^(?:0?[1-9]|1[0-2])$/.test(value);
}

/** MM / YY is display-only; the stored year changes century only on a YY edit. */
export function EditorCardExpiry({ month, year, onChange }: EditorCardExpiryProps) {
  const hintId = useId();
  const lastTypedMonth = useRef<string | null>(null);
  const legacyMonth = !/^\d{0,2}$/.test(month);
  const shortYear = /^20\d{2}$/.test(year);
  const legacyYear = !shortYear && !/^\d{0,2}$/.test(year);
  const invalidMonth = month !== '' && !validMonth(month);
  const hasHint = legacyMonth || legacyYear || invalidMonth;
  function assignExpiry(expiry: [string, string]) {
    lastTypedMonth.current = expiry[0];
    onChange(...expiry);
  }
  function pasteExpiry(event: ClipboardEvent<HTMLInputElement>) {
    const expiry = completeExpiry(event.clipboardData.getData('text'));
    if (!expiry) return;
    event.preventDefault();
    assignExpiry(expiry);
  }
  function changeExpiry(next: string, inserted: string | null | undefined): boolean {
    const expiry = completeExpiry(inserted) ?? completeExpiry(next);
    if (!expiry) return false;
    assignExpiry(expiry);
    return true;
  }
  return <div className="min-w-0">
    <div role="group" aria-label="有效期" className={GROUP_CLASS}
      onPointerDown={focusSegment} onClick={focusSegment}
      onBlur={event => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        const edited = lastTypedMonth.current === month;
        lastTypedMonth.current = null;
        if (edited && validMonth(month)) {
          const padded = month.padStart(2, '0');
          if (padded !== month) onChange(padded, year);
        }
      }}>
      <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false}
        className={`${SEGMENT_CLASS} ${legacyMonth ? 'w-[7ch]' : 'w-[2.5ch]'}`}
        placeholder="MM"
        aria-label="有效期月份" aria-describedby={hasHint ? hintId : undefined}
        aria-invalid={invalidMonth || undefined} value={month}
        onPaste={pasteExpiry} onChange={event => {
          const next = event.target.value;
          if (changeExpiry(next, (event.nativeEvent as InputEvent).data)) return;
          if (!legacyMonth && (!/^\d*$/.test(next) || next.length > 2)) return;
          lastTypedMonth.current = next;
          onChange(next, year);
        }} />
      <span aria-hidden="true" className="text-[var(--ink-tertiary)]">/</span>
      <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false}
        className={`${SEGMENT_CLASS} ${legacyYear ? 'w-[7ch]' : 'w-[2.5ch]'}`}
        placeholder={legacyYear ? '年份' : 'YY'}
        aria-label="有效期年份" aria-describedby={hasHint ? hintId : undefined}
        value={shortYear ? year.slice(2) : year}
        onPaste={pasteExpiry} onChange={event => {
          const next = event.target.value;
          if (changeExpiry(next, (event.nativeEvent as InputEvent).data)) return;
          if (legacyYear) { onChange(month, next); return; }
          if (!/^\d*$/.test(next) || next.length > 2) return;
          onChange(month, next.length === 2 ? `20${next}` : next);
        }} />
    </div>
    {hasHint && <p id={hintId} className={HINT_CLASS}>
      {legacyMonth || legacyYear ? '已保留原有效期，异常或非 20xx 年份按原文编辑；两位年份按 20YY 保存。'
        : '月份应为 01–12；当前输入已保留。'}
    </p>}
  </div>;
}
