/**
 * Zero-dependency fast token estimator for LLMs (Qwen / OpenAI cl100k_base / o200k_base).
 * Avoids heavy `js-tiktoken` or WASM overhead while maintaining ~95% accuracy for budgeting decisions.
 */
export function estimateTokens(text: string): number {
 if (!text || typeof text !== 'string' || text.length === 0) return 0;

 // Match CJK characters (Chinese, Japanese Kana, Hangul, Ideographs)
 const cjkMatch = text.match(/[\u4e00-\u9fa5\u3040-\u30ff\u3400-\u4dbf\uf900-\ufaff\uac00-\ud7af]/g);
 const cjkCount = cjkMatch ? cjkMatch.length : 0;
 const nonCjkCount = text.length - cjkCount;

 // In modern LLM tokenizers (Qwen / cl100k_base):
 // - CJK characters average ~1.3 tokens each
 // - ASCII / code / punctuation average ~0.25 tokens each (approx. 4 chars per token)
 const estimated = Math.ceil(cjkCount * 1.3 + nonCjkCount * 0.25);
 return estimated;
}

/**
 * Truncate text to fit within a specific maximum token budget using code-point slicing.
 */
export function truncateToTokenBudget(text: string, maxTokens: number, suffix = '\n\n...[Content truncated to fit token budget]'): string {
  if (typeof maxTokens !== 'number' || isNaN(maxTokens) || maxTokens <= 0) return '';
  if (!text || typeof text !== 'string' || text.length === 0) return '';
  if (estimateTokens(text) <= maxTokens) {
    return text;
  }

  const safeSuffix = typeof suffix === 'string' ? suffix : '';
  const suffixTokens = estimateTokens(safeSuffix);
  if (maxTokens <= suffixTokens) {
    // If budget is smaller than or equal to suffix, return truncated suffix or empty string
    return estimateTokens(safeSuffix) <= maxTokens ? safeSuffix.trim() : '';
  }

  // Reserve ~15 tokens for balancing closures (fences/html comments)
  const targetTokens = Math.max(0, maxTokens - suffixTokens - 15);
  // Convert to array of Unicode code points to avoid splitting surrogate pairs (e.g. emojis/rare CJK)
  const codePoints = Array.from(text);
  const totalTokens = estimateTokens(text);
  const ratio = Math.max(0, Math.min(1, targetTokens / (totalTokens || 1)));
  let sliceIndex = Math.max(0, Math.min(codePoints.length, Math.floor(codePoints.length * ratio)));

  // Fine-tune downwards until within budget (max 200 iterations as safety guard)
  let slicedText = codePoints.slice(0, Math.max(0, sliceIndex)).join('');
  let currentTokens = estimateTokens(slicedText);
  let iterations = 0;
  while (currentTokens > targetTokens && sliceIndex > 0 && iterations < 200) {
    iterations++;
    sliceIndex = Math.floor(sliceIndex * 0.95);
    if (sliceIndex === Math.floor((sliceIndex + 1) * 0.95)) {
      sliceIndex -= 1; // Ensure strict monotonic decrease
    }
    slicedText = codePoints.slice(0, Math.max(0, sliceIndex)).join('');
    currentTokens = estimateTokens(slicedText);
  }

  let balancingClosure = '';
  
  // Check for unclosed markdown code fences
  const fences = slicedText.match(/^[ \t]{0,3}(`{3,}|~{3,})/gm);
  if (fences && fences.length % 2 !== 0) {
    balancingClosure += '\n```\n\n';
  }
  
  // Check for unclosed HTML comments
  const htmlOpen = (slicedText.match(/<!--/g) || []).length;
  const htmlClose = (slicedText.match(/-->/g) || []).length;
  if (htmlOpen > htmlClose) {
    balancingClosure += ' -->\n\n';
  }

  return slicedText + balancingClosure + safeSuffix;
}

/**
 * Summarize a documentation chunk for MCP summary mode:
 * Extracts narrative intro (up to maxIntroChars) + key code blocks, ensuring balanced code fences.
 */
export function summarizeDocChunk(content: string, maxIntroChars = 150): string {
  if (!content || typeof content !== 'string') return '';
  const trimmed = content.trim();
  if (trimmed.length <= maxIntroChars) return trimmed;

  // Extract code blocks (fenced by ``` or ~~~)
  const codeBlockRegex = /^[ \t]{0,3}(`{3,}|~{3,})[\s\S]*?^[ \t]{0,3}\1/gm;
  const codeBlocks: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(trimmed)) !== null && codeBlocks.length < 2) {
    codeBlocks.push(match[0]);
  }

  // Remove code blocks to extract pure narrative text
  const narrativeOnly = trimmed.replace(/^[ \t]{0,3}(`{3,}|~{3,})[\s\S]*?^[ \t]{0,3}\1/gm, '').trim();
  const intro = Array.from(narrativeOnly).slice(0, maxIntroChars).join('');
  const introWithEllipsis = narrativeOnly.length > maxIntroChars ? `${intro}...` : intro;

  if (codeBlocks.length > 0) {
    return `${introWithEllipsis}\n\n**Key Code Sample:**\n${codeBlocks.join('\n\n')}`;
  }

  return truncateToTokenBudget(trimmed, 150, '\n\n...[Summary truncated]');
}

