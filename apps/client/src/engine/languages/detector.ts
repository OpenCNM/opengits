import { LanguageEntry, LANGUAGE_MAP } from './definitions';

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc', '.tex']);

const EXTENSION_TO_LANGUAGE = new Map<string, LanguageEntry>();
for (const entry of Object.values(LANGUAGE_MAP)) {
  for (const ext of entry.extensions) {
    EXTENSION_TO_LANGUAGE.set(ext.toLowerCase(), entry);
  }
}

export function extractExtension(filePath: string): string {
  if (!filePath) return '';
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const filename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return '';
  return filename.slice(lastDot);
}

export function detectLanguage(filePath: string): LanguageEntry | null {
  if (!filePath) return null;
  const ext = extractExtension(filePath).toLowerCase();
  if (!ext) return null;
  return EXTENSION_TO_LANGUAGE.get(ext) || null;
}

export function isCodeFile(filePath: string): boolean {
  return detectLanguage(filePath) !== null;
}

export function isDocFile(filePath: string): boolean {
  if (!filePath) return false;
  const ext = extractExtension(filePath).toLowerCase();
  return DOC_EXTENSIONS.has(ext);
}
