// Strips outer fences only when opening and closing fence char/length match; leaves unclosed or inner blocks intact.
export function stripEnclosingFences(
  trimmed: string,
  allowedLangs: readonly string[] = ['markdown', 'mdx', 'md', ''],
): string {
  const firstLineEnd = trimmed.indexOf('\n');
  if (firstLineEnd === -1) return trimmed;

  const firstLine = trimmed.substring(0, firstLineEnd).trim();
  const openMatch = firstLine.match(/^(`{3,}|~{3,})(.*)$/);
  if (!openMatch) return trimmed;

  const lang = (openMatch[2] ?? '').trim().toLowerCase();
  if (!allowedLangs.includes(lang)) return trimmed;

  const fenceChar = openMatch[1][0];
  const fenceLen = openMatch[1].length;
  const lastNewline = trimmed.lastIndexOf('\n');
  if (lastNewline <= firstLineEnd) return trimmed;

  const lastLine = trimmed.substring(lastNewline).trim();
  const closeMatch = lastLine.match(/^(`{3,}|~{3,})\s*$/);
  if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
    return trimmed.substring(firstLineEnd + 1, lastNewline);
  }
  return trimmed;
}
