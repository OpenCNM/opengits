import { stripNumericPrefix, cleanMarkdownHeading } from '@/engine/structurizer/prefix-cleaner';

export function normalizeHeadingKey(text: string): string {
  if (!text) return '';
  let clean = cleanMarkdownHeading(text).toLowerCase();
  clean = clean.replace(/[*~`]/g, '');
  clean = stripNumericPrefix(clean);
  clean = clean.replace(/[*~`]/g, '').replace(/[-_]/g, ' ');
  // Preserve leading dots so identifiers like .NET and .env remain distinct.
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean;
}
