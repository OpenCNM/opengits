/**
 * 共享格式化工具。
 * 不使用 Intl.NumberFormat / toLocaleDateString：其输出依赖运行环境的 ICU 与 locale，
 * SSR 与客户端可能产生不同字符（如 "1.2K" vs "1.2k"），存在水合不匹配风险；
 * 手写分档保证两端逐字符一致。
 */
import * as m from '@/paraglide/messages';
import { getLocale } from '@/paraglide/runtime.js';

/** 紧凑计数单位分档：k（千）/ M（百万）/ B（十亿）/ T（万亿） */
const COMPACT_UNITS = ['k', 'M', 'B', 'T'] as const;

/**
 * 将计数格式化为紧凑字符串：999 → "999"，1499 → "1.5k"，999950 → "1M"，23456789 → "23.5M"。
 * 一位小数并去掉尾零（1000 → "1k"，1200 → "1.2k"）；非法输入（NaN/Infinity）返回 "0"。
 */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs < 1000) return String(value);

  // 逐档上探：当前档缩放后若会四舍五入进位到 "1000k" 这类显示，则升入上一档
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

/**
 * 将 Token 消耗格式化为紧凑字符串（全站规范：最多显示 2 位数字，如 2k、20k、2M）：
 * - <= 0 或非有效数字 → "0"
 * - < 1,000 → "< 1k" (1 位数字)
 * - 1,000 ~ 99,499 → "[1-99]k" (1~2 位整数，如 2k, 20k)
 * - 99,500 ~ 999,499 → "[0.1-0.9]M" (严格保持 2 位数字，如 0.2M)
 * - 1,000,000 ~ 99,499,999 → "[1-99]M" (1~2 位整数，如 2M, 20M)
 * - >= 100,000,000 → 升入 B 档
 */
export function formatCompactTokens(tokens: number | null | undefined): string {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return '0';
  const abs = Math.abs(tokens);

  if (abs < 1000) {
    return '< 1k';
  }

  // 1k ~ 99k: 1~2 位整数 (1,000 ~ 99,499)
  if (abs < 99_500) {
    const k = Math.round(abs / 1000);
    return `${k}k`;
  }

  // 100k ~ 999k: 严格 2 位数字 (0.1M ~ 0.9M, 避免出现 100k 这类 3 位数)
  if (abs < 995_000) {
    const val = Math.round(abs / 100_000) / 10;
    const m = val.toFixed(1);
    return m === '1.0' ? '1M' : `${m}M`;
  }

  // 1M ~ 99M: 1~2 位整数 (1,000,000 ~ 99,499,999)
  if (abs < 99_500_000) {
    const m = Math.round(abs / 1_000_000);
    return `${m}M`;
  }

  // >= 100M: 升入 B 档 (100M ~ 994M 显示 0.1B ~ 0.9B，>= 1B 显示整数)
  if (abs < 995_000_000) {
    const val = Math.round(abs / 100_000_000) / 10;
    const b = val.toFixed(1);
    return b === '1.0' ? '1B' : `${b}B`;
  }

  const b = Math.round(abs / 1_000_000_000);
  return `${b}B`;
}

/**
 * 相对时间的全站唯一实现（分档）：
 * <1 分钟 → 刚刚；<60 分钟 → N 分钟前；<24 小时 → N 小时前；1 天 → 昨天；
 * ≤7 天 → N 天前；其余 → MM.DD（当年）或 YYYY.MM.DD（跨年，手工拼接规避 ICU 水合差异）。
 * 未来时间（时钟偏差）按"刚刚"处理；非法输入返回 ''。
 */
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

/**
 * 进度百分比格式化（严格单调防虚假 100%）：
 * - total <= 0 时返回 0
 * - 未全部完成（done < total）时，哪怕只差 1 节（如 458/460 = 99.56%），严格向下封顶至 99%，绝不虚假显示 100%！
 * - 只有真正 done >= total 时才返回 100
 * - 有进度但很小（done > 0）时，至少返回 1%，避免用户误以为未开始
 */
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

/**
 * 讲法卡片相对时间（分档）：
 * <1 分钟 → 刚刚；<60 分钟 → N 分钟前；<24 小时 → N 小时前；<30 天 → N 天前；其余 → N 月前。
 * 英文环境下自动切换为对应英语单位。
 */
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

/**
 * 教程总字数格式化：
 * 中文：< 1000 → X字；< 10000 → X.X千字；>= 10000 → X.X万字（9950~9999 进位至 1万字，杜绝 10千字）。
 * 英文：< 1000 → X words；>= 1000 → Xk words。
 */
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

  // 中文分档：< 1000 → X字；< 9950（四舍五入未达 10千）→ X.X千字；>= 9950 → X.X万字
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

/**
 * 章节数格式化：
 * 中文：8章；英文：8 chapters。
 */
export function formatChapterCount(
  count: number | null | undefined,
  locale?: 'en' | 'zh-CN'
): string {
  if (count === null || count === undefined || !Number.isFinite(count) || count < 0) return '';
  const opt = { locale: resolveTargetLocale(locale) };
  return m.edition_meta_chapters({ count: String(count) }, opt);
}

