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
const CODE_ANCHOR_REGEX = /^#?code:([^:#]+)(?:[:#](?:L)?(\d+)(?:-(?:L)?(\d+))?)?$/i;

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

export function isLineInRange(line: number, range: LineRange | null): boolean {
  if (!range || line <= 0) {
    return false;
  }
  return line >= range.startLine && line <= range.endLine;
}

// Anonymous code blocks match only untargeted #L10 ranges; file-scoped #code:path anchors require a filename match.
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

