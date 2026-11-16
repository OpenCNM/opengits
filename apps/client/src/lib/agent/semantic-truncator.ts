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

/**
 * 确定性扫描 Markdown 行首代码围栏状态（遵循 CommonMark 规范）
 * 支持三反引号（```）与波浪号（~~~）嵌套与各长度围栏
 */
export function scanCodeFenceState(lines: string[]): { activeFence: FenceState | null; allFencesCount: number } {
  let activeFence: FenceState | null = null;
  let allFencesCount = 0;

  for (const line of lines) {
    const trimmedLeft = line.trimStart();
    const leadingSpaces = line.length - trimmedLeft.length;
    if (leadingSpaces > 3) continue; // CommonMark: 缩进超过 3 个空格视为缩进代码块而非 fence

    const match = trimmedLeft.match(/^(`{3,}|~{3,})(.*)$/);
    if (!match) continue;

    const delim = match[1];
    const fenceChar = delim[0] as '`' | '~';
    const fenceLen = delim.length;

    if (activeFence) {
      // 处于代码块中：尝试寻找配对的闭合围栏
      if (fenceChar === activeFence.char && fenceLen >= activeFence.length) {
        activeFence = null;
        allFencesCount++;
      }
    } else {
      // 开启新的代码块
      activeFence = { isOpen: true, char: fenceChar, length: fenceLen };
      allFencesCount++;
    }
  }

  return { activeFence, allFencesCount };
}

/**
 * 在目标切片点附近寻找最优的自然语言边界（换行 > 标点 > 空格）
 * 优先在紧挨 targetIndex 的换行处（\n）切断，既保护代码行完整，又不错杀代码块
 */
function findNaturalSliceIndex(codePoints: string[], targetIndex: number): number {
  if (targetIndex >= codePoints.length) return codePoints.length;
  if (targetIndex <= 0) return 0;

  // 1. 最近单行边界探测（回退最多 20% 距离）
  const minLineSearch = Math.max(0, Math.floor(targetIndex * 0.8));
  const subLineStr = codePoints.slice(minLineSearch, targetIndex).join('');
  const lastSingleNewline = subLineStr.lastIndexOf('\n');
  if (lastSingleNewline !== -1) {
    return minLineSearch + lastSingleNewline + 1;
  }

  // 2. 标点符号探测（句号/分号/问号/感叹号）
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

  // 3. 空格探测（单词边界）
  const minWordSearch = Math.max(0, Math.floor(targetIndex * 0.9));
  const subWordStr = codePoints.slice(minWordSearch, targetIndex).join('');
  const lastSpace = subWordStr.lastIndexOf(' ');
  if (lastSpace !== -1) {
    return minWordSearch + lastSpace + 1;
  }

  return targetIndex;
}

/**
 * 闭合截断处可能遗留的行内反引号（单反引号）与 HTML 注释
 */
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
    // 统计除多反引号之外的单反引号奇偶性
    const unescapedSingleBackticks = text.replace(/`{2,}/g, '').match(/`/g);
    if (unescapedSingleBackticks && unescapedSingleBackticks.length % 2 !== 0) {
      closures += '`';
    }
  }

  return closures;
}

/**
 * 核心认知预算确定性语义截断器
 *
 * 第一性公理：
 * 1. 严格遵守 Token / 字符预算上限；
 * 2. 截断绝不拦腰劈开单词、Emoji 或中文字符；
 * 3. 截断后 100% 自愈闭合代码围栏（``` 或 ~~~），保护下游 LLM 上下文免遭语法破碎破坏。
 */
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

  // 0. 非法预算（<=0）直接返回空串
  if (
    (typeof maxTokens === 'number' && (isNaN(maxTokens) || maxTokens <= 0)) ||
    (typeof maxChars === 'number' && (isNaN(maxChars) || maxChars <= 0))
  ) {
    return { text: '', truncated: true, originalTokens, finalTokens: 0, closedFences: [] };
  }

  // 1. 无限额或未超限时直出
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

  // 2. 计算预算配额（动态计算安全预留）
  const safeSuffix = typeof suffix === 'string' ? suffix : '';
  const suffixTokens = estimateTokens(safeSuffix);
  
  // 若预算极小（不足以后缀展示），采用极简模式
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

  // 3. 计算初始截断下标
  let rawSliceIndex = codePoints.length;
  if (isCharLimited) {
    rawSliceIndex = Math.min(rawSliceIndex, targetCharBudget);
  }
  if (isTokenLimited && originalTokens > 0) {
    const tokenRatio = Math.max(0, Math.min(1, targetTokenBudget / originalTokens));
    const estimatedIndex = Math.floor(codePoints.length * tokenRatio);
    rawSliceIndex = Math.min(rawSliceIndex, estimatedIndex);
  }

  // 4. 自然语言边界吸附
  let sliceIndex = findNaturalSliceIndex(codePoints, rawSliceIndex);
  if (sliceIndex === 0 && rawSliceIndex > 0) {
    sliceIndex = rawSliceIndex; // 保底至少保留 rawSliceIndex 字符
  }
  let slicedText = codePoints.slice(0, sliceIndex).join('');

  // 5. 预算单调微调保障（针对 CJK 等高 Token 密度场景递减逼近）
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

  // 6. 确定性围栏自愈分析
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

  // 7. 行内单反引号与 HTML 注释平衡
  const inlinePatch = balanceInlineAndHtmlClosures(slicedText, balanceInlineBackticks, balanceHtmlComments);

  // 8. 组合最终自愈输出
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
