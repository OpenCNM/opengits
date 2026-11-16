import { z } from 'zod';
import { trackTokenUsage, generateStructured } from '../ai';
import { GitHubNode } from '@/engine/repo-sniffer';
import { buildDirectoryTopologySummary } from '@/engine/ai-repo-sniffer';
import { MODULE_ROLE_PATTERNS } from '@/engine/language-map';
import { chapterDocPath } from '@/lib/constants';
import { PromptRegistry } from '@/lib/prompt-registry';

/**
 * ─────────────────────────────────────────────────────────────
 * 教程编排器原型 (Ingest Orchestrator)
 *
 * 验证核心假设:LLM 能否把仓库文件编排成比现有双引擎更好的
 * 教程大纲(节→章→大类)?
 *
 * 设计(见 REPO_INGEST_REDESIGN §4 / §9):
 * - 输入:目录拓扑摘要(复用 buildDirectoryTopologySummary)+ 可选文件头采样
 * - 输出:章节大纲 OutlineDraft(节→章→大类,§10 数据模型的原型简化版)
 * - 纯函数,不接入导入管线,零生产风险(Phase 1)
 * - 编排可逆:大纲只是"指针结构",不产内容
 *
 * 与 aiSniffRepo 的区别:它不是给仓库贴类型标签(分类器),
 * 而是产出完整章节大纲(编排器)。LLM 判断"怎么编排"而非"走哪条路"。
 * ─────────────────────────────────────────────────────────────
 */

/** 输出 schema(全字段 .catch() 容错:qwen 输出漂移静默回退,不打回 null —— 与 aiSniffRepo 同策略) */
export const outlineDraftSchema = z.object({
  // 大类(可选:章数 > 6 才聚合;≤ 6 不分,parts 为空数组)
  parts: z.array(
    z.object({
      title: z.string().catch(''),
      summary: z.string().optional().catch(undefined),
      teachingOrder: z.number().catch(0),
    })
  ).catch([]),
  chapters: z.array(
    z.object({
      title: z.string().catch(''),
      summary: z.string().optional().catch(undefined),
      chapterType: z.enum(['doc', 'code', 'mixed']).catch('mixed'),
      teachingOrder: z.number().catch(0),
      // 归属大类(可选:未分大类时省略)
      partTitle: z.string().optional().catch(undefined),
      // 节(编排最细单元):只记录来源文件 + 标题,不存内容
      nodes: z.array(
        z.object({
          sourcePath: z.string().catch(''),
          title: z.string().catch(''),
          nodeType: z.enum(['doc', 'code']).catch('doc'),
        })
      ).catch([]),
    })
  ).catch([]),
});

export type OutlineChapter = {
  title: string;
  summary?: string;
  chapterType: 'doc' | 'code' | 'mixed';
  teachingOrder: number;
  partTitle?: string;
  nodes: { sourcePath: string; title: string; nodeType: 'doc' | 'code' }[];
};

export interface OutlineDraft {
  parts: { title: string; summary?: string; teachingOrder: number }[];
  chapters: OutlineChapter[];
}

/** 校验产出大纲的最小合法性:非空章、每章有节、章有标题。不合法返回 null(调用方降级)。 */
export function isOutlineDraftValid(draft: OutlineDraft): boolean {
  if (!draft || draft.chapters.length === 0) return false;
  if (draft.chapters.some((c) => !c.title || !c.nodes || c.nodes.length === 0)) return false;
  return true;
}

/**
 * post-process ⓪:删除 LLM 编造的不存在路径。
 * LLM 可能"猜"出输入文件树里没有的路径(如根据 main.ts 推断 root/config.ts)。
 * 双向保证:draft 里的 sourcePath 必须存在于输入 nodes,编造的删掉。
 */
function pruneHallucinatedPaths(draft: OutlineDraft, nodes: GitHubNode[]): void {
  const inputPaths = new Set(nodes.filter((n) => n.type === 'blob').map((n) => n.path));
  for (const ch of draft.chapters) {
    ch.nodes = ch.nodes.filter((n) => inputPaths.has(n.sourcePath));
  }
  // 删除因 prune 变空的章
  draft.chapters = draft.chapters.filter((ch) => ch.nodes.length > 0);
}

/**
 * post-process ①:文件覆盖兜底。
 * LLM 在文件多 / 结构混乱时可能漏文件(违反 prompt 的 "do not drop files")。
 * 这里代码保证不漏:先尝试按父目录并入已有章(同目录文件归同章),
 * 无法归类的放「Supplementary」章。不依赖 prompt,确定性兜底。
 */
function ensureFullCoverage(draft: OutlineDraft, nodes: GitHubNode[]): void {
  const inputPaths = new Set(
    nodes.filter((n) => n.type === 'blob').map((n) => n.path),
  );
  const covered = new Set<string>();
  for (const ch of draft.chapters) {
    for (const node of ch.nodes) covered.add(node.sourcePath);
  }
  const uncovered = [...inputPaths].filter((p) => !covered.has(p));
  if (uncovered.length === 0) return;

  const MAX_CHAPTER_NODES = 12;
  const orphans: { sourcePath: string; title: string; nodeType: 'doc' | 'code'; parentDir: string }[] = [];
  for (const p of uncovered) {
    const parentDir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
    const isDoc = MODULE_ROLE_PATTERNS.markdownExtensions.some((ext) => p.endsWith(ext));
    const nodeData = {
      sourcePath: p,
      title: p.split('/').pop()?.replace(/\.[^/.]+$/, '') || p,
      nodeType: (isDoc ? 'doc' : 'code') as 'doc' | 'code',
      parentDir,
    };

    // 尝试并入同父目录且未超负荷的章（认知负荷门禁：<= 12 节）
    let merged = false;
    if (parentDir) {
      for (const ch of draft.chapters) {
        if (ch.nodes.length >= MAX_CHAPTER_NODES) continue;
        const sameDir = ch.nodes.some((n) => {
          const nDir = n.sourcePath.includes('/')
            ? n.sourcePath.substring(0, n.sourcePath.lastIndexOf('/'))
            : '';
          return nDir === parentDir;
        });
        if (sameDir) {
          ch.nodes.push(nodeData);
          merged = true;
          break;
        }
      }
    }
    if (!merged) orphans.push(nodeData);
  }

  if (orphans.length > 0) {
    // 孤立未覆盖节点：按父目录拓扑聚合，避免全量倒灌为单章 Supplementary
    const orphanGroups = new Map<string, typeof orphans>();
    for (const orphan of orphans) {
      const gKey = orphan.parentDir || 'root';
      if (!orphanGroups.has(gKey)) orphanGroups.set(gKey, []);
      orphanGroups.get(gKey)!.push(orphan);
    }

    for (const [gKey, gNodes] of orphanGroups.entries()) {
      const rawTitle = gKey === 'root' ? 'Supplementary' : (gKey.split('/').pop() || gKey);
      const title = rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1).replace(/[-_]+/g, ' ');
      draft.chapters.push({
        title,
        chapterType: gNodes.every((n) => n.nodeType === 'doc') ? 'doc' : 'mixed',
        teachingOrder: draft.chapters.length + 1,
        nodes: gNodes,
      });
    }
  }
}

/**
 * post-process ②:大类规则兜底。
 * prompt 要求「章数 > 6 才聚合 parts」,但 LLM 可能不执行(如 hybrid 产出 7 章无 parts)。
 * 这里代码保证:> 6 章且无 parts 时,按 teachingOrder 均分三段(Basics / Core / Advanced)。
 */
export function ensurePartsIfLarge(draft: OutlineDraft): void {
  if (draft.chapters.length <= 6 || draft.parts.length > 0) return;

  const sorted = [...draft.chapters].sort((a, b) => a.teachingOrder - b.teachingOrder);
  const third = Math.ceil(sorted.length / 3);
  const partNames = ['Basics', 'Core', 'Advanced'];
  draft.parts = partNames.map((title, i) => ({ title, teachingOrder: i + 1 }));
  for (let i = 0; i < sorted.length; i++) {
    const partIdx = Math.min(Math.floor(i / third), 2);
    sorted[i].partTitle = partNames[partIdx];
  }
}

/** 构建编排器 prompt(纯函数,便于测试与迭代) */
export async function buildOrchestratorPrompt(opts: {
  owner: string;
  repo: string;
  topologySummary: ReturnType<typeof buildDirectoryTopologySummary>;
  contentSamples?: Record<string, string>;
}): Promise<string> {
  const { owner, repo, topologySummary, contentSamples } = opts;
  const samplesSection = contentSamples && Object.keys(contentSamples).length > 0
    ? `\nReal file content samples (head of each file, truncated):\n${JSON.stringify(contentSamples, null, 2)}\n`
    : '';

  const compiled = await PromptRegistry.getCompiledPrompt('ingest_orchestrator', {
    owner,
    repo,
    topologySummary: JSON.stringify(topologySummary, null, 2),
    samplesSection,
  });
  return compiled.compiledPrompt;
}

/** 编排器:目录拓扑 → LLM 章节大纲。失败/非法返回 null(由调用方降级)。 */
export async function orchestrateOutline(
  nodes: GitHubNode[],
  owner: string,
  repo: string,
  options?: { contentSamples?: Record<string, string>; userId?: string }
): Promise<OutlineDraft | null> {
  if (!nodes || nodes.length === 0) return null;

  const { resolveActiveUserModel, toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
  const userModel = await resolveActiveUserModel(options?.userId).catch(() => null);
  const injectable = toInjectableStructuredModel(userModel);
  if (!injectable) return null;

  const topologySummary = buildDirectoryTopologySummary(nodes as never);

  try {
    const result = await generateStructured({
      model: injectable,
      userId: options?.userId,
      schema: outlineDraftSchema,
      prompt: await buildOrchestratorPrompt({ owner, repo, topologySummary, contentSamples: options?.contentSamples }),
    });
    trackTokenUsage(result.usage, { source: 'orchestrator', userId: options?.userId });

    const draft: OutlineDraft = {
      parts: result.object.parts || [],
      chapters: result.object.chapters || [],
    };

    // post-process:删幻觉路径 → 补漏文件 → 大类规则(顺序重要)
    pruneHallucinatedPaths(draft, nodes);
    ensureFullCoverage(draft, nodes);
    ensurePartsIfLarge(draft);

    if (!isOutlineDraftValid(draft)) {
      console.warn(`[Orchestrator] LLM produced invalid outline for ${owner}/${repo}, returning null`);
      return null;
    }
    return draft;
  } catch (error) {
    console.error('[Orchestrator] Failed to orchestrate outline:', error);
    return null;
  }
}

/**
 * 从模块快照产出（统一代码引擎的 ModuleSnapshot[]）直接构建大纲。
 * 使用方：admin reoutline 工具（code 仓的重编排分支）。
 * 导入期 code 仓的大纲已改由 navTree 确定性派生（outline-derive.ts），不再经过本函数。
 *
 * 纯确定性映射(cluster → outline),不调 LLM:
 * - cluster 的 teachingOrder 是确定性的(模块快照 teachingOrder)
 * - cluster 的 title 是 wizard outline-draft(LLM 聚类)已生成的
 * - 大类规则用 ensurePartsIfLarge(已有 post-process)
 */
export function orchestrateFromClusters(
  chapters: { title: string; description?: string; teachingOrder: number; partTitle?: string }[],
): OutlineDraft {
  const parts: { title: string; teachingOrder: number; description?: string }[] = [];
  const partSet = new Set<string>();

  for (const ch of chapters) {
    if (ch.partTitle && !partSet.has(ch.partTitle)) {
      partSet.add(ch.partTitle);
      parts.push({
        title: ch.partTitle,
        teachingOrder: ch.teachingOrder,
      });
    }
  }

  const draft: OutlineDraft = {
    parts,
    chapters: chapters.map((ch) => ({
      title: ch.title,
      summary: ch.description,
      ...(ch.partTitle ? { partTitle: ch.partTitle } : {}),
      chapterType: 'code' as const,
      teachingOrder: ch.teachingOrder,
      nodes: [
        {
          // 与 code-ingest.ts 的 Document.path 公式一致(集中注册:chapterDocPath)
          sourcePath: chapterDocPath(ch.teachingOrder),
          title: ch.title,
          nodeType: 'code' as const,
        },
      ],
    })),
  };
  // post-process:大类规则(> 6 章自动分且当前无 parts 时)
  ensurePartsIfLarge(draft);
  return draft;
}
