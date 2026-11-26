export interface ParsedChapterTitle {
  index: string | null;
  cleanTitle: string;
}

const ZH_CHAPTER_PREFIX = /^第\s*(\d{1,3})\s*(?:单元|模块|部分|[章节课讲])?\s*[-—–:：.、·\s]+\s*(.+)$/;
const EN_CHAPTER_PREFIX = /^(?:chapter|ch|lesson|part|unit|module|section)\.?\s*(\d{1,3})\s*[-—–:：.、·\s]+\s*(.+)$/i;
const NUMERIC_PREFIX = /^(\d{1,3})\s*(?:、|[-—–:：.·]\s+)\s*(.+)$/;

function toBadge(num: string): string {
  const n = parseInt(num, 10);
  return Number.isNaN(n) ? num : String(n).padStart(2, '0');
}

export function parseChapterTitle(rawTitle: string): ParsedChapterTitle {
  if (!rawTitle) return { index: null, cleanTitle: '' };

  const trimmed = rawTitle.trim();

  const zhMatch = trimmed.match(ZH_CHAPTER_PREFIX);
  if (zhMatch) {
    return { index: toBadge(zhMatch[1]), cleanTitle: zhMatch[2].trim() };
  }

  const enMatch = trimmed.match(EN_CHAPTER_PREFIX);
  if (enMatch) {
    return { index: toBadge(enMatch[1]), cleanTitle: enMatch[2].trim() };
  }

  const numMatch = trimmed.match(NUMERIC_PREFIX);
  if (numMatch) {
    return { index: toBadge(numMatch[1]), cleanTitle: numMatch[2].trim() };
  }

  return { index: null, cleanTitle: trimmed };
}
