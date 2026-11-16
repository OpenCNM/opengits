// 章节标题轻量解构（学习进度侧栏的徽章号 + 干净标题展示）。
//
// 旧版只认「第N章 / Chapter N / NN.」三种前缀，转录产物一旦是
// "Lesson 3: Loops" / "Part 2 — Advanced" / "第 3 课 函数" / "1、基础" 即退化展示。
// 本工具是纯内容格式解析（自有转录产物的标题约定），集中于此供 UI 复用；
// 仓库文件路径的章节识别请勿使用本工具（那是 chapter-map 的职责）。

export interface ParsedChapterTitle {
  /** 等宽补零的章节徽章号；无法解析时为 null */
  index: string | null;
  cleanTitle: string;
}

// 中文序数后缀：章/节/课/讲 单字，或 单元/模块/部分 双字
const ZH_CHAPTER_PREFIX = /^第\s*(\d{1,3})\s*(?:单元|模块|部分|[章节课讲])?\s*[-—–:：.、·\s]+\s*(.+)$/;
// 英文章节词前缀（Lesson/Part/Unit/Module/Section 与 Chapter/Ch 同权）
const EN_CHAPTER_PREFIX = /^(?:chapter|ch|lesson|part|unit|module|section)\.?\s*(\d{1,3})\s*[-—–:：.、·\s]+\s*(.+)$/i;
// 裸数字编号前缀（"01 - 快速上手" / "1. 标题" / "3、基础"）。
// 顿号后按中文习惯不跟空格；西文分隔符必须跟空白，防误伤 "1.5 章标题" 这类小数开头
const NUMERIC_PREFIX = /^(\d{1,3})\s*(?:、|[-—–:：.·]\s+)\s*(.+)$/;

function toBadge(num: string): string {
  const n = parseInt(num, 10);
  return Number.isNaN(n) ? num : String(n).padStart(2, '0');
}

/**
 * "第 0 章 — 引言：设计哲学"    -> { index: "00", cleanTitle: "引言：设计哲学" }
 * "第 3 课 函数与闭包"          -> { index: "03", cleanTitle: "函数与闭包" }
 * "Chapter 1: Getting Started"  -> { index: "01", cleanTitle: "Getting Started" }
 * "Lesson 3 - Loops"            -> { index: "03", cleanTitle: "Loops" }
 * "Part 2 — Advanced"           -> { index: "02", cleanTitle: "Advanced" }
 * "01 - 快速上手"               -> { index: "01", cleanTitle: "快速上手" }
 * "1、基础"                     -> { index: "01", cleanTitle: "基础" }
 * "全景架构总览"                -> { index: null, cleanTitle: "全景架构总览" }
 */
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
