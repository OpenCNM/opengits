import { ChunkSearchResult } from '@/lib/mcp/doc-search';
import { buildCleanSectionAddress } from '@/lib/mcp/section-address';
import { truncateCognitiveBudget } from './semantic-truncator';
import { estimateTokens } from '@/lib/token-counter';
import { slugify } from '@/lib/wasm/binary-search-engine';

export interface FormatDocContextOptions {
  totalTokenBudget?: number;
  owner?: string;
  repo?: string;
  header?: string;
}

export const DEFAULT_CONTEXT_TOTAL_TOKEN_BUDGET = 2000;
export const DEFAULT_DOC_CONTEXT_HEADER = '=== RELEVANT TUTORIAL DOCS ===';

function computeChunkTokenBudget(rank: number, remainingBudget: number): number {
  if (remainingBudget <= 0) return 0;

  let maxQuota = 350;
  if (rank === 0) {
    maxQuota = 800;
  } else if (rank === 1) {
    maxQuota = 500;
  }

  return Math.min(maxQuota, remainingBudget);
}

function formatDocWebUrl(path: string, owner?: string, repo?: string, heading?: string | null): string {
  const cleanPath = (path || '').replace(/\.mdx?$/, '').replace(/^docs\//, '');
  const basePrefix = owner && repo ? `/docs/${owner}/${repo}` : '/docs';
  let url = `${basePrefix}/${cleanPath}`;

  if (heading) {
    const slugAnchor = slugify(heading);
    if (slugAnchor) {
      url += `#${slugAnchor}`;
    }
  }

  return url;
}

export function formatHighDensityDocContext(
  docs: ChunkSearchResult[],
  options: FormatDocContextOptions = {}
): string {
  if (!Array.isArray(docs) || docs.length === 0) {
    return '';
  }

  const {
    totalTokenBudget = DEFAULT_CONTEXT_TOTAL_TOKEN_BUDGET,
    owner = '',
    repo = '',
    header = DEFAULT_DOC_CONTEXT_HEADER,
  } = options;

  let contextStr = `${header}\n`;
  let usedTokens = estimateTokens(contextStr);

  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const remainingBudget = totalTokenBudget - usedTokens;

    if (i > 0 && remainingBudget < 40) {
      break;
    }
    if (remainingBudget < 20) {
      break;
    }

    const chunkBudget = computeChunkTokenBudget(i, remainingBudget);
    if (chunkBudget <= 20) {
      break;
    }

    const cleanAddress = buildCleanSectionAddress(d.path, d.headingPath || d.heading);
    const scorePct = typeof d.similarity === 'number' ? `${(d.similarity * 100).toFixed(0)}%` : 'N/A';
    const webUrl = formatDocWebUrl(d.path, owner, repo, d.heading);
    const title = d.title || d.path;

    const metaLine = `[ANCHOR: ${cleanAddress} | SCORE: ${scorePct}] ${title}`;
    const urlLine = `URL: ${webUrl}`;

    const rawContent = (d.content || '').trim();
    const metaTokens = estimateTokens(`${metaLine}\n${urlLine}\n\n`);
    const contentTokenBudget = Math.max(20, chunkBudget - metaTokens);

    const truncated = truncateCognitiveBudget(rawContent, {
      maxTokens: contentTokenBudget,
      suffix: '\n... [Section content truncated]',
    });

    const blockStr = `${metaLine}\n${urlLine}\n${truncated.text}\n\n`;
    contextStr += blockStr;
    usedTokens += estimateTokens(blockStr);
  }

  return contextStr.trimEnd() + '\n\n';
}
