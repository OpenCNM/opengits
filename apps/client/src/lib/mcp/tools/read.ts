/**
 * repo-tools read 域：read 纯粹内容读取原语（第一性原理）。
 * 职责：按目标单一获取正文或章节切片，
 * 智能识别路径与 Address 锚点，
 * 安全截断超长文本，按需注入图谱位置与在线 URL。
 */
import { prisma } from '@/lib/db';
import { parseSectionAddress } from '@/lib/mcp/section-address';
import { buildGraphPositionText } from '@/lib/mcp/concept-graph';
import { isWebDocRepository, resolveDocLiveUrl } from '@/lib/repository-resolver';
import { MCP_DOC_FULL_MAX_CHARS } from '@/lib/constants';
import { applyContentLayerRead } from '@/lib/content-addressing';
import {
  RepoRuntime,
  resolveScopedTarget,
  refNotFoundError,
  scopeRequiredError,
  fallbackWarning,
} from './shared';
import { findDocInContext } from './outline';
import { projectProvenanceBeacon } from '@/lib/mcp/grounding-beacon';

/** 文档全文输出上限：超长时截断并引导分段读取，防止灌爆 Agent 上下文 */
export function capFullDocText(text: string): string {
  if (!text || text.length <= MCP_DOC_FULL_MAX_CHARS) return text;
  return `${text.slice(0, MCP_DOC_FULL_MAX_CHARS)}\n\n---\n\n... [Truncated for context limit. Use outline for the table of contents, or pass target with an Address (path#heading) to read a specific section.]`;
}

/**
 * MCP 读路径正文懒加载：按文档 id 单篇取正文。
 * 走 applyContentLayerRead 统一切换，内容寻址 READS 开启时以内容层覆盖 legacy 列。
 */
export async function fetchDocumentContent(
  repositoryId: string,
  docId: string,
  userId?: string | null
): Promise<string | null> {
  const doc = await prisma.document
    .findFirst({
      where: {
        id: docId,
        repositoryId,
        status: 'PROCESSED',
        ...(userId ? { OR: [{ ownerUserId: null }, { ownerUserId: userId }] } : { ownerUserId: null }),
      },
      select: { content: true, contentId: true, contentRef: { select: { content: true } } },
    })
    .catch(() => null);
  if (!doc) return null;
  return applyContentLayerRead(doc).content ?? null;
}

export interface ReadArgs {
  repository?: string;
  target?: string;
  path?: string;
  edition?: string;
  aspect?: 'full' | 'architecture' | 'contract';
}

/**
 * 核心原语：runRead
 * - target 支持纯文档路径（如 "docs/getting-started.md"）
 * - target 支持带锚点的 Address（如 "docs/getting-started.md#Installation"）
 * - path 作为 target 的等价别名兼容（智能体直觉入参兼容）
 */
export async function runRead(
  args: ReadArgs,
  runtime: RepoRuntime,
  telemetryRepositoryId?: string
) {
  const startTime = Date.now();
  // Hub 模式支持 "owner/repo@edition" 精确讲法（args.edition 与 repository 组合；单仓模式由端点 ?edition= 钉死）
  const scopedRef = args.repository && args.edition ? `${args.repository}@${args.edition}` : args.repository;
  const ctx = await resolveScopedTarget(runtime, scopedRef);
  if (!ctx) {
    return scopedRef ? refNotFoundError(scopedRef, runtime) : scopeRequiredError(runtime);
  }
  const fbWarn = fallbackWarning(ctx);

  const rawTarget = (args.target || args.path || '').trim();
  if (!rawTarget) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: "target" is required. Pass a document path (e.g. "README.md") or section address (e.g. "README.md#Usage"). Use outline to see available documents.`,
        },
      ],
      isError: true,
    };
  }

  const { docPath, headingPath } = parseSectionAddress(rawTarget);
  const doc = findDocInContext(ctx, docPath);

  if (!doc) {
    
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: Document "${docPath}" not found in ${ctx.owner}/${ctx.repo}. Call outline to view valid document paths.`,
        },
      ],
      isError: true,
      telemetry: { dimension: 'documents', query: rawTarget, resultCount: 0 }};
  }

  const isWeb = isWebDocRepository(ctx.repository);
  const profile = (ctx.repository.repoProfile && typeof ctx.repository.repoProfile === 'object'
    ? ctx.repository.repoProfile
    : {}) as Record<string, unknown>;
  const liveUrl = isWeb
    ? resolveDocLiveUrl(ctx.repository.navTree, doc.path, (profile.originalUrl as string) || null)
    : null;
  const liveUrlLine = liveUrl ? `Live URL: ${liveUrl}\n` : '';

  // ── 模式 A：读取指定章节锚点 (Section Address) ──
  if (headingPath) {
    const chunks = await prisma.documentChunk
      .findMany({
        // 内容寻址收官：新文档切片挂 contentId（documentId 维度已被停写清空），旧存量回落 documentId
        where: doc.contentId ? { contentId: doc.contentId } : { documentId: doc.id },
        select: { heading: true, headingPath: true, content: true, semVerLabel: true },
        orderBy: { id: 'asc' },
      })
      .catch(() => []);

    let targetChunk: {
      heading: string | null;
      headingPath: string | null;
      content: string;
      semVerLabel: string | null;
    } | null = null;

    const exactMatches = chunks.filter(
      (c) =>
        (c.headingPath || '').trim() === headingPath ||
        (c.heading || '').trim() === headingPath
    );
    if (exactMatches.length > 0) {
      targetChunk =
        exactMatches.find((c) => c.semVerLabel === ctx.targetVersionLabel) || exactMatches[0];
    } else {
      targetChunk = chunks.find((c) => (c.headingPath || '').includes(headingPath)) || null;
    }

    // 图位置注入：当前 section 所属概念 + 直接邻居
    const graphPos = await buildGraphPositionText(ctx.repository.id, doc.id, headingPath);

    

    if (!targetChunk) {
      // 锚点未匹配到单 chunk 时退回全篇正文
      const fullContent = (await fetchDocumentContent(ctx.repository.id, doc.id, runtime.userId)) || '';
      const filtered = filterDocByAspect(fullContent, args.aspect);
      const beacon = projectProvenanceBeacon({
        content: fullContent,
        docPath: doc.path,
        repository: ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo}` : args.repository,
        gitSha: ctx.repository.gitSha || ctx.repository.branch || null,
        isMultiRepo: runtime.multiRepo,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `${fbWarn}${graphPos}# ${doc.title || doc.path}\nSource Path: ${doc.path}\n${liveUrlLine}${capFullDocText(filtered).trimEnd()}\n\n${beacon}`,
          },
        ],
        telemetry: { dimension: 'documents', query: rawTarget, resultCount: 1, resultSnapshot: { count: 1, items: [{ path: doc.path, title: doc.title || doc.path }] } }};
    }

    const filtered = filterDocByAspect(targetChunk.content, args.aspect);
    // 版本归因：命中的 chunk 版本标签与请求目标不一致（含多版本 chunk 兜底取首个）时显式标注
    const versionLine =
      targetChunk.semVerLabel && targetChunk.semVerLabel !== ctx.targetVersionLabel
        ? `Version: ${targetChunk.semVerLabel}\n`
        : '';
    const beacon = projectProvenanceBeacon({
      content: targetChunk.content,
      docPath: doc.path,
      repository: ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo}` : args.repository,
      gitSha: ctx.repository.gitSha || ctx.repository.branch || null,
      isMultiRepo: runtime.multiRepo,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `${fbWarn}${graphPos}# ${doc.title || doc.path}\nSource Path: ${doc.path}\n${liveUrlLine}Section: ${targetChunk.heading || headingPath}\n${versionLine}\n${capFullDocText(filtered).trimEnd()}\n\n${beacon}`,
        },
      ],
    };
  }

  // ── 模式 B：读取全篇文档 ──
  const docContent = await fetchDocumentContent(ctx.repository.id, doc.id, runtime.userId);
  if (!docContent) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: Document "${docPath}" has no readable content.`,
        },
      ],
      isError: true,
    };
  }

  

  const filtered = filterDocByAspect(docContent, args.aspect);
  const beacon = projectProvenanceBeacon({
    content: docContent,
    docPath: doc.path,
    repository: ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo}` : args.repository,
    gitSha: ctx.repository.gitSha || ctx.repository.branch || null,
    isMultiRepo: runtime.multiRepo,
  });
  return {
    content: [
      {
        type: 'text' as const,
        text: `${fbWarn}# ${doc.title || doc.path}\nSource Path: ${doc.path}\n${liveUrlLine}\n${capFullDocText(filtered).trimEnd()}\n\n${beacon}`,
      },
    ],
    telemetry: { dimension: 'documents', query: rawTarget, resultCount: 1, tokensReturned: Math.floor(docContent.length / 4), resultSnapshot: { count: 1, items: [{ path: doc.path, title: doc.title || doc.path }] } }};
}

/**
 * filterDocByAspect: 按认知梯度 (full / architecture / contract) 过滤文档正文。
 */
export function filterDocByAspect(text: string, aspect?: string): string {
  const norm = (aspect || 'full').trim().toLowerCase();
  if (norm === 'architecture') {
    const lines = text.split('\n');
    const out: string[] = [];
    let inCodeBlock = false;
    let isMermaid = false;
    let codeBlockLines: string[] = [];
    let codeBlockLang = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockLang = trimmed.replace(/^[`~]+/, '').trim();
          isMermaid = codeBlockLang.toLowerCase() === 'mermaid';
          codeBlockLines = [line];
        } else {
          inCodeBlock = false;
          codeBlockLines.push(line);
          if (isMermaid || codeBlockLines.length <= 6) {
            out.push(...codeBlockLines);
          } else {
            out.push('```' + codeBlockLang);
            out.push(`// [Code implementation omitted in architecture mode (${codeBlockLines.length - 2} lines). Pass aspect="full" or use read_symbol to view code.]`);
            out.push('```');
          }
          codeBlockLines = [];
          isMermaid = false;
          codeBlockLang = '';
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockLines.push(line);
      } else {
        out.push(line);
      }
    }
    if (inCodeBlock && codeBlockLines.length > 0) {
      out.push(...codeBlockLines);
    }
    return out.join('\n');
  }

  if (norm === 'contract') {
    const lines = text.split('\n');
    const out: string[] = [];
    let inCodeBlock = false;
    let inTable = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        out.push(line);
        continue;
      }
      if (trimmed.startsWith('|')) {
        inTable = true;
        out.push(line);
        continue;
      } else if (inTable) {
        inTable = false;
        out.push('');
      }
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        inCodeBlock = !inCodeBlock;
        out.push(line);
        continue;
      }
      if (inCodeBlock) {
        out.push(line);
        continue;
      }
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        if (trimmed.includes('`') || trimmed.includes(':')) {
          out.push(line);
        }
      }
    }
    return out.join('\n');
  }

  return text;
}
