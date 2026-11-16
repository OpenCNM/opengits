/**
 * Section address format: "<docPath>#<headingPath>"
 * Centralized here so search locators, list_documents and read_section
 * stay in sync. Address is the single source of truth for section lookups.
 */

export const SECTION_ADDRESS_SEPARATOR = '#';

export function buildSectionAddress(docPath: string, headingPath?: string | null): string {
  const key = (headingPath || '').trim();
  return `${docPath}${SECTION_ADDRESS_SEPARATOR}${key}`;
}

export function parseSectionAddress(address: string): { docPath: string; headingPath: string } {
  const value = String(address || '').trim();
  const idx = value.indexOf(SECTION_ADDRESS_SEPARATOR);
  if (idx < 0) {
    return { docPath: value, headingPath: '' };
  }
  return {
    docPath: value.slice(0, idx).trim(),
    headingPath: value.slice(idx + 1).trim(),
  };
}

/**
 * 归一化 headingPath 后构建干净的 Section Address。
 * markdown 管道的落库 headingPath 自带 docPath 前缀（如 "docs/foo.md#上下文设计"，
 * 由 Go chunks_store.go 落库链兜底合成；原 chunker.ts 实现已摘除），直接 buildSectionAddress 会产生
 * "path#path#heading" 双路径。这里剥离 `${docPath}#` 前缀：
 * - markdown chunk → "docs/foo.md#上下文设计"（read_section 精确匹配 chunk.heading 命中）
 * - 代码课程 chunk（headingPath 无前缀，如 "cluster > overview"）→ 原样拼接
 * 只供新代码使用；既有 search/locator 输出的存量格式保持兼容不动。
 */
export function buildCleanSectionAddress(docPath: string, headingPath?: string | null): string {
  const key = (headingPath || '').trim();
  if (!key) return buildSectionAddress(docPath, key);
  const prefix = `${docPath}${SECTION_ADDRESS_SEPARATOR}`;
  const cleaned = key.startsWith(prefix) ? key.slice(prefix.length).trim() : key;
  return buildSectionAddress(docPath, cleaned);
}
