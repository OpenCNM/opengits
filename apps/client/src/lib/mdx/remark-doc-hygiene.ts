import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';
import { DEEP_DIVE_LAYER_ATTRIBUTE, DEEP_DIVE_LAYER_VALUE } from '@/lib/constants';
import {
  isDeepDiveLayerValue,
  stripDeepDiveSummaryPrefix,
} from '@/lib/mdx/deep-dive-normalize';

// Leading capture consumes optional wrapper quote around `[!TYPE]` so paired trailing quotes can be stripped cleanly.
const GFM_ALERT_MARKER_RE = /^([“”"'‘’])?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i;

const GFM_ALERT_TYPE_MAP: Record<string, string> = {
  note: 'note',
  tip: 'tip',
  important: 'important',
  warning: 'warning',
  caution: 'danger',
};

const WRAPPING_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ['“', '”'],
  ["'", "'"],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
];

function closingQuoteFor(open: string): string {
  return WRAPPING_QUOTE_PAIRS.find(([o]) => o === open)?.[1] ?? '';
}

function stripWrappingQuotes(s: string): string {
  for (const [open, close] of WRAPPING_QUOTE_PAIRS) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

function countQuotesInNode(node: any, open: string, closing: string): { openCount: number; closeCount: number } {
  let openCount = 0;
  let closeCount = 0;
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'code' || n.type === 'inlineCode') return;
    if (n.type === 'text' && typeof n.value === 'string') {
      for (const ch of n.value) {
        if (ch === open) openCount++;
        if (ch === closing) closeCount++;
      }
      return;
    }
    if (Array.isArray(n.children)) {
      for (const child of n.children) walk(child);
    }
  };
  walk(node);
  return { openCount, closeCount };
}

function stripTrailingClosingQuote(node: any, paragraph: any, open: string, closing: string): void {
  const last = paragraph.children?.[paragraph.children.length - 1];
  if (!last || last.type !== 'text' || typeof last.value !== 'string') return;
  const trimmed = last.value.replace(/\s+$/, '');
  if (!trimmed.endsWith(closing)) return;

  const { openCount, closeCount } = countQuotesInNode(node, open, closing);
  // Symmetric quotes match by odd remaining count; asymmetric pairs match when closing count exceeds opening count.
  const hasUnpairedTrailingClose = open === closing ? closeCount % 2 === 1 : closeCount > openCount;
  if (!hasUnpairedTrailingClose) return;

  last.value = trimmed.slice(0, -1);
}

function cleanAlertTitle(raw: string): string {
  let t = stripWrappingQuotes(raw.trim());
  if (!/^["“”'‘’]/.test(t)) {
    t = t.replace(/["“”'‘’]+$/, '');
  }
  return t.trim();
}

export function normalizeTitleForMatch(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(/["“”‘’'「」『』]/g, '')
    .replace(/[*_~`#]+/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

interface ExtractedGfmAlert {
  alertType: string;
  title: string;
  firstParagraph: any;
}

// Split explicit alert title only at newline/paragraph boundaries so inline code spans never get severed into the Callout title.
function extractGfmAlert(node: any): ExtractedGfmAlert | null {
  const first: any = node.children?.[0];
  if (!first || first.type !== 'paragraph') return null;

  const firstText: any = first.children?.[0];
  if (!firstText || firstText.type !== 'text' || typeof firstText.value !== 'string') return null;

  const marker = GFM_ALERT_MARKER_RE.exec(firstText.value);
  if (!marker) return null;

  const alertType = GFM_ALERT_TYPE_MAP[marker[2].toLowerCase()];
  if (!alertType) return null;

  const afterMarker = firstText.value.slice(marker[0].length);
  let title = '';
  let rest = afterMarker;

  if (afterMarker.startsWith('\n')) {
    rest = afterMarker.replace(/^\n+/, '');
  } else {
    const nlIdx = afterMarker.indexOf('\n');
    if (nlIdx >= 0) {
      title = cleanAlertTitle(afterMarker.slice(0, nlIdx));
      rest = afterMarker.slice(nlIdx + 1).replace(/^\n+/, '');
    } else if (node.children.length > 1 && first.children.length === 1) {
      title = cleanAlertTitle(afterMarker);
      rest = '';
    }
  }

  if (rest.trim()) {
    firstText.value = rest;
  } else {
    first.children.shift();
    if (first.children.length === 0) {
      node.children.shift();
    }
  }

  const open = marker[1] ?? '';
  const closing = open ? closingQuoteFor(open) : '';
  if (closing) {
    const lastParagraph = node.children[node.children.length - 1];
    if (lastParagraph && lastParagraph.type === 'paragraph') {
      stripTrailingClosingQuote(node, lastParagraph, open, closing);
    }
  }

  return { alertType, title, firstParagraph: node.children?.[0] };
}

export function remarkGfmAlerts() {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: any) => {
      const extracted = extractGfmAlert(node);
      if (!extracted) return;

      node.type = 'mdxJsxFlowElement';
      node.name = 'Callout';
      node.attributes = [
        { type: 'mdxJsxAttribute', name: 'type', value: extracted.alertType },
        ...(extracted.title ? [{ type: 'mdxJsxAttribute' as const, name: 'title', value: extracted.title }] : []),
      ];
    });
  };
}

export function remarkGfmAlertsPlain() {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: any) => {
      const extracted = extractGfmAlert(node);
      if (!extracted) return;

      if (extracted.title && extracted.firstParagraph?.type === 'paragraph') {
        extracted.firstParagraph.children.unshift(
          { type: 'strong', children: [{ type: 'text', value: extracted.title }] },
          { type: 'text', value: ' ' },
        );
      }
      node.data = { ...(node.data ?? {}), hProperties: { className: ['gfm-alert', `gfm-alert-${extracted.alertType}`] } };
    });
  };
}

// Stripping leading H1 is gated upstream (:h1s variant); ignores frontmatter and preserves subsequent H1s.
export function remarkStripLeadingTitle() {
  return (tree: Root) => {
    const children = tree.children as any[];
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node.type === 'yaml' || node.type === 'toml') continue;
      if (node.type === 'heading' && node.depth === 1) {
        children.splice(i, 1);
      }
      return;
    }
  };
}

function normalizeDeepDiveBlock(node: any): boolean {
  if (
    node?.type !== 'mdxJsxFlowElement' ||
    node.name !== 'details' ||
    !Array.isArray(node.attributes)
  ) {
    return false;
  }
  const layerAttr = node.attributes.find(
    (attr: any) =>
      attr?.type === 'mdxJsxAttribute' &&
      attr.name === DEEP_DIVE_LAYER_ATTRIBUTE &&
      isDeepDiveLayerValue(String(attr.value ?? '')),
  );
  if (!layerAttr) return false;
  layerAttr.value = DEEP_DIVE_LAYER_VALUE;
  return true;
}

function normalizeDeepDiveSummary(detailsNode: any): void {
  if (!Array.isArray(detailsNode.children)) return;
  for (const child of detailsNode.children) {
    if (
      (child?.type !== 'mdxJsxFlowElement' && child?.type !== 'mdxJsxTextElement') ||
      child.name !== 'summary' ||
      !Array.isArray(child.children)
    ) {
      continue;
    }
    const first = child.children[0];
    if (first?.type === 'text' && typeof first.value === 'string') {
      first.value = stripDeepDiveSummaryPrefix(first.value);
    } else if (
      first?.type === 'paragraph' &&
      Array.isArray(first.children) &&
      first.children[0]?.type === 'text' &&
      typeof first.children[0].value === 'string'
    ) {
      first.children[0].value = stripDeepDiveSummaryPrefix(first.children[0].value);
    }
    break;
  }
}

function demoteHeadingsInside(node: any): void {
  if (!Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!child || typeof child !== 'object') continue;
    if (child.type === 'heading') {
      node.children[i] = {
        type: 'paragraph',
        children: [{ type: 'strong', children: Array.isArray(child.children) ? child.children : [] }],
      };
      continue;
    }
    demoteHeadingsInside(child);
  }
}

// Runs before TOC collection so demoted headings inside collapsed deep-dive blocks never leak into TOC.
export function remarkDeepDiveHygiene() {
  // file is optional when invoked on bare mdast outside unified.
  return (tree: Root, file?: { data: Record<string, unknown> }) => {
    let deepDiveCount = 0;
    visit(tree, (node: any) => {
      if (!normalizeDeepDiveBlock(node)) return;
      deepDiveCount++;
      normalizeDeepDiveSummary(node);
      demoteHeadingsInside(node);
    });
    if (file) file.data.deepDiveCount = deepDiveCount;
  };
}
