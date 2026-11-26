import { estimateTokens } from '@/lib/token-counter';

export interface TruncateOptions {
  maxTokens?: number;
  maxChars?: number;
  suffix?: string;
  closeFences?: boolean;
  balanceInlineBackticks?: boolean;
  balanceHtmlComments?: boolean;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalTokens: number;
  finalTokens: number;
  closedFences: string[];
}

export const DEFAULT_TRUNCATE_SUFFIX = '\n\n... [Content truncated to fit cognitive budget]';

interface FenceState {
  isOpen: boolean;
  char: '`' | '~';
  length: number;
}

export function scanCodeFenceState(lines: string[]): { activeFence: FenceState | null; allFencesCount: number } {
  let activeFence: FenceState | null = null;
  let allFencesCount = 0;

  for (const line of lines) {
    const trimmedLeft = line.trimStart();
    const leadingSpaces = line.length - trimmedLeft.length;
    if (leadingSpaces > 3) continue; // CommonMark: lines indented >3 spaces are indented code blocks, not fences.

    const match = trimmedLeft.match(/^(`{3,}|~{3,})(.*)$/);
    if (!match) continue;

    const delim = match[1];
    const fenceChar = delim[0] as '`' | '~';
    const fenceLen = delim.length;

    if (activeFence) {
      if (fenceChar === activeFence.char && fenceLen >= activeFence.length) {
        activeFence = null;
        allFencesCount++;
      }
    } else {
      activeFence = { isOpen: true, char: fenceChar, length: fenceLen };
      allFencesCount++;
    }
  }

  return { activeFence, allFencesCount };
}

function findNaturalSliceIndex(codePoints: string[], targetIndex: number): number {
  if (targetIndex >= codePoints.length) return codePoints.length;
  if (targetIndex <= 0) return 0;

  const minLineSearch = Math.max(0, Math.floor(targetIndex * 0.8));
  const subLineStr = codePoints.slice(minLineSearch, targetIndex).join('');
  const lastSingleNewline = subLineStr.lastIndexOf('\n');
  if (lastSingleNewline !== -1) {
    return minLineSearch + lastSingleNewline + 1;
  }

  const minPunctSearch = Math.max(0, Math.floor(targetIndex * 0.85));
  const subPunctStr = codePoints.slice(minPunctSearch, targetIndex).join('');
  const punctMatch = subPunctStr.match(/[。；！？.!?][ \t\n]?/g);
  if (punctMatch && punctMatch.length > 0) {
    const lastPunct = punctMatch[punctMatch.length - 1];
    const punctIndex = subPunctStr.lastIndexOf(lastPunct);
    if (punctIndex !== -1) {
      return minPunctSearch + punctIndex + lastPunct.length;
    }
  }

  const minWordSearch = Math.max(0, Math.floor(targetIndex * 0.9));
  const subWordStr = codePoints.slice(minWordSearch, targetIndex).join('');
  const lastSpace = subWordStr.lastIndexOf(' ');
  if (lastSpace !== -1) {
    return minWordSearch + lastSpace + 1;
  }

  return targetIndex;
}

function balanceInlineAndHtmlClosures(text: string, balanceInline: boolean, balanceHtml: boolean): string {
  let closures = '';

  if (balanceHtml) {
    const openHtml = (text.match(/<!--/g) || []).length;
    const closeHtml = (text.match(/-->/g) || []).length;
    if (openHtml > closeHtml) {
      closures += ' -->';
    }
  }

  if (balanceInline) {
    const unescapedSingleBackticks = text.replace(/`{2,}/g, '').match(/`/g);
    if (unescapedSingleBackticks && unescapedSingleBackticks.length % 2 !== 0) {
      closures += '`';
    }
  }

  return closures;
}

// Truncates by code points to avoid splitting surrogate pairs/CJK, then closes unclosed fences and inline backticks.
export function truncateCognitiveBudget(
  text: string,
  options: TruncateOptions = {}
): TruncateResult {
  if (!text || typeof text !== 'string') {
    return { text: '', truncated: false, originalTokens: 0, finalTokens: 0, closedFences: [] };
  }

  const {
    maxTokens,
    maxChars,
    suffix = DEFAULT_TRUNCATE_SUFFIX,
    closeFences = true,
    balanceInlineBackticks = true,
    balanceHtmlComments = true,
  } = options;

  const originalTokens = estimateTokens(text);

  if (
    (typeof maxTokens === 'number' && (isNaN(maxTokens) || maxTokens <= 0)) ||
    (typeof maxChars === 'number' && (isNaN(maxChars) || maxChars <= 0))
  ) {
    return { text: '', truncated: true, originalTokens, finalTokens: 0, closedFences: [] };
  }

  const isTokenLimited = typeof maxTokens === 'number' && !isNaN(maxTokens) && maxTokens > 0;
  const isCharLimited = typeof maxChars === 'number' && !isNaN(maxChars) && maxChars > 0;

  if (!isTokenLimited && !isCharLimited) {
    return { text, truncated: false, originalTokens, finalTokens: originalTokens, closedFences: [] };
  }

  const withinToken = !isTokenLimited || originalTokens <= maxTokens!;
  const withinChar = !isCharLimited || text.length <= maxChars!;

  if (withinToken && withinChar) {
    return { text, truncated: false, originalTokens, finalTokens: originalTokens, closedFences: [] };
  }

  const safeSuffix = typeof suffix === 'string' ? suffix : '';
  const suffixTokens = estimateTokens(safeSuffix);
  
  let effectiveSuffix = safeSuffix;
  let effectiveSuffixTokens = suffixTokens;
  if (isTokenLimited && maxTokens! < suffixTokens + 10) {
    effectiveSuffix = '...';
    effectiveSuffixTokens = 1;
  }

  const reserveFenceTokens = closeFences ? 5 : 0;
  const targetTokenBudget = isTokenLimited ? Math.max(1, maxTokens! - effectiveSuffixTokens - reserveFenceTokens) : Infinity;
  const targetCharBudget = isCharLimited ? Math.max(1, maxChars! - effectiveSuffix.length - 8) : Infinity;

  const codePoints = Array.from(text);

  let rawSliceIndex = codePoints.length;
  if (isCharLimited) {
    rawSliceIndex = Math.min(rawSliceIndex, targetCharBudget);
  }
  if (isTokenLimited && originalTokens > 0) {
    const tokenRatio = Math.max(0, Math.min(1, targetTokenBudget / originalTokens));
    const estimatedIndex = Math.floor(codePoints.length * tokenRatio);
    rawSliceIndex = Math.min(rawSliceIndex, estimatedIndex);
  }

  let sliceIndex = findNaturalSliceIndex(codePoints, rawSliceIndex);
  if (sliceIndex === 0 && rawSliceIndex > 0) {
    sliceIndex = rawSliceIndex;
  }
  let slicedText = codePoints.slice(0, sliceIndex).join('');

  if (isTokenLimited) {
    let currentTokens = estimateTokens(slicedText);
    let iterations = 0;
    while (currentTokens > targetTokenBudget && sliceIndex > 0 && iterations < 50) {
      iterations++;
      sliceIndex = Math.floor(sliceIndex * 0.92);
      slicedText = codePoints.slice(0, sliceIndex).join('');
      currentTokens = estimateTokens(slicedText);
    }
  }

  const closedFences: string[] = [];
  let fencePatch = '';

  if (closeFences) {
    const lines = slicedText.split('\n');
    const { activeFence } = scanCodeFenceState(lines);
    if (activeFence) {
      const closingDelimiter = activeFence.char.repeat(activeFence.length);
      fencePatch = `\n${closingDelimiter}\n`;
      closedFences.push(closingDelimiter);
    }
  }

  const inlinePatch = balanceInlineAndHtmlClosures(slicedText, balanceInlineBackticks, balanceHtmlComments);

  const finalText = `${slicedText}${inlinePatch}${fencePatch}${effectiveSuffix}`;
  const finalTokens = estimateTokens(finalText);

  return {
    text: finalText,
    truncated: true,
    originalTokens,
    finalTokens,
    closedFences,
  };
}
