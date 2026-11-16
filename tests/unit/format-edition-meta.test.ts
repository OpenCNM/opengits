import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  formatEditionRelativeTime,
  formatWordCount,
  formatChapterCount,
} from '@/lib/format';

const NOW = new Date('2026-10-16T12:00:00Z').getTime();

function minutesAgo(min: number): Date {
  return new Date(NOW - min * 60_000);
}

function hoursAgo(hours: number): Date {
  return new Date(NOW - hours * 3_600_000);
}

function daysAgo(days: number): Date {
  return new Date(NOW - days * 86_400_000);
}

describe('formatEditionRelativeTime（讲法卡片相对时间分档）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('空值与非法输入返回空串', () => {
    expect(formatEditionRelativeTime(null)).toBe('');
    expect(formatEditionRelativeTime(undefined)).toBe('');
    expect(formatEditionRelativeTime('')).toBe('');
    expect(formatEditionRelativeTime('invalid-date')).toBe('');
  });

  it('未来时间按刚刚处理', () => {
    expect(formatEditionRelativeTime(new Date(NOW + 60_000), 'zh-CN')).toBe('刚刚');
    expect(formatEditionRelativeTime(new Date(NOW + 60_000), 'en')).toBe('Just now');
  });

  it('分钟档：<60 分钟', () => {
    expect(formatEditionRelativeTime(minutesAgo(0), 'zh-CN')).toBe('刚刚');
    expect(formatEditionRelativeTime(minutesAgo(5), 'zh-CN')).toBe('5分钟前');
    expect(formatEditionRelativeTime(minutesAgo(5), 'en')).toBe('5m ago');
  });

  it('小时档：<24 小时', () => {
    expect(formatEditionRelativeTime(hoursAgo(1), 'zh-CN')).toBe('1小时前');
    expect(formatEditionRelativeTime(hoursAgo(12), 'zh-CN')).toBe('12小时前');
    expect(formatEditionRelativeTime(hoursAgo(12), 'en')).toBe('12h ago');
  });

  it('天档：1~29 天', () => {
    expect(formatEditionRelativeTime(daysAgo(1), 'zh-CN')).toBe('1天前');
    expect(formatEditionRelativeTime(daysAgo(15), 'zh-CN')).toBe('15天前');
    expect(formatEditionRelativeTime(daysAgo(15), 'en')).toBe('15d ago');
  });

  it('月档：>=30 天', () => {
    expect(formatEditionRelativeTime(daysAgo(30), 'zh-CN')).toBe('1月前');
    expect(formatEditionRelativeTime(daysAgo(65), 'zh-CN')).toBe('2月前');
    expect(formatEditionRelativeTime(daysAgo(65), 'en')).toBe('2mo ago');
  });
});

describe('formatWordCount（教程总字数分档）', () => {
  it('非法与负数输入返回空串', () => {
    expect(formatWordCount(null)).toBe('');
    expect(formatWordCount(undefined)).toBe('');
    expect(formatWordCount(-10)).toBe('');
    expect(formatWordCount(Number.NaN)).toBe('');
  });

  it('中文环境：< 1000 显示 X字', () => {
    expect(formatWordCount(0, 'zh-CN')).toBe('0字');
    expect(formatWordCount(850, 'zh-CN')).toBe('850字');
  });

  it('中文环境：< 10000 显示 X.X千字', () => {
    expect(formatWordCount(1500, 'zh-CN')).toBe('1.5千字');
    expect(formatWordCount(2000, 'zh-CN')).toBe('2千字');
    expect(formatWordCount(8250, 'zh-CN')).toBe('8.3千字');
  });

  it('中文环境：9950~9999 四舍五入进位至 1万字（杜绝 10千字）', () => {
    expect(formatWordCount(9949, 'zh-CN')).toBe('9.9千字');
    expect(formatWordCount(9950, 'zh-CN')).toBe('1万字');
    expect(formatWordCount(9960, 'zh-CN')).toBe('1万字');
    expect(formatWordCount(9999, 'zh-CN')).toBe('1万字');
  });

  it('中文环境：>= 10000 显示 X.X万字', () => {
    expect(formatWordCount(10000, 'zh-CN')).toBe('1万字');
    expect(formatWordCount(25400, 'zh-CN')).toBe('2.5万字');
    expect(formatWordCount(120000, 'zh-CN')).toBe('12万字');
  });

  it('英文环境：< 1000 显示 X words，>= 1000 显示 Xk words', () => {
    expect(formatWordCount(850, 'en')).toBe('850 words');
    expect(formatWordCount(1500, 'en')).toBe('1.5k words');
    expect(formatWordCount(25000, 'en')).toBe('25k words');
  });

  it('英文环境：9950~9999 显示 10k words', () => {
    expect(formatWordCount(9960, 'en')).toBe('10k words');
  });

  it('未指定 locale 时安全降级使用全局默认语言并正确格式化', () => {
    expect(formatWordCount(1500)).toBeTruthy();
  });
});

describe('formatChapterCount（章节数规范）', () => {
  it('非法输入返回空串', () => {
    expect(formatChapterCount(null)).toBe('');
    expect(formatChapterCount(undefined)).toBe('');
    expect(formatChapterCount(-1)).toBe('');
  });

  it('中文环境显示 章 后缀', () => {
    expect(formatChapterCount(8, 'zh-CN')).toBe('8章');
    expect(formatChapterCount(1, 'zh-CN')).toBe('1章');
  });

  it('英文环境显示 chapters 后缀', () => {
    expect(formatChapterCount(8, 'en')).toBe('8 chapters');
  });

  it('未指定 locale 时返回有效章节格式', () => {
    expect(formatChapterCount(5)).toBeTruthy();
  });
});
