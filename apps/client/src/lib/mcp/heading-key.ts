import { stripNumericPrefix, cleanMarkdownHeading } from '@/engine/structurizer/prefix-cleaner';

/**
 * 概念名/标题归一化：去空白、折叠、小写、剥多级前导编号与 Markdown 标记。
 * 供概念抽取锚点匹配、仓内概念归并（concept-canonical）与跨仓对齐复用。
 * 作为单一基础原语下沉，解耦 concept-canonical ↔ concept-extractor 循环依赖。
 */
export function normalizeHeadingKey(text: string): string {
  if (!text) return '';
  let clean = cleanMarkdownHeading(text).toLowerCase();
  // 1. 剥离可能包在编号外的行内标记（如 **01_架构** -> 01_架构**）
  clean = clean.replace(/[*~`]/g, '');
  // 2. 优先剥离多级数字/章节前缀（如 01_, 01-, 1.1., 1.2.3., 1、, 1), （1）, 1: ）
  clean = stripNumericPrefix(clean);
  // 3. 清洗行内标记并将连字符/下划线转为空格（使 "event-loop"、"event_loop" 与 "event loop" 归纳对齐）
  clean = clean.replace(/[*~`]/g, '').replace(/[-_]/g, ' ');
  // 4. 折叠连续空白并去除首尾空白（不盲目剥除前导点，保护 .NET / .env 等专有名词）
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean;
}
