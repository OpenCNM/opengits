import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { formatRelativeTime, formatCompactNumber } from '@/lib/format';

// paraglide 消息替换为可断言的固定文案，隔离 locale 与编译产物
vi.mock('@/paraglide/messages', () => ({
  time_just_now: () => 'just now',
  time_minutes_ago: ({ minutes }: { minutes: number }) => `${minutes}m ago`,
  time_hours_ago: ({ hours }: { hours: number }) => `${hours}h ago`,
  time_yesterday: () => 'yesterday',
  time_days_ago: ({ days }: { days: number }) => `${days}d ago`,
}));

/** 固定"当前时间"，消除测试对真实时钟的依赖 */
const NOW = new Date('2026-08-30T12:00:00Z').getTime();

function minutesAgo(min: number): Date {
  return new Date(NOW - min * 60_000);
}

describe('formatRelativeTime（相对时间统一分档）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('空值与非法日期返回空串', () => {
    expect(formatRelativeTime(null)).toBe('');
    expect(formatRelativeTime(undefined)).toBe('');
    expect(formatRelativeTime('not-a-date')).toBe('');
    expect(formatRelativeTime(new Date('invalid'))).toBe('');
  });

  it('未来时间（时钟偏差）按"刚刚"处理', () => {
    expect(formatRelativeTime(new Date(NOW + 5 * 60_000))).toBe('just now');
  });

  it('分钟档：<60 分钟返回 N 分钟前', () => {
    expect(formatRelativeTime(minutesAgo(0))).toBe('just now');
    expect(formatRelativeTime(minutesAgo(1))).toBe('1m ago');
    expect(formatRelativeTime(minutesAgo(59))).toBe('59m ago');
  });

  it('小时档：<24 小时返回 N 小时前', () => {
    expect(formatRelativeTime(minutesAgo(60))).toBe('1h ago');
    expect(formatRelativeTime(minutesAgo(23 * 60))).toBe('23h ago');
  });

  it('昨天档：恰好 1 天返回 yesterday', () => {
    expect(formatRelativeTime(minutesAgo(24 * 60))).toBe('yesterday');
  });

  it('一周内：2-7 天返回 N 天前', () => {
    expect(formatRelativeTime(minutesAgo(2 * 24 * 60))).toBe('2d ago');
    expect(formatRelativeTime(minutesAgo(7 * 24 * 60))).toBe('7d ago');
  });

  it('超过一周：当年返回 MM.DD，跨年返回 YYYY.MM.DD（手工拼接，规避 ICU 水合差异）', () => {
    expect(formatRelativeTime(new Date('2026-01-15T00:00:00Z'))).toMatch(/^\d{2}\.\d{2}$/);
    expect(formatRelativeTime(new Date('2024-05-03T00:00:00Z'))).toBe('2024.05.03');
  });
});

describe('formatCompactNumber（紧凑计数）', () => {
  it('基础分档与非法输入', () => {
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(1499)).toBe('1.5k');
    expect(formatCompactNumber(Number.NaN)).toBe('0');
  });
});
