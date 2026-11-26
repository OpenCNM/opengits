export function tokenizeSearchText(text: string): string[] {
  if (!text) return [];

  const tokenSet = new Set<string>();

  const wordTokens = text.match(/[\w.-]+/g) || [];
  for (const raw of wordTokens) {
    const lower = raw.toLowerCase();
    if (lower.length >= 2) {
      tokenSet.add(lower);
    }

    if (/[a-z][A-Z]/.test(raw) || raw.includes('_') || raw.includes('-')) {
      const parts = raw
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_\-.]+/g, ' ')
        .toLowerCase()
        .split(/\s+/);

      for (const part of parts) {
        if (part.length >= 2) {
          tokenSet.add(part);
        }
      }
    }
  }

  // CJK script range synced with Go ogis/tokenizer mdpat.CJKScriptClass.
  const cjkSequences =
    text.match(/[\u4e00-\u9fa5\u3040-\u30ff\u3400-\u4dbf\uf900-\ufaff\uac00-\ud7af]+/g) || [];
  for (const seq of cjkSequences) {
    if (seq.length <= 6) {
      tokenSet.add(seq);
    }
    for (let i = 0; i < seq.length; i++) {
      tokenSet.add(seq[i]);
    }
    for (let i = 0; i < seq.length - 1; i++) {
      tokenSet.add(seq.slice(i, i + 2));
    }
  }

  return Array.from(tokenSet);
}
