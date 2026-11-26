import { DEEP_DIVE_LAYER_ATTRIBUTE } from '@/lib/constants';
import { isDeepDiveLayerValue } from '@/lib/mdx/deep-dive-normalize';
import { cleanMarkdownHeading } from '@/engine/structurizer/prefix-cleaner';
import { fnv1a64Hex } from '@/lib/fnv64a';

export interface ParsedHtmlTag {
  end: number;
  name: string;
  rawName: string;
  closing: boolean;
  selfClose: boolean;
  attrStart: number;
  attrEnd: number;
}

export interface FallbackTocEntry {
  depth: number;
  title: string;
  url: string;
}

function isEscapedAt(s: string, i: number): boolean {
  let bs = 0;
  for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) {
    bs++;
  }
  return bs % 2 === 1;
}

function matchFenceOpener(line: string): { char: string; len: number } | null {
  const m = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  const char = m[1][0];
  // CommonMark: backtick fence info strings cannot contain backticks.
  if (char === '`' && m[2].includes('`')) return null;
  return { char, len: m[1].length };
}

function isFenceCloser(line: string, fenceChar: string, fenceLen: number): boolean {
  const m = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
  return Boolean(m && m[1][0] === fenceChar && m[1].length >= fenceLen);
}

function readLineSlice(s: string, start: number): { line: string; rawLineEnd: number } {
  const nl = s.indexOf('\n', start);
  const rawLineEnd = nl >= 0 ? nl + 1 : s.length;
  const rawLine = nl >= 0 ? s.slice(start, nl) : s.slice(start);
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  return { line, rawLineEnd };
}

function matchInlineCodeSpan(s: string, i: number): number {
  let runLen = 0;
  while (i + runLen < s.length && s[i + runLen] === '`') {
    runLen++;
  }
  let p = i + runLen;
  while (p < s.length) {
    if (s[p] === '\n') {
      // CommonMark: inline code spans cannot cross a blank line.
      let q = p + 1;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
      if (q < s.length && (s[q] === '\n' || s[q] === '\r')) {
        return -1;
      }
      p++;
      continue;
    }
    if (s[p] === '`') {
      let closeLen = 0;
      while (p + closeLen < s.length && s[p + closeLen] === '`') {
        closeLen++;
      }
      if (closeLen === runLen) {
        return p + closeLen;
      }
      p += closeLen;
      continue;
    }
    p++;
  }
  return -1;
}

// Unclosed HTML comments skip only `<!--` (matching Go ScanHTMLCommentEnd) without swallowing EOF.
function matchHtmlComment(s: string, i: number): number {
  if (!s.startsWith('<!--', i)) return -1;
  const end = s.indexOf('-->', i + 4);
  return end >= 0 ? end + 3 : i + 4;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagNameChar(code: number): boolean {
  return (
    isAsciiLetter(code) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 58 ||
    code === 95 ||
    code === 46
  );
}

function isHtmlSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

// Quote/JSX-brace-aware tag scanner (synced with Go armor.ScanProseTag) so `>` in attributes never truncates tags.
export function scanHtmlTag(s: string, i: number): ParsedHtmlTag | null {
  if (s[i] !== '<') return null;
  let j = i + 1;
  let closing = false;
  if (j < s.length && s[j] === '/') {
    closing = true;
    j++;
  }
  if (j >= s.length || !isAsciiLetter(s.charCodeAt(j))) {
    return null;
  }
  const nameStart = j;
  while (j < s.length && isTagNameChar(s.charCodeAt(j))) {
    j++;
  }
  const attrStart = j;
  let quote = '';
  let braceDepth = 0;
  while (j < s.length) {
    const ch = s[j];
    if (quote) {
      if (ch === quote && (quote === "'" || quote === '"' || !isEscapedAt(s, j))) {
        quote = '';
      }
      j++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '`') {
      if (braceDepth > 0) {
        quote = ch;
      }
    } else if (ch === '{') {
      braceDepth++;
    } else if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth--;
      }
    } else if (ch === '<') {
      if (braceDepth === 0) {
        return null;
      }
    } else if (ch === '>') {
      if (braceDepth === 0) {
        let attrEnd = j;
        const selfClose = !closing && attrEnd > attrStart && s[attrEnd - 1] === '/';
        if (selfClose) {
          attrEnd--;
        }
        const rawName = s.slice(nameStart, attrStart);
        return {
          end: j + 1,
          name: rawName.toLowerCase(),
          rawName,
          closing,
          selfClose,
          attrStart,
          attrEnd,
        };
      }
    }
    j++;
  }
  return null;
}

function isDeepDiveDetailsTag(s: string, tag: ParsedHtmlTag): boolean {
  if (tag.rawName !== 'details' || tag.closing || tag.selfClose) return false;
  let i = tag.attrStart;
  const end = tag.attrEnd;
  while (i < end) {
    while (i < end && isHtmlSpace(s[i])) i++;
    if (i >= end || s[i] === '/') break;
    const nameStart = i;
    while (i < end && s[i] !== '=' && s[i] !== '/' && !isHtmlSpace(s[i])) i++;
    const attrName = s.slice(nameStart, i);
    while (i < end && isHtmlSpace(s[i])) i++;
    if (i >= end || s[i] !== '=') {
      continue;
    }
    i++;
    while (i < end && isHtmlSpace(s[i])) i++;
    let value = '';
    if (i < end && (s[i] === '"' || s[i] === "'")) {
      const q = s[i++];
      const valStart = i;
      while (i < end && s[i] !== q) i++;
      value = s.slice(valStart, i);
      if (i < end) i++;
    } else {
      const valStart = i;
      while (i < end && !isHtmlSpace(s[i]) && s[i] !== '/') i++;
      value = s.slice(valStart, i);
    }
    if (
      attrName.toLowerCase() === DEEP_DIVE_LAYER_ATTRIBUTE &&
      isDeepDiveLayerValue(value)
    ) {
      return true;
    }
  }
  return false;
}

function trimTrailingHorizontalSpaces(str: string): string {
  let end = str.length;
  while (end > 0 && (str[end - 1] === ' ' || str[end - 1] === '\t')) {
    end--;
  }
  return end === str.length ? str : str.slice(0, end);
}

function countTrailingBlankNewlines(str: string): number {
  let i = str.length;
  let count = 0;
  while (i > 0) {
    while (i > 0 && (str[i - 1] === ' ' || str[i - 1] === '\t')) {
      i--;
    }
    if (i > 0 && str[i - 1] === '\n') {
      count++;
      i--;
      if (i > 0 && str[i - 1] === '\r') {
        i--;
      }
      continue;
    }
    break;
  }
  return count;
}

function skipAheadNewlines(
  s: string,
  from: number,
): { nextNonWs: number; nlCount: number } {
  let p = from;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p++;
  let nlCount = 0;
  let afterLastNl = p;
  while (p < s.length) {
    if (s[p] === '\r' && s[p + 1] === '\n') {
      nlCount++;
      p += 2;
      afterLastNl = p;
    } else if (s[p] === '\n') {
      nlCount++;
      p += 1;
      afterLastNl = p;
    } else if (s[p] === ' ' || s[p] === '\t') {
      let q = p;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
      if (q < s.length && (s[q] === '\n' || s[q] === '\r')) {
        p = q;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return { nextNonWs: afterLastNl, nlCount };
}

interface WalkerControl {
  nextIndex: number;
  atLineStart?: boolean;
}

interface MdxProseVisitor {
  beforeToken?: (index: number) => WalkerControl | null;
  onFenceLine: (rawSlice: string) => void;
  onNewline: (seq: string) => void;
  onInlineCode: (rawSlice: string) => void;
  onComment: (rawSlice: string) => void;
  onTag: (tag: ParsedHtmlTag, rawSlice: string, startIndex: number) => WalkerControl | void;
  onChar: (ch: string) => void;
}

function walkMdxProseTokens(src: string, visitor: MdxProseVisitor): void {
  let i = 0;
  let atLineStart = true;
  let inFence: { char: string; len: number } | null = null;

  while (i < src.length) {
    if (visitor.beforeToken) {
      const ctrl = visitor.beforeToken(i);
      if (ctrl) {
        i = ctrl.nextIndex;
        if (ctrl.atLineStart !== undefined) atLineStart = ctrl.atLineStart;
        continue;
      }
    }

    if (inFence) {
      const { line, rawLineEnd } = readLineSlice(src, i);
      visitor.onFenceLine(src.slice(i, rawLineEnd));
      if (isFenceCloser(line, inFence.char, inFence.len)) {
        inFence = null;
      }
      i = rawLineEnd;
      atLineStart = true;
      continue;
    }

    if (atLineStart) {
      const { line, rawLineEnd } = readLineSlice(src, i);
      const fence = matchFenceOpener(line);
      if (fence) {
        visitor.onFenceLine(src.slice(i, rawLineEnd));
        inFence = fence;
        i = rawLineEnd;
        atLineStart = true;
        continue;
      }
      atLineStart = false;
    }

    const ch = src[i];
    if (ch === '\n' || ch === '\r') {
      const step = ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      visitor.onNewline(src.slice(i, i + step));
      i += step;
      atLineStart = true;
      continue;
    }

    if (ch === '`' && !isEscapedAt(src, i)) {
      const spanEnd = matchInlineCodeSpan(src, i);
      if (spanEnd >= 0) {
        visitor.onInlineCode(src.slice(i, spanEnd));
        i = spanEnd;
        atLineStart = false;
        continue;
      }
      visitor.onChar(ch);
      i++;
      continue;
    }

    if (ch === '<') {
      const commentEnd = matchHtmlComment(src, i);
      if (commentEnd >= 0) {
        visitor.onComment(src.slice(i, commentEnd));
        i = commentEnd;
        atLineStart = commentEnd > 0 && (src[commentEnd - 1] === '\n' || src[commentEnd - 1] === '\r');
        continue;
      }

      const tag = scanHtmlTag(src, i);
      if (tag) {
        const ctrl = visitor.onTag(tag, src.slice(i, tag.end), i);
        if (ctrl) {
          i = ctrl.nextIndex;
          atLineStart = ctrl.atLineStart ?? false;
        } else {
          i = tag.end;
          atLineStart = false;
        }
        continue;
      }
    }

    visitor.onChar(ch);
    i++;
  }
}

export function normalizeDeepDiveBlocks(content: string): string {
  if (!content) return content;
  if (
    !content.includes('<details') &&
    !content.includes('</details') &&
    !content.includes('<summary') &&
    !content.includes('</summary')
  ) {
    return content;
  }

  let out = '';
  walkMdxProseTokens(content, {
    onFenceLine: (slice) => {
      out += slice;
    },
    onNewline: (seq) => {
      out += seq;
    },
    onInlineCode: (slice) => {
      out += slice;
    },
    onComment: (slice) => {
      out += slice;
    },
    onChar: (ch) => {
      out += ch;
    },
    onTag: (tag, rawSlice) => {
      if (tag.rawName === 'details' && !tag.closing && !tag.selfClose) {
        out = trimTrailingHorizontalSpaces(out);
        if (out.length > 0 && !out.endsWith('\n')) {
          out += '\n\n';
        }
        out += rawSlice;
        let p = tag.end;
        while (p < content.length && (content[p] === ' ' || content[p] === '\t')) p++;
        if (p < content.length && content[p] !== '\n' && content[p] !== '\r') {
          const nextTag = content[p] === '<' ? scanHtmlTag(content, p) : null;
          out +=
            nextTag && nextTag.rawName === 'summary' && !nextTag.closing && !nextTag.selfClose
              ? '\n'
              : '\n\n';
          return { nextIndex: p, atLineStart: true };
        }
        return { nextIndex: tag.end, atLineStart: false };
      }

      if (tag.rawName === 'summary' && !tag.closing && !tag.selfClose) {
        out = trimTrailingHorizontalSpaces(out);
        if (out.length > 0 && !out.endsWith('\n')) {
          out += '\n';
        }
        out += rawSlice;
        return { nextIndex: tag.end, atLineStart: false };
      }

      if (tag.rawName === 'summary' && tag.closing) {
        out += rawSlice;
        const { nextNonWs, nlCount } = skipAheadNewlines(content, tag.end);
        if (nextNonWs < content.length) {
          out += nlCount >= 2 ? content.slice(tag.end, nextNonWs) : '\n\n';
          return { nextIndex: nextNonWs, atLineStart: true };
        }
        return { nextIndex: tag.end, atLineStart: false };
      }

      if (tag.rawName === 'details' && tag.closing) {
        out = trimTrailingHorizontalSpaces(out);
        if (out.length > 0) {
          const trailingNls = countTrailingBlankNewlines(out);
          if (trailingNls === 0) out += '\n\n';
          else if (trailingNls === 1) out += '\n';
        }
        out += rawSlice;
        const { nextNonWs, nlCount } = skipAheadNewlines(content, tag.end);
        if (nextNonWs < content.length) {
          out += nlCount >= 2 ? content.slice(tag.end, nextNonWs) : '\n\n';
          return { nextIndex: nextNonWs, atLineStart: true };
        }
        if (nlCount > 0) {
          out += '\n';
          return { nextIndex: nextNonWs, atLineStart: true };
        }
        return { nextIndex: tag.end, atLineStart: false };
      }

      out += rawSlice;
      return { nextIndex: tag.end, atLineStart: false };
    },
  });

  return out;
}

export function stripDeepDiveBlocks(mdx: string): string {
  if (!mdx || !mdx.includes('<details')) {
    return mdx;
  }

  const deepStack: boolean[] = [];
  let out = '';
  let justClosedDeep = false;
  const isInDeep = () => deepStack.some(Boolean);

  walkMdxProseTokens(mdx, {
    beforeToken: (idx) => {
      if (!justClosedDeep || isInDeep()) return null;
      const { nextNonWs, nlCount } = skipAheadNewlines(mdx, idx);
      justClosedDeep = false;
      if (nextNonWs >= mdx.length) {
        out = trimTrailingHorizontalSpaces(out).replace(/\n+$/, '');
        if (nlCount > 0 && out.length > 0) {
          out += '\n';
        }
        return { nextIndex: mdx.length, atLineStart: true };
      }
      if (out.length === 0) {
        return { nextIndex: nextNonWs, atLineStart: true };
      }
      out = trimTrailingHorizontalSpaces(out).replace(/\n+$/, '') + '\n\n';
      return { nextIndex: nextNonWs, atLineStart: true };
    },
    onFenceLine: (slice) => {
      if (!isInDeep()) out += slice;
    },
    onNewline: (seq) => {
      if (!isInDeep()) out += seq;
    },
    onInlineCode: (slice) => {
      if (!isInDeep()) out += slice;
    },
    onComment: (slice) => {
      if (!isInDeep()) out += slice;
    },
    onChar: (ch) => {
      if (!isInDeep()) out += ch;
    },
    onTag: (tag, rawSlice) => {
      if (tag.rawName === 'details' && !tag.selfClose) {
        const wasDeep = isInDeep();
        if (tag.closing) {
          if (deepStack.length > 0) deepStack.pop();
        } else {
          deepStack.push(isDeepDiveDetailsTag(mdx, tag));
        }
        const nowDeep = isInDeep();

        if (!wasDeep && nowDeep) {
          out = trimTrailingHorizontalSpaces(out);
          let p = tag.end;
          while (p < mdx.length && (mdx[p] === ' ' || mdx[p] === '\t')) p++;
          return { nextIndex: p < mdx.length ? p : tag.end, atLineStart: true };
        }
        if (wasDeep && !nowDeep) {
          justClosedDeep = true;
          return { nextIndex: tag.end, atLineStart: false };
        }
        if (nowDeep) {
          return { nextIndex: tag.end, atLineStart: false };
        }
      }

      if (isInDeep() && tag.rawName === 'summary' && tag.closing) {
        let p = tag.end;
        while (p < mdx.length && (mdx[p] === ' ' || mdx[p] === '\t')) p++;
        return { nextIndex: p < mdx.length ? p : tag.end, atLineStart: true };
      }

      if (!isInDeep()) {
        out += rawSlice;
      }
      return { nextIndex: tag.end, atLineStart: false };
    },
  });

  if (justClosedDeep && !isInDeep()) {
    out = trimTrailingHorizontalSpaces(out).replace(/\n+$/, '');
  }
  return out;
}

function buildFallbackHeadingSlug(titleText: string): string {
  const trimmed = titleText.trim();
  if (!trimmed) return '';
  const slug = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return slug ? `#${slug}` : `#h-${fnv1a64Hex(trimmed)}`;
}

export function scanFallbackTocAndDeepDives(mdx: string): {
  toc: FallbackTocEntry[];
  deepDiveCount: number;
} {
  if (!mdx) return { toc: [], deepDiveCount: 0 };

  const deepStack: boolean[] = [];
  const toc: FallbackTocEntry[] = [];
  let deepDiveCount = 0;
  const isInDeep = () => deepStack.some(Boolean);

  let currentLine = '';
  let lineBlocked = isInDeep();

  const flushLine = () => {
    const blocked = lineBlocked || isInDeep();
    const rawLine = currentLine.endsWith('\r') ? currentLine.slice(0, -1) : currentLine;
    currentLine = '';
    lineBlocked = isInDeep();
    if (blocked || !rawLine) return;

    const headingMatch = rawLine.match(/^[ \t]{0,3}(#{1,6})\s+(.+)$/);
    if (!headingMatch) return;
    const depth = headingMatch[1].length;
    const rawTitle = headingMatch[2];
    const customAnchorMatch = rawTitle.match(/\{#([a-zA-Z0-9_-]+)\}/);
    const titleText = cleanMarkdownHeading(rawTitle);
    if (!titleText) return;
    const url = customAnchorMatch ? `#${customAnchorMatch[1]}` : buildFallbackHeadingSlug(titleText);
    toc.push({ depth, title: titleText, url });
  };

  walkMdxProseTokens(mdx, {
    onFenceLine: () => {
      currentLine = '';
      lineBlocked = isInDeep();
    },
    onNewline: () => {
      flushLine();
    },
    onInlineCode: (slice) => {
      if (slice.includes('\n')) {
        lineBlocked = true;
        currentLine = '';
        return;
      }
      if (!lineBlocked && !isInDeep()) {
        currentLine += slice;
      }
    },
    onComment: (slice) => {
      if (slice.includes('\n')) {
        lineBlocked = true;
        currentLine = '';
        return;
      }
      if (!lineBlocked && !isInDeep()) {
        currentLine += slice;
      }
    },
    onChar: (ch) => {
      if (!lineBlocked && !isInDeep()) {
        currentLine += ch;
      }
    },
    onTag: (tag, rawSlice) => {
      if (tag.rawName === 'details' && !tag.selfClose) {
        if (tag.closing) {
          if (deepStack.length > 0) deepStack.pop();
        } else {
          const isDeep = isDeepDiveDetailsTag(mdx, tag);
          if (isDeep) deepDiveCount++;
          deepStack.push(isDeep);
        }
        if (isInDeep()) {
          lineBlocked = true;
        }
      }
      if (rawSlice.includes('\n')) {
        lineBlocked = true;
        currentLine = '';
      } else if (!lineBlocked && !isInDeep()) {
        currentLine += rawSlice;
      }
      return { nextIndex: tag.end, atLineStart: false };
    },
  });

  flushLine();
  return { toc, deepDiveCount };
}
