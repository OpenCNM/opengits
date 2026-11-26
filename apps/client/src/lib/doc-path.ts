export function normalizeDocPath(p: string | null | undefined): string {
  if (!p) return '';
  let decoded = p;
  try {
    decoded = decodeURIComponent(p);
  } catch {
  }
  return decoded
    .replace(/^[\s/]+/, '')
    .replace(/[\s/]+$/, '')
    .replace(/\.(md|mdx|markdown)$/i, '')
    .replace(/^[\s/]+/, '')
    .replace(/[\s/]+$/, '');
}

export function matchDocPath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const normA = normalizeDocPath(a);
  const normB = normalizeDocPath(b);
  if (!normA || !normB) return false;
  return normA === normB;
}
