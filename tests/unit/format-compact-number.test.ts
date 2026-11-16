import { describe, it, expect } from 'vitest';
import { formatCompactNumber, formatProgressPercent } from '@/lib/format';

describe('formatCompactNumber（k/M/B/T 紧凑分档）', () => {
  it('千位以下原样输出', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(1)).toBe('1');
    expect(formatCompactNumber(999)).toBe('999');
  });

  it('千档 k：一位小数并去尾零', () => {
    expect(formatCompactNumber(1000)).toBe('1k');
    expect(formatCompactNumber(1200)).toBe('1.2k');
    expect(formatCompactNumber(1499)).toBe('1.5k');
    expect(formatCompactNumber(23456)).toBe('23.5k');
    expect(formatCompactNumber(999400)).toBe('999.4k');
  });

  it('百万档 M', () => {
    expect(formatCompactNumber(1_000_000)).toBe('1M');
    expect(formatCompactNumber(1_234_567)).toBe('1.2M');
    expect(formatCompactNumber(23_456_789)).toBe('23.5M');
    expect(formatCompactNumber(999_400_000)).toBe('999.4M');
  });

  it('十亿档 B 与万亿档 T', () => {
    expect(formatCompactNumber(1_500_000_000)).toBe('1.5B');
    expect(formatCompactNumber(1_234_567_890_123)).toBe('1.2T');
    expect(formatCompactNumber(2_000_000_000_000)).toBe('2T');
  });

  it('进位边界：缩放后四舍五入到 1000 时升入上一档', () => {
    // 999950 缩放为 999.95k，四舍五入会显示 "1000k"，应升档为 "1M"
    expect(formatCompactNumber(999_950)).toBe('1M');
    expect(formatCompactNumber(999_949)).toBe('999.9k');
    expect(formatCompactNumber(999_950_000)).toBe('1B');
    expect(formatCompactNumber(999_949_999)).toBe('999.9M');
  });

  it('非法输入返回 "0"', () => {
    expect(formatCompactNumber(Number.NaN)).toBe('0');
    expect(formatCompactNumber(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('formatProgressPercent（严格单调防虚假 100% 门禁）', () => {
  it('未完工（done < total）时，哪怕只差 1 节也绝不四舍五入为 100%', () => {
    // 458/460 = 99.565%，严禁四舍五入为 100%，必须封顶为 99%
    expect(formatProgressPercent(458, 460)).toBe(99);
    expect(formatProgressPercent(459, 460)).toBe(99);
    expect(formatProgressPercent(999, 1000)).toBe(99);
    expect(formatProgressPercent(99, 100)).toBe(99);
  });

  it('真正完工（done >= total）时返回 100%', () => {
    expect(formatProgressPercent(460, 460)).toBe(100);
    expect(formatProgressPercent(461, 460)).toBe(100);
    expect(formatProgressPercent(10, 10)).toBe(100);
  });

  it('起步阶段（done > 0）至少显示 1%', () => {
    expect(formatProgressPercent(1, 1000)).toBe(1);
    expect(formatProgressPercent(1, 460)).toBe(1);
  });

  it('0 进度与异常入参防御', () => {
    expect(formatProgressPercent(0, 460)).toBe(0);
    expect(formatProgressPercent(0, 0)).toBe(0);
    expect(formatProgressPercent(-5, 10)).toBe(0);
    expect(formatProgressPercent(NaN, 10)).toBe(0);
  });
});
