/**
 * apps/client/src/lib/search/binary-index-tokenizer.ts
 *
 * Multilingual Search Tokenizer (CJK + English / Code Identifiers).
 * Zero-dependency pure function, safe for both Server and Browser / Client Components.
 */

/**
 * Tokenizes text into search terms:
 * - CJK characters (individual characters, unigrams, bigrams, short continuous sequences)
 * - English words & numbers
 * - Deconstructs camelCase and snake_case for enhanced code search
 */
export function tokenizeSearchText(text: string): string[] {
  if (!text) return [];

  const tokenSet = new Set<string>();

  // 1. English / identifier / numbers extraction
  const wordTokens = text.match(/[\w.-]+/g) || [];
  for (const raw of wordTokens) {
    const lower = raw.toLowerCase();
    if (lower.length >= 2) {
      tokenSet.add(lower);
    }

    // Deconstruct camelCase and snake_case code identifiers
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

  // 2. CJK tokenization: continuous sequences, unigrams, and bigrams
  // （汉 + 日文假名 + 韩文谚文 + 扩展区；与 Go ogis/tokenizer.mdpat.CJKScriptClass 锁步）
  const cjkSequences =
    text.match(/[\u4e00-\u9fa5\u3040-\u30ff\u3400-\u4dbf\uf900-\ufaff\uac00-\ud7af]+/g) || [];
  for (const seq of cjkSequences) {
    // Add the full sequence if short (<= 6 chars, e.g. "线性内存")
    if (seq.length <= 6) {
      tokenSet.add(seq);
    }
    // Add unigrams (e.g. "线", "性", "内", "存")
    for (let i = 0; i < seq.length; i++) {
      tokenSet.add(seq[i]);
    }
    // Add bigrams (2-char sliding window, e.g. "线性", "性内", "内存")
    for (let i = 0; i < seq.length - 1; i++) {
      tokenSet.add(seq.slice(i, i + 2));
    }
  }

  return Array.from(tokenSet);
}
