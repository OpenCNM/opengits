import * as m from '@/paraglide/messages';
import { getLocale } from '@/paraglide/runtime.js';

const COMPACT_UNITS = ['k', 'M', 'B', 'T'] as const;

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs < 1000) return String(value);

  let unitIndex = 0;
  while (unitIndex < COMPACT_UNITS.length - 1 && abs / 1000 ** (unitIndex + 2) >= 0.99995) {
    unitIndex++;
  }

  const scaled = value / 1000 ** (unitIndex + 1);
  const rounded = Math.round(scaled * 10) / 10;
  const sign = value < 0 ? '-' : '';
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${sign}${text}${COMPACT_UNITS[unitIndex]}`;
}

export function formatCompactTokens(tokens: number | null | undefined): string {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return '0';
  const abs = Math.abs(tokens);

  if (abs < 1000) {
    return '< 1k';
  }

  if (abs < 99_500) {
    const k = Math.round(abs / 1000);
    return `${k}k`;
  }

  if (abs < 995_000) {
    const val = Math.round(abs / 100_000) / 10;
    const m = val.toFixed(1);
    return m === '1.0' ? '1M' : `${m}M`;
  }

  if (abs < 99_500_000) {
    const m = Math.round(abs / 1_000_000);
    return `${m}M`;
  }

  if (abs < 995_000_000) {
    const val = Math.round(abs / 100_000_000) / 10;
    const b = val.toFixed(1);
    return b === '1.0' ? '1B' : `${b}B`;
  }

  const b = Math.round(abs / 1_000_000_000);
  return `${b}B`;
}

export function formatRelativeTime(input: Date | string | null | undefined): string {
  if (!input) return '';
  const date = input instanceof Date ? input : new Date(input);
  const time = date.getTime();
  if (Number.isNaN(time)) return '';

  const diffMs = Date.now() - time;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return m.time_just_now();
  if (diffHour < 1) return m.time_minutes_ago({ minutes: diffMin });
  if (diffHour < 24) return m.time_hours_ago({ hours: diffHour });
  if (diffDay === 1) return m.time_yesterday();
  if (diffDay <= 7) return m.time_days_ago({ days: diffDay });

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  if (year === new Date().getFullYear()) return `${month}.${day}`;
  return `${year}.${month}.${day}`;
}

export function formatProgressPercent(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  if (done >= total) return 100;
  if (done <= 0) return 0;
  const pct = Math.floor((done / total) * 100);
  return Math.min(99, Math.max(1, pct));
}

function resolveTargetLocale(locale?: 'en' | 'zh-CN'): 'en' | 'zh-CN' {
  if (locale) return locale;
  try {
    const l = getLocale();
    return l && l.startsWith('en') ? 'en' : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

export function formatEditionRelativeTime(
  input: Date | string | null | undefined,
  locale?: 'en' | 'zh-CN'
): string {
  if (!input) return '';
  const date = input instanceof Date ? input : new Date(input);
  const time = date.getTime();
  if (Number.isNaN(time)) return '';

  const diffMs = Date.now() - time;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffMonth = Math.floor(diffDay / 30);
  const opt = { locale: resolveTargetLocale(locale) };

  if (diffMin < 1) return m.time_just_now({}, opt);
  if (diffHour < 1) return m.time_minutes_ago({ minutes: diffMin }, opt);
  if (diffHour < 24) return m.time_hours_ago({ hours: diffHour }, opt);
  if (diffDay < 30) return m.time_days_ago({ days: Math.max(1, diffDay) }, opt);
  return m.time_months_ago({ months: Math.max(1, diffMonth) }, opt);
}

export function formatWordCount(
  count: number | null | undefined,
  locale?: 'en' | 'zh-CN'
): string {
  if (count === null || count === undefined || !Number.isFinite(count) || count < 0) return '';
  const targetLocale = resolveTargetLocale(locale);
  const opt = { locale: targetLocale };
  const isEn = targetLocale === 'en';

  if (isEn) {
    if (count < 1000) {
      return m.edition_meta_words_chars({ count: String(count) }, opt);
    }
    const scaled = Math.round((count / 1000) * 10) / 10;
    const text = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1);
    return m.edition_meta_words_thousands({ count: text }, opt);
  }

  if (count < 1000) {
    return m.edition_meta_words_chars({ count: String(count) }, opt);
  }
  if (count < 9950) {
    const scaled = Math.round((count / 1000) * 10) / 10;
    const text = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1);
    return m.edition_meta_words_thousands({ count: text }, opt);
  }
  const scaled = Math.round((count / 10000) * 10) / 10;
  const text = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1);
  return m.edition_meta_words_wan({ count: text }, opt);
}

export function formatChapterCount(
  count: number | null | undefined,
  locale?: 'en' | 'zh-CN'
): string {
  if (count === null || count === undefined || !Number.isFinite(count) || count < 0) return '';
  const opt = { locale: resolveTargetLocale(locale) };
  return m.edition_meta_chapters({ count: String(count) }, opt);
}

