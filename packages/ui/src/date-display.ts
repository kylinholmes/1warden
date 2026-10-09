/** Presentation only. Never feed these strings back into the encrypted model. */
export function formatCardExpiry(month: string | null | undefined, year: string | null | undefined): string {
  const validMonth = Boolean(month && /^(?:0?[1-9]|1[0-2])$/.test(month));
  const mm = validMonth ? month!.padStart(2, '0') : month || '—';
  // Do not silently discard the century of legacy values outside the normal range.
  const yy = validMonth && year && /^20\d{2}$/.test(year) ? year.slice(2) : year || '—';
  return `${mm}/${yy}`;
}

export function formatRecordDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replaceAll('-', '/') : value;
}
