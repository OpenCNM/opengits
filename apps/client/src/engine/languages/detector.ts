/**
 * src/engine/languages/detector.ts
 *
 * File extension detection and language mapping utilities with O(1) indexed lookup.
 */

import { LanguageEntry, LANGUAGE_MAP } from './definitions';

/** Known documentation and plain text file extensions（仅 isDocFile 内部消费） */
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc', '.tex']);

/** O(1) extension to LanguageEntry fast-lookup index */
const EXTENSION_TO_LANGUAGE = new Map<string, LanguageEntry>();
for (const entry of Object.values(LANGUAGE_MAP)) {
  for (const ext of entry.extensions) {
    EXTENSION_TO_LANGUAGE.set(ext.toLowerCase(), entry);
  }
}

/**
 * Extracts the file extension (with leading dot) from a file path.
 */
export function extractExtension(filePath: string): string {
  if (!filePath) return '';
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const filename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return '';
  return filename.slice(lastDot);
}

/**
 * Detects programming language based on file extension in O(1) time.
 * Returns null if the file extension is not recognized as a supported code file.
 */
export function detectLanguage(filePath: string): LanguageEntry | null {
  if (!filePath) return null;
  const ext = extractExtension(filePath).toLowerCase();
  if (!ext) return null;
  return EXTENSION_TO_LANGUAGE.get(ext) || null;
}

/**
 * Checks if a given file path corresponds to a supported source code file.
 */
export function isCodeFile(filePath: string): boolean {
  return detectLanguage(filePath) !== null;
}

/**
 * Checks if a given file path corresponds to a documentation or text file.
 */
export function isDocFile(filePath: string): boolean {
  if (!filePath) return false;
  const ext = extractExtension(filePath).toLowerCase();
  return DOC_EXTENSIONS.has(ext);
}
