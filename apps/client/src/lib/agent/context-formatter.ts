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

/**
 * 计算单个文档 Chunk 的认知预算配额（按排名非对称衰减）
 */
function computeChunkTokenBudget(rank: number, remainingBudget: number): number {
  if (remainingBudget <= 0) return 0;

  let maxQuota = 350;
  if (rank === 0) {
    maxQuota = 800; // Top-1 给予最高预算（充沛上下文）
  } else if (rank === 1) {
    maxQuota = 500; // Top-2 给予中等预算
  }

  return Math.min(maxQuota, remainingBudget);
}

/**
 * 格式化文档相对 Web URL
 */
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

/**
 * 高密度代码锚点与检索上下文 CDC 契约格式化器
 *
 * 遵循认知预算守恒与消费者驱动契约 (CDC)：
 * 1. 注入物理事实 SectionAddress (file#heading) 与 Web URL，杜绝 LLM 编造跳转锚点；
 * 2. 梯形非对称 Token 预算分配（Top 1 丰富，Top N 紧凑，超限优雅熔断）；
 * 3. 严格使用 truncateCognitiveBudget 确保截断处的代码围栏 100% 自愈闭合。
 */
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

    // 若不是第一篇且剩余预算不足以容纳标头与核心内容，优雅熔断停止后续低分条目
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

    // 1. 构建高密度标准契约标头
    const cleanAddress = buildCleanSectionAddress(d.path, d.headingPath || d.heading);
    const scorePct = typeof d.similarity === 'number' ? `${(d.similarity * 100).toFixed(0)}%` : 'N/A';
    const webUrl = formatDocWebUrl(d.path, owner, repo, d.heading);
    const title = d.title || d.path;

    const metaLine = `[ANCHOR: ${cleanAddress} | SCORE: ${scorePct}] ${title}`;
    const urlLine = `URL: ${webUrl}`;

    // 2. 认知预算截断与代码围栏自愈
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
