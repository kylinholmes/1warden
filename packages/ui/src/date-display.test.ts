import { describe, expect, it } from 'vitest';
import { formatCardExpiry, formatRecordDate } from './date-display';

describe('date display formatting does not rewrite stored fields', () => {
  it('uses MM/YY for complete modern card expiries', () => {
    expect(formatCardExpiry('10', '2030')).toBe('10/30');
    expect(formatCardExpiry('2', '2030')).toBe('02/30');
  });
  it('preserves incomplete and legacy card values without inventing a century', () => {
    expect(formatCardExpiry(null, '2030')).toBe('—/2030');
    expect(formatCardExpiry('12', null)).toBe('12/—');
    expect(formatCardExpiry('12', '1999')).toBe('12/1999');
    expect(formatCardExpiry('legacy-month', 'legacy-year')).toBe('legacy-month/legacy-year');
  });
  it('uses fixed slashes for complete ISO dates and retains other source formats', () => {
    expect(formatRecordDate('2030-10-09')).toBe('2030/10/09');
    expect(formatRecordDate('12/2030')).toBe('12/2030');
    expect(formatRecordDate('')).toBe('');
  });
});
