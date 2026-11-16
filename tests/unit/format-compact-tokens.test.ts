import { describe, it, expect } from 'vitest';
import { formatCompactTokens } from '@/lib/format';

describe('formatCompactTokens', () => {
  it('handles zero, negative, and invalid inputs gracefully', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(-100)).toBe('0');
    expect(formatCompactTokens(null)).toBe('0');
    expect(formatCompactTokens(undefined)).toBe('0');
    expect(formatCompactTokens(NaN)).toBe('0');
  });

  it('formats values under 1000 with < 1k (at most 1 digit)', () => {
    expect(formatCompactTokens(1)).toBe('< 1k');
    expect(formatCompactTokens(500)).toBe('< 1k');
    expect(formatCompactTokens(999)).toBe('< 1k');
  });

  it('formats 1k to 99k with at most 2 digits', () => {
    expect(formatCompactTokens(1000)).toBe('1k');
    expect(formatCompactTokens(2300)).toBe('2k');
    expect(formatCompactTokens(10400)).toBe('10k');
    expect(formatCompactTokens(20100)).toBe('20k');
    expect(formatCompactTokens(98700)).toBe('99k');
    expect(formatCompactTokens(99499)).toBe('99k');
  });

  it('formats 100k to 999k with at most 2 digits in M unit (0.1M ~ 0.9M)', () => {
    expect(formatCompactTokens(100000)).toBe('0.1M');
    expect(formatCompactTokens(150000)).toBe('0.2M');
    expect(formatCompactTokens(500000)).toBe('0.5M');
    expect(formatCompactTokens(850000)).toBe('0.9M');
    expect(formatCompactTokens(900000)).toBe('0.9M');
    expect(formatCompactTokens(994000)).toBe('1M');
  });

  it('formats millions with at most 2 digits (1M ~ 99M)', () => {
    expect(formatCompactTokens(1000000)).toBe('1M');
    expect(formatCompactTokens(2000000)).toBe('2M');
    expect(formatCompactTokens(2400000)).toBe('2M');
    expect(formatCompactTokens(20000000)).toBe('20M');
    expect(formatCompactTokens(99000000)).toBe('99M');
  });

  it('verifies that no output exceeds 2 numerical digits', () => {
    const testCases = [
      0, 10, 800, 1000, 2400, 15000, 20000, 85000, 99000, 100000,
      150000, 300000, 500000, 800000, 1000000, 2000000, 15000000, 20000000
    ];

    for (const val of testCases) {
      const formatted = formatCompactTokens(val);
      const digitsOnly = formatted.replace(/[^0-9]/g, '');
      expect(digitsOnly.length).toBeLessThanOrEqual(2);
    }
  });
});
