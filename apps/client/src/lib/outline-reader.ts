import { MODULE_ROLE_PATTERNS } from '@/engine/language-map';
import type { NavNode } from '@/engine/structurizer';

/**
 * ─────────────────────────────────────────────────────────────
 * 大纲读取器 (Outline Reader)
 *
 * Phase 3 数据驱动切换的统一取数入口:教程侧边栏 / 内容页 / 重编排工具
 * 都通过 getActiveOutline 读当前激活的 TutorialOutline(编排层),
 * 不再各自散装查询。
 *
 * 切换策略(数据驱动,无 feature flag):
 *   - 有 isActive=true 的 outline → 走 V2 渲染(大类 > 章 > 节)
 *   - 无(老仓库 / hybrid 合并编排未就绪)→ fallback V1 navTree
 *
 * OutlineNode 是"编排指针"(REPO_INGEST_REDESIGN §10.5):只存
 * documentId + headingPath,内容在 Document/DocumentChunk。读取时
 * join Document 拿 path,供侧边栏 URL 与阅读进度指纹使用。
 * ─────────────────────────────────────────────────────────────
 */

/** 节视图:编排指针 + 关联 Document 的读取信息 */
export interface OutlineNodeView {
  id: string;
  title: string;
  nodeType: string; // 'doc' | 'code'
  headingPath: string | null;
  documentId: string | null;
  /** Document.path(documentId 命中且文档存在时非 null;否则 null → 渲染时跳过该节) */
  docPath: string | null;
  docStatus: string | null;
}

/** 章视图(教学单元) */
export interface OutlineChapterView {
  id: string;
  title: string;
  summary: string | null;
  chapterType: string; // 'doc' | 'code' | 'mixed'
  moduleName?: string | null;
  teachingOrder: number;
  nodes: OutlineNodeView[];
}

/** 大类视图(可选:章数 > 6 才聚合) */
export interface OutlinePartView {
  id: string;
  title: string;
  summary: string | null;
  teachingOrder: number;
  chapters: OutlineChapterView[];
}

/** 激活大纲的整体视图(一套编排) */
export interface OutlineView {
  outlineId: string;
  version: number;
  mode: string;
  /** 有归属大类的章(按 teachingOrder) */
  parts: OutlinePartView[];
  /** 无大类(partId null)的章,直接挂 outline 顶层 */
  chapters: OutlineChapterView[];
}

/**
 * 读取仓库当前激活的编排大纲。
 * @returns 无激活大纲时返回 null(调用方 fallback V1 navTree)
 *
 * 读侧 TTL 缓存（unstable_cache，60s）：大纲是 5 层嵌套 include 的重查询，
 * 消费方（页面/侧边栏/layout）全是读侧渲染；挂 per-repo tag 供大纲切换/导入
 * 后主动失效（api/internal/revalidate 统一收敛口），60s 时间窗仅作兜底——
 * 避免 L1 失效重建时从本层读回旧大纲、把陈旧窗口叠加到 ~120s。
 */
export const outlineActiveCacheTag = (repositoryId: string): string => `outline-active:${repositoryId}`;

export async function getActiveOutline(repositoryId: string): Promise<OutlineView | null> {
  const { getWebL1OutlineProjectionById } = await import('@/lib/docs/web-outline-projection');
  const l1Proj = await getWebL1OutlineProjectionById(repositoryId);
  if (l1Proj?.outline && l1Proj.outline.outlineId) {
    return l1Proj.outline;
  }

  const { unstable_cache } = await import('next/cache');
  const { ENGINE_CONFIG } = await import('@/lib/config');
  const cached = unstable_cache(
    () => buildActiveOutline(repositoryId),
    ['outline-active', repositoryId],
    {
      revalidate: ENGINE_CONFIG.docsRead.outlineCacheTtlSeconds,
      tags: [outlineActiveCacheTag(repositoryId)],
    },
  );
  return cached().catch((err: unknown) => {
    // 缓存基础设施故障回落直查（不阻塞渲染；与 MDXCache 同契约）
    console.warn('[OutlineReader] cache read failed, querying directly:', err);
    return buildActiveOutline(repositoryId);
  });
}

async function buildActiveOutline(repositoryId: string): Promise<OutlineView | null> {
  const { callSidecar } = await import('@/lib/sidecar-client');
  try {
    const res = await callSidecar<{ ok: boolean; outline: OutlineView | null }>(
      '/v1/outline/active',
      { repositoryId },
      { label: 'outline-reader /v1/outline/active', timeoutMs: 5_000 }
    );
    return res.outline ?? null;
  } catch (err) {
    console.warn('[OutlineReader] sidecar outline read failed:', err);
    return null;
  }
}

/** 全部章按教学顺序展平(大类内的章与无大类的章混排) */
export function allChaptersInTeachingOrder(outline: OutlineView): OutlineChapterView[] {
  return [...(outline.chapters || []), ...(outline.parts || []).flatMap((p) => p.chapters || [])].sort(
    (a, b) => a.teachingOrder - b.teachingOrder,
  );
}

const ALL_DOC_EXTENSIONS = ['.md', '.mdx', '.markdown', '.rst', '.adoc', '.tex', '.txt'];

/** Document.path → 教程页 URL slug(去文档扩展名; 优先全量技术文档扩展名集合；容忍空值返回空串) */
export function docPathToSlug(docPath?: string | null): string {
  if (!docPath) return '';
  const lower = docPath.toLowerCase();
  for (const ext of ALL_DOC_EXTENSIONS) {
    if (lower.endsWith(ext)) return docPath.slice(0, -ext.length);
  }
  for (const ext of MODULE_ROLE_PATTERNS.markdownExtensions) {
    if (lower.endsWith(ext)) return docPath.slice(0, -ext.length);
  }
  return docPath;
}

/**
 * 节的教程页 URL。
 * docPath 缺失(编排时 Document 未建)时返回空串,渲染方跳过该节。
 * 根目录主文档（index / README）在 Next.js App Router 下统一收敛至仓根路径，避免 /index 循环重定向。
 */
export function outlineNodeUrl(owner: string, repo: string, docPath: string | null): string {
  if (!docPath) return '';
  const slug = docPathToSlug(docPath);
  if (!slug || slug.toLowerCase() === 'index' || slug.toLowerCase() === 'readme') {
    return `/docs/${owner}/${repo}`;
  }
  return `/docs/${owner}/${repo}/${slug}`;
}

/** 在激活大纲中按 URL slug(相对仓库,无扩展名)反查文档路径;找不到返回 null。 */
export function resolveDocPathFromOutline(outline: OutlineView, rawPath: string): string | null {
  const target = rawPath.replace(/^\/+|\/+$/g, '');
  const isRootTarget = !target || target.toLowerCase() === 'index' || target.toLowerCase() === 'readme';
  for (const ch of allChaptersInTeachingOrder(outline)) {
    for (const n of ch.nodes) {
      if (!n.docPath) continue;
      const slug = docPathToSlug(n.docPath).replace(/^\/+|\/+$/g, '');
      if (slug === target) return n.docPath;
      if (isRootTarget && (slug.toLowerCase() === 'index' || slug.toLowerCase() === 'readme')) {
        return n.docPath;
      }
    }
  }
  return null;
}

/** 大纲第一个可跳转的节(按教学顺序);大纲无可跳转节时返回 null。 */
export function firstNavigableNode(outline: OutlineView): OutlineNodeView | null {
  for (const ch of allChaptersInTeachingOrder(outline)) {
    for (const n of ch.nodes) {
      if (n.docPath) return n;
    }
  }
  return null;
}

export interface AdjacentOutlineNodes {
  prev: OutlineNodeView | null;
  next: OutlineNodeView | null;
}

/** 教学顺序上当前节的前驱/后继（正文页底部 prev/next 导航的数据源）。
 *  按 docPath 匹配；不可跳转节点（无 docPath）不参与序列。 */
export function adjacentNavigableNodes(outline: OutlineView, currentDocPath: string): AdjacentOutlineNodes {
  const sequence: OutlineNodeView[] = [];
  for (const ch of allChaptersInTeachingOrder(outline)) {
    for (const n of ch.nodes) {
      if (n.docPath) sequence.push(n);
    }
  }
  const index = sequence.findIndex((n) => n.docPath === currentDocPath);
  if (index === -1) return { prev: null, next: null };
  return {
    prev: index > 0 ? sequence[index - 1] : null,
    next: index < sequence.length - 1 ? sequence[index + 1] : null,
  };
}

// ─────────────────────────────────────────────────────────────
// 教学顺序解析（大纲双轨收敛的统一读入口）
//
// 教学结构只有一个事实源：V2 TutorialOutline（isActive）。V1 navTree 是
// 存量兼容读视图——全仓唯一的 V2→V1 兜底发生在这里，消费方（概念边
// curriculum_order、course-map、后续迁移点）禁止再各自内联展平与兜底。
// 后续阶段写入单源化后，navTree 将降级为纯投影，此处兜底随之消失。
// ─────────────────────────────────────────────────────────────

/** V1 navTree 展平条目（file 节点的 path + 显示名，深度优先、按树序） */
export interface NavTreeEntry {
  path: string;
  title: string;
}

/**
 * V1 navTree 深度优先展平（file 节点收集，directory 递归）。
 * 唯一实现处：edge-sync / course-map 等历史本地克隆一律改为引用此函数。
 */
export function flattenNavTreeEntries(
  nodes: NavNode[] | undefined | null,
  out: NavTreeEntry[] = []
): NavTreeEntry[] {
  for (const node of nodes || []) {
    if (node.type === 'file') {
      out.push({ path: node.path, title: node.shortTitle || node.title || node.path });
    } else if (node.children) {
      flattenNavTreeEntries(node.children, out);
    }
  }
  return out;
}

/** V1 navTree 展平为文件路径序列（flattenNavTreeEntries 的路径投影；仅供本模块 resolveTeachingDocPaths 兜底消费） */
function flattenNavTreeFiles(nodes: NavNode[] | undefined | null): string[] {
  return flattenNavTreeEntries(nodes).map((e) => e.path);
}

/** V2 激活大纲 → 教学顺序文档路径（大类>章>节按 teachingOrder，docPath 去重保序） */
export function outlineTeachingDocPaths(outline: OutlineView): string[] {
  const paths: string[] = [];
  for (const ch of allChaptersInTeachingOrder(outline)) {
    for (const n of ch.nodes) {
      if (n.docPath && !paths.includes(n.docPath)) paths.push(n.docPath);
    }
  }
  return paths;
}

/**
 * 教学顺序文档路径解析（全仓唯一 V2→V1 兜底）：
 * 1. V2 TutorialOutline（isActive）按教学顺序展平；
 * 2. 无激活大纲（存量老仓库）→ 兜底 V1 navTree 深度优先；
 * 3. 两者皆无 → 返回 []（调用方自行按 createdAt 等业务顺序兜底）。
 * 读取失败静默降级到 V1，不向调用方抛错。
 */
export async function resolveTeachingDocPaths(
  repositoryId: string,
  fallbackNavTree?: unknown
): Promise<string[]> {
  try {
    const outline = await getActiveOutline(repositoryId);
    if (outline) {
      const paths = outlineTeachingDocPaths(outline);
      if (paths.length > 0) return paths;
    }
  } catch (err) {
    console.warn('[outline-reader] Failed to read active outline for teaching order:', err);
  }

  if (fallbackNavTree !== undefined) {
    return flattenNavTreeFiles((fallbackNavTree as NavNode[] | null) || undefined);
  }

  try {
    const { prisma } = await import('@/lib/db');
    if (typeof prisma.repository?.findUnique === 'function') {
      const repo = await prisma.repository.findUnique({
        where: { id: repositoryId },
        select: { navTree: true },
      });
      return flattenNavTreeFiles((repo?.navTree as NavNode[] | null) || undefined);
    }
  } catch (err) {
    console.warn('[outline-reader] Failed to read repository navTree for teaching order fallback:', err);
    return [];
  }
  return [];
}
