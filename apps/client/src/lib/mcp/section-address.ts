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

// Strip duplicate `${docPath}#` prefix emitted on markdown chunk headingPaths so read_section matches cleanly.
export function buildCleanSectionAddress(docPath: string, headingPath?: string | null): string {
  const key = (headingPath || '').trim();
  if (!key) return buildSectionAddress(docPath, key);
  const prefix = `${docPath}${SECTION_ADDRESS_SEPARATOR}`;
  const cleaned = key.startsWith(prefix) ? key.slice(prefix.length).trim() : key;
  return buildSectionAddress(docPath, cleaned);
}
