export interface DeepDiveLineRange {
  startLine: number;
  endLine?: number;
}

export interface DeepDiveContext {
  code: string;
  language?: string;
  filePath?: string;
  title?: string;
  sectionTitle?: string;
  surroundingContext?: string;
  symbol?: string;
  lineRange?: DeepDiveLineRange;
  lineCount?: number;
}

interface DrawerTargetContext {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
}

interface ExtractCodeExplainContextOptions {
  element: HTMLElement | null;
  code: string;
  language?: string;
  filePath?: string;
  title?: string;
  lineCount?: number;
  drawerState?: {
    isOpen: boolean;
    target?: DrawerTargetContext | null;
  };
}

const MAX_SURROUNDING_CHARS = 420;
const MAX_CODE_LINES_DIRECT = 240;
const MAX_CODE_CHARS = 8000;
const FOCUS_CONTEXT_RADIUS_LINES = 60;

export function parseExplainCodePayload(raw: string): DeepDiveContext | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}') || !trimmed.includes('explain_code')) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type !== 'explain_code' || typeof record.code !== 'string' || !record.code.trim()) {
      return null;
    }

    let lineRange: DeepDiveLineRange | undefined;
    if (record.lineRange && typeof record.lineRange === 'object') {
      const rangeRecord = record.lineRange as Record<string, unknown>;
      if (typeof rangeRecord.startLine === 'number' && Number.isFinite(rangeRecord.startLine)) {
        lineRange = {
          startLine: rangeRecord.startLine,
          ...(typeof rangeRecord.endLine === 'number' && Number.isFinite(rangeRecord.endLine)
            ? { endLine: rangeRecord.endLine }
            : {}),
        };
      }
    }

    return {
      code: record.code,
      language: typeof record.language === 'string' && record.language.trim() ? record.language.trim() : undefined,
      filePath: typeof record.filePath === 'string' && record.filePath.trim() ? record.filePath.trim() : undefined,
      title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : undefined,
      sectionTitle:
        typeof record.sectionTitle === 'string' && record.sectionTitle.trim()
          ? record.sectionTitle.trim()
          : undefined,
      surroundingContext:
        typeof record.surroundingContext === 'string' && record.surroundingContext.trim()
          ? record.surroundingContext.trim()
          : undefined,
      symbol: typeof record.symbol === 'string' && record.symbol.trim() ? record.symbol.trim() : undefined,
      lineRange,
      lineCount:
        typeof record.lineCount === 'number' && Number.isFinite(record.lineCount)
          ? record.lineCount
          : undefined,
    };
  } catch {
    return null;
  }
}

export function serializeExplainCodePayload(context: DeepDiveContext): string {
  return JSON.stringify({
    type: 'explain_code',
    code: context.code,
    ...(context.language ? { language: context.language } : {}),
    ...(context.filePath ? { filePath: context.filePath } : {}),
    ...(context.title ? { title: context.title } : {}),
    ...(context.sectionTitle ? { sectionTitle: context.sectionTitle } : {}),
    ...(context.surroundingContext ? { surroundingContext: context.surroundingContext } : {}),
    ...(context.symbol ? { symbol: context.symbol } : {}),
    ...(context.lineRange ? { lineRange: context.lineRange } : {}),
    ...(context.lineCount ? { lineCount: context.lineCount } : {}),
  });
}

export function buildExplainCodeSearchQuery(context: DeepDiveContext): string {
  const parts = [
    context.sectionTitle,
    context.filePath,
    context.title,
    context.symbol,
    context.surroundingContext ? context.surroundingContext.slice(0, 140) : undefined,
    context.language,
  ].filter((part): part is string => Boolean(part && part.trim()));

  if (parts.length > 0) {
    return parts.join(' ').slice(0, 260);
  }
  return context.code.slice(0, 200);
}

function normalizeInlineText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function focusCodeWindow(rawCode: string, lineRange?: DeepDiveLineRange): string {
  const lines = rawCode.split('\n');
  if (lines.length <= MAX_CODE_LINES_DIRECT && rawCode.length <= MAX_CODE_CHARS) {
    return rawCode;
  }

  if (lineRange && lineRange.startLine > 0) {
    const startIdx = Math.max(0, lineRange.startLine - 1 - FOCUS_CONTEXT_RADIUS_LINES);
    const endAnchor = lineRange.endLine && lineRange.endLine >= lineRange.startLine
      ? lineRange.endLine
      : lineRange.startLine;
    const endIdx = Math.min(lines.length, endAnchor + FOCUS_CONTEXT_RADIUS_LINES);
    const slice = lines.slice(startIdx, endIdx).join('\n');
    const prefix = startIdx > 0 ? `// ... lines 1-${startIdx} omitted ...\n` : '';
    const suffix = endIdx < lines.length ? `\n// ... lines ${endIdx + 1}-${lines.length} omitted ...` : '';
    const focused = `${prefix}${slice}${suffix}`;
    return focused.length > MAX_CODE_CHARS ? focused.slice(0, MAX_CODE_CHARS) : focused;
  }

  const headLines = lines.slice(0, MAX_CODE_LINES_DIRECT).join('\n');
  const trimmed = headLines.length > MAX_CODE_CHARS ? headLines.slice(0, MAX_CODE_CHARS) : headLines;
  return `${trimmed}\n// ... truncated (${lines.length} total lines) ...`;
}

function extractDomContext(element: HTMLElement | null): {
  sectionTitle?: string;
  surroundingContext?: string;
} {
  if (!element || typeof document === 'undefined') {
    return {};
  }

  const root =
    element.closest<HTMLElement>('[role="dialog"]') ||
    element.closest<HTMLElement>('article') ||
    element.closest<HTMLElement>('#nd-page') ||
    element.closest<HTMLElement>('main');

  if (!root || element.closest('[role="dialog"]')) {
    return {};
  }

  let sectionTitle: string | undefined;
  const precedingParagraphs: string[] = [];

  const proseBlocks = Array.from(
    root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, p, li, blockquote')
  );

  for (const node of proseBlocks) {
    if (element.contains(node)) {
      continue;
    }

    const position = node.compareDocumentPosition(element);
    const isBefore = Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!isBefore) {
      break;
    }

    const text = normalizeInlineText(node.textContent);
    if (!text) continue;

    const tag = node.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
      sectionTitle = text;
      precedingParagraphs.length = 0;
    } else if (!node.closest('pre')) {
      precedingParagraphs.push(text);
      if (precedingParagraphs.length > 2) {
        precedingParagraphs.shift();
      }
    }
  }

  const combinedContext = precedingParagraphs.join(' ').trim();
  const surroundingContext = combinedContext
    ? combinedContext.slice(0, MAX_SURROUNDING_CHARS)
    : undefined;

  return {
    sectionTitle,
    surroundingContext,
  };
}

export function extractCodeExplainContext({
  element,
  code,
  language,
  filePath,
  title,
  lineCount,
  drawerState,
}: ExtractCodeExplainContextOptions): DeepDiveContext {
  const isInDrawer = Boolean(element?.closest('[role="dialog"]') && drawerState?.isOpen);
  const drawerTarget = isInDrawer ? drawerState?.target : null;

  const resolvedFilePath = filePath || drawerTarget?.filePath || undefined;
  const resolvedSymbol = drawerTarget?.symbol || undefined;
  const resolvedLineRange =
    drawerTarget?.startLine && drawerTarget.startLine > 0
      ? {
          startLine: drawerTarget.startLine,
          ...(drawerTarget.endLine && drawerTarget.endLine !== drawerTarget.startLine
            ? { endLine: drawerTarget.endLine }
            : {}),
        }
      : undefined;

  const domContext = extractDomContext(element);
  const normalizedLang =
    language && language.trim() && language.trim().toUpperCase() !== 'CODE'
      ? language.trim().toLowerCase()
      : undefined;

  const focusedCode = focusCodeWindow(code.trim(), resolvedLineRange);

  return {
    code: focusedCode,
    language: normalizedLang,
    filePath: resolvedFilePath,
    title: title && title !== resolvedFilePath ? title : undefined,
    sectionTitle: domContext.sectionTitle,
    surroundingContext: domContext.surroundingContext,
    symbol: resolvedSymbol,
    lineRange: resolvedLineRange,
    lineCount: lineCount ?? code.split('\n').length,
  };
}
