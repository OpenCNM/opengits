/**
 * apps/client/src/lib/code-viewport/line-anchor.ts
 *
 * 零物化代码视口行号锚点纯函数库 (Zero-Materialization Line Anchor Projection)。
 *
 * 将 URL Hash 状态视为唯一正典事实源，提供纳秒级纯函数解析与范围判定：
 * - 支持单行锚点：#L15
 * - 支持区间锚点：#L15-L25 / #L15-25（自动归一化 min/max，避免倒序越界）
 * - 纯函数状态投影，零 React Fiber 内存持有与多重状态机冲突
 */

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface CodeAnchorTarget {
  filePath?: string;
  range: LineRange;
  symbol?: string;
}

const LINE_ANCHOR_REGEX = /^#?L(\d+)(?:-(?:L)?(\d+))?$/i;
// 支持 #code:<path>:L<start>-L<end>、#code:<path>:L<start>、#code:<path>#L<start>-L<end>、#code:<path>
const CODE_ANCHOR_REGEX = /^#?code:([^:#]+)(?:[:#](?:L)?(\d+)(?:-(?:L)?(\d+))?)?$/i;

/**
 * 解析 URL Hash 中的代码行号锚点。
 * 命中返回归一化后的闭区间 { startLine, endLine }；非行号 Hash（如 #heading）安全返回 null。
 */
export function parseLineAnchor(hash: string | null | undefined): LineRange | null {
  if (!hash || typeof hash !== 'string') {
    return null;
  }

  const clean = hash.trim();
  const match = clean.match(LINE_ANCHOR_REGEX);
  if (!match) {
    return null;
  }

  const start = parseInt(match[1], 10);
  if (Number.isNaN(start) || start <= 0) {
    return null;
  }

  if (!match[2]) {
    return { startLine: start, endLine: start };
  }

  const end = parseInt(match[2], 10);
  if (Number.isNaN(end) || end <= 0) {
    return { startLine: start, endLine: start };
  }

  return {
    startLine: Math.min(start, end),
    endLine: Math.max(start, end),
  };
}

/**
 * 解析 URL Hash 中的通用代码锚点（支持跨文件深链接与同文件行号）。
 * - #code:src/lib/auth.ts:L15-L25 => { filePath: 'src/lib/auth.ts', range: { startLine: 15, endLine: 25 } }
 * - #code:src/lib/auth.ts => { filePath: 'src/lib/auth.ts', range: { startLine: 1, endLine: 1 } }
 * - #L15-L25 => { range: { startLine: 15, endLine: 25 } }
 */
export function parseCodeAnchor(hash: string | null | undefined): CodeAnchorTarget | null {
  if (!hash || typeof hash !== 'string') {
    return null;
  }

  const clean = hash.trim();
  const codeMatch = clean.match(CODE_ANCHOR_REGEX);
  if (codeMatch) {
    const rawPath = codeMatch[1];
    let filePath: string;
    try {
      filePath = decodeURIComponent(rawPath).replace(/^\.?\//, '').trim();
    } catch {
      filePath = rawPath.replace(/^\.?\//, '').trim();
    }

    const startStr = codeMatch[2];
    const endStr = codeMatch[3];
    if (!startStr) {
      return { filePath, range: { startLine: 1, endLine: 1 } };
    }

    const start = parseInt(startStr, 10);
    if (Number.isNaN(start) || start <= 0) {
      return { filePath, range: { startLine: 1, endLine: 1 } };
    }

    if (!endStr) {
      return { filePath, range: { startLine: start, endLine: start } };
    }

    const end = parseInt(endStr, 10);
    const validEnd = Number.isNaN(end) || end <= 0 ? start : end;
    return {
      filePath,
      range: {
        startLine: Math.min(start, validEnd),
        endLine: Math.max(start, validEnd),
      },
    };
  }

  const lineRange = parseLineAnchor(clean);
  if (lineRange) {
    return { range: lineRange };
  }

  return null;
}

/**
 * 将行号或范围格式化为标准 URL Hash。
 */
export function formatLineAnchor(startLine: number, endLine?: number | null): string {
  if (startLine <= 0) {
    return '';
  }

  if (!endLine || startLine === endLine) {
    return `#L${startLine}`;
  }

  const min = Math.min(startLine, endLine);
  const max = Math.max(startLine, endLine);
  return `#L${min}-L${max}`;
}

/**
 * 将代码目标格式化为正典 Hash 字符串。
 */
export function formatCodeAnchor(target: {
  filePath?: string | null;
  startLine: number;
  endLine?: number | null;
  symbol?: string | null;
}): string {
  const { filePath, startLine, endLine } = target;
  if (!filePath) {
    return formatLineAnchor(startLine, endLine);
  }

  const cleanPath = filePath.replace(/^\.?\//, '').trim();
  const lineHash = formatLineAnchor(startLine, endLine).replace(/^#/, '');
  if (!lineHash) {
    return `#code:${cleanPath}`;
  }

  return `#code:${cleanPath}:${lineHash}`;
}

/**
 * 纯函数判定目标行号是否落在激活区间内。
 */
export function isLineInRange(line: number, range: LineRange | null): boolean {
  if (!range || line <= 0) {
    return false;
  }
  return line >= range.startLine && line <= range.endLine;
}

/**
 * 纯函数判定代码锚点目标与代码块文件名是否匹配。
 * 防御幽灵高亮（BUG-REV-05）：
 * 1. 目标未限定文件时（如纯 #L10-L20），允许页面匿名代码块或通用块匹配；
 * 2. 目标限定文件时（如 #code:src/auth.ts:L10），匿名代码块坚决返回 false，仅文件名匹配时返回 true。
 */
export function isCodeAnchorFileMatch(
  targetFilePath: string | undefined | null,
  blockFilePath: string | undefined | null
): boolean {
  if (!targetFilePath) {
    return true;
  }
  if (!blockFilePath) {
    return false;
  }
  const normBlock = blockFilePath.replace(/^\.?\//, '').trim();
  const normTarget = targetFilePath.replace(/^\.?\//, '').trim();
  return normBlock.endsWith(normTarget) || normTarget.endsWith(normBlock);
}

