import { prisma } from '@/lib/db';
import { REPO_PROFILE_CLUSTERS_KEY } from '../../constants';
import { buildCleanSectionAddress } from '@/lib/mcp/section-address';
import { normalizeHeadingKey } from '@/lib/mcp/concept-extractor';
import { resolveCanonicalMemberIds } from '@/lib/mcp/concept-canonical';
import {
  computeNeighborMap,
  computeLearningPathChain,
  computeConceptDepths,
  MAX_NEIGHBOR_SHOW,
  MAX_COLOCATED_SHOW,
  COLOCATED_WEIGHT,
  MAX_LEARNING_PATH_DEPTH,
  type EdgeRef,
} from '@/lib/mcp/concept-graph-pure';
import { neighborRelationTag } from '@/lib/mcp/concept-graph-formatter';

// ─────────────────────────────────────────────────────────────
// 概念图读侧（DB 适配）：概念解析与图查询（MCP 工具使用）
// 写侧边同步见 edge-sync.ts，公共入口见 index.ts
// ─────────────────────────────────────────────────────────────

/**
 * 概念节点解析：slug 精确 → 名称精确（优先），未命中再退到名称前缀（startsWith）兜底。
 *
 * 历史用宽泛的 contains 兜底：查 "API" 会命中 "REST API"/"Rate Limiting API" 等任意子串，
 * 配合 orderBy updatedAt desc 返回最近更新的那个 → get_concept_details / learning_path
 * 常定位到错误概念。改为两阶段：先精确匹配（消除歧义），仅在无精确命中时退到前缀匹配
 * （"API" 仅命中 "API Gateway" 等前缀概念，误中率大幅下降）。
 */
export async function resolveConceptNode(repositoryId: string, concept: string) {
  const trimmed = (concept || '').trim();
  if (!trimmed) return null;
  const include = { document: { select: { path: true, title: true } } };

  // 1. 精确匹配优先（slug / 概念名 / 归并名 / 归并键），命中即返回，杜绝歧义。
  //    归并维度让「查 事件循环(下)」也能直接命中其归属组（canonicalName=事件循环 的成员）。
  //    注意：归并键条件需按计算结果动态加入——空对象条件在 OR 里会退化为「全匹配」。
  const canonicalKey = normalizeHeadingKey(trimmed);
  const exact = await prisma.tutorialConceptNode.findFirst({
    where: {
      repositoryId,
      OR: [
        { slug: { equals: trimmed, mode: 'insensitive' } },
        { conceptName: { equals: trimmed, mode: 'insensitive' } },
        { canonicalName: { equals: trimmed, mode: 'insensitive' } },
        ...(canonicalKey ? [{ canonicalKey }] : []),
      ],
    },
    include,
    orderBy: { updatedAt: 'desc' },
  });
  if (exact) return exact;

  // 2. 兜底：名称前缀匹配（startsWith，比历史 contains 精确得多）
  return prisma.tutorialConceptNode.findFirst({
    where: {
      repositoryId,
      conceptName: { startsWith: trimmed, mode: 'insensitive' },
    },
    include,
    orderBy: { updatedAt: 'desc' },
  });
}

/**
 * 概念邻居项（getConceptNeighbors / co_located 动态补充共用形状）：
 * relation.direction 的 undirected 仅由读侧 co_located 伪边产生（物化边恒为 incoming/outgoing）。
 */
export interface ConceptNeighborItem {
  conceptId: string;
  conceptName: string;
  canonicalKey: string | null;
  canonicalName: string | null;
  category: string;
  docPath: string | null;
  headingPath: string | null;
  address: string | null;
  relation: { direction: 'incoming' | 'outgoing' | 'undirected'; type: string; weight: number; source: string };
  edgeCount: number;
}

/**
 * 概念邻居查询：返回目标概念的直接邻居（入边 source / 出边 target），
 * 每个邻居携带概念名、文档路径与溯源 Address。
 */
export async function getConceptNeighbors(repositoryId: string, conceptId: string): Promise<ConceptNeighborItem[]> {
  // 归并继承：查询范围扩为「本概念所属归并组的全部成员」——长尾变体直接继承组内
  // 头部概念的邻居，孤点（无任何边）不再返回空。未归并时 memberIds = [conceptId]，行为不变。
  const memberIds = await resolveCanonicalMemberIds(repositoryId, conceptId);
  const memberSet = new Set(memberIds);

  // 仅查触及组成员的边（SQL 下推 in + OR），避免每次 read_section 全仓扫描数千行边
  const edges = await prisma.tutorialConceptEdge.findMany({
    where: { repositoryId, OR: [{ sourceId: { in: memberIds } }, { targetId: { in: memberIds } }] },
    select: { sourceId: true, targetId: true, type: true, weight: true, source: true },
  });
  const map = computeNeighborMap(edges);

  const neighborIds = new Set<string>();
  const byId = new Map<string, { direction: 'incoming' | 'outgoing'; type: string; weight: number; source: string }[]>();
  for (const memberId of memberIds) {
    const { incoming = [], outgoing = [] } = map.get(memberId) || {};
    for (const e of incoming) {
      if (memberSet.has(e.sourceId)) continue; // 组内互边不构成「邻居」
      neighborIds.add(e.sourceId);
      const arr = byId.get(e.sourceId) || [];
      arr.push({ direction: 'incoming', type: e.type, weight: e.weight, source: e.source ?? 'cooccurrence' });
      byId.set(e.sourceId, arr);
    }
    for (const e of outgoing) {
      if (memberSet.has(e.targetId)) continue;
      neighborIds.add(e.targetId);
      const arr = byId.get(e.targetId) || [];
      arr.push({ direction: 'outgoing', type: e.type, weight: e.weight, source: e.source ?? 'cooccurrence' });
      byId.set(e.targetId, arr);
    }
  }

  if (neighborIds.size === 0) return [];

  const nodes = await prisma.tutorialConceptNode.findMany({
    where: { id: { in: Array.from(neighborIds) }, repositoryId },
    select: {
      id: true,
      conceptName: true,
      slug: true,
      canonicalKey: true,
      canonicalName: true,
      category: true,
      headingPath: true,
      document: { select: { path: true, title: true } },
    },
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const edgeNeighbors = Array.from(byId.entries())
    .map(([id, rels]) => {
      const node = nodeById.get(id);
      if (!node) return null;
      const bestRel = rels.sort((a, b) => b.weight - a.weight)[0];
      return {
        conceptId: id,
        conceptName: node.conceptName,
        canonicalKey: node.canonicalKey,
        canonicalName: node.canonicalName,
        category: node.category,
        docPath: node.document?.path || null,
        headingPath: node.headingPath,
        address: node.document?.path && node.headingPath
          ? buildCleanSectionAddress(node.document.path, node.headingPath)
          : null,
        // relation 携带 source（证据来源）与 weight，让客户端可判断边可信度
        relation: { direction: bestRel.direction, type: bestRel.type, weight: bestRel.weight, source: bestRel.source },
        edgeCount: rels.length,
      };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null)
    .sort((a, b) => {
      // 优先级排序：确定性有向/教学边（code_dep / curriculum_order / manual）优先于无向 cooccurrence
      const scoreSource = (src: string) =>
        src === 'code_dep' ? 3 : src === 'curriculum_order' || src === 'manual' ? 2 : src === 'cooccurrence' ? 0 : 1;
      const diff = scoreSource(b.relation.source) - scoreSource(a.relation.source);
      return diff !== 0 ? diff : b.relation.weight - a.relation.weight;
    })
    // 同一归并组的邻居变体只保留权重最高的一条（组代表语义），防止同组占满邻居窗口
    .filter((n, _idx, arr) => {
      if (!n.canonicalKey) return true;
      const first = arr.find((m) => m.canonicalKey === n.canonicalKey);
      return first === n || first === undefined;
    })
    .slice(0, MAX_NEIGHBOR_SHOW);

  // 同篇动态补充：文档级两两配对已裁撤，「同篇概念」作为 co_located 伪边在读侧按
  // documentId 索引直查（确定性事实，零物化存储），追加在确定性边邻居之后。
  const coLocated = await loadCoLocatedNeighbors(repositoryId, conceptId, memberIds, edgeNeighbors);
  return [...edgeNeighbors, ...coLocated];
}

/**
 * 同篇邻居动态查询（co_located 伪边）：目标概念同文档的其余概念，排除
 * 归并组成员与已展示邻居（含同归并组变体），按更新时间取最近 MAX_COLOCATED_SHOW 个。
 * canonicalKey 为 null 的未归并概念不受 notIn 空值语义影响（JS 侧过滤）。
 */
async function loadCoLocatedNeighbors(
  repositoryId: string,
  conceptId: string,
  memberIds: string[],
  existing: { conceptId: string; canonicalKey: string | null }[]
): Promise<ConceptNeighborItem[]> {
  try {
    const target = await prisma.tutorialConceptNode.findUnique({
      where: { id: conceptId },
      select: { documentId: true },
    });
    if (!target?.documentId) return [];

    const excludeIds = new Set([...memberIds, ...existing.map((n) => n.conceptId)]);
    const shownKeys = new Set(existing.map((n) => n.canonicalKey).filter((k): k is string => Boolean(k)));

    // 多取 3 倍候选再 JS 过滤（归并组去重后截取），绕开 notIn 对 null canonicalKey 的 SQL 空值语义
    const rows = await prisma.tutorialConceptNode.findMany({
      where: {
        repositoryId,
        documentId: target.documentId,
        id: { notIn: Array.from(excludeIds) },
      },
      select: {
        id: true,
        conceptName: true,
        slug: true,
        canonicalKey: true,
        canonicalName: true,
        category: true,
        headingPath: true,
        document: { select: { path: true, title: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_COLOCATED_SHOW * 3,
    });

    return rows
      .filter((node) => !node.canonicalKey || !shownKeys.has(node.canonicalKey))
      .slice(0, MAX_COLOCATED_SHOW)
      .map((node) => ({
        conceptId: node.id,
        conceptName: node.conceptName,
        canonicalKey: node.canonicalKey,
        canonicalName: node.canonicalName,
        category: node.category,
        docPath: node.document?.path || null,
        headingPath: node.headingPath,
        address: node.document?.path && node.headingPath
          ? buildCleanSectionAddress(node.document.path, node.headingPath)
          : null,
        relation: { direction: 'undirected' as const, type: 'co_located', weight: COLOCATED_WEIGHT, source: 'cooccurrence' },
        edgeCount: 0,
      }));
  } catch (err) {
    console.warn('[concept-graph] loadCoLocatedNeighbors failed:', err);
    return [];
  }
}

/**
 * 学习路径查询：目标概念的前置知识链（跨文档，按教学顺序）。
 * 返回从「最先学」到「目标概念」的倒序链（chain[0] 是最底层前置）。
 */
export async function getLearningPathConcepts(repositoryId: string, targetId: string) {
  // 仅加载 prerequisite/successor 边（computeLearningPathChain 只沿这两种走），
  // 跳过 bulk 的 related 共现边，显著降低读取量（大仓 related 边常占 80%+）
  const edges = await prisma.tutorialConceptEdge.findMany({
    where: { repositoryId, type: { in: ['prerequisite', 'successor'] } },
    select: { sourceId: true, targetId: true, type: true, weight: true },
  });
  // 归并继承：整组视为同一深度 0 超节点——任一成员的前置都算目标的前置
  const memberIds = await resolveCanonicalMemberIds(repositoryId, targetId);
  const chain = computeLearningPathChain(targetId, edges, MAX_LEARNING_PATH_DEPTH, memberIds);
  if (chain.length === 0) return [];

  const ids = chain.map((c) => c.conceptId);
  const nodes = await prisma.tutorialConceptNode.findMany({
    where: { id: { in: ids }, repositoryId },
    select: {
      id: true,
      conceptName: true,
      canonicalKey: true,
      canonicalName: true,
      category: true,
      headingPath: true,
      document: { select: { path: true, title: true } },
    },
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // 链内按归并组去重（同组变体只保留最直接的一条——BFS 顺序即深度升序，先见者深度更浅）
  const seenKeys = new Set<string>();
  return chain
    .map((c) => {
      const node = nodeById.get(c.conceptId);
      if (!node) return null;
      return {
        conceptId: c.conceptId,
        conceptName: node.conceptName,
        canonicalKey: node.canonicalKey,
        canonicalName: node.canonicalName,
        category: node.category,
        depth: c.depth,
        docPath: node.document?.path || null,
        headingPath: node.headingPath,
        address: node.document?.path && node.headingPath
          ? buildCleanSectionAddress(node.document.path, node.headingPath)
          : null,
      };
    })
    .filter((n): n is NonNullable<typeof n> => {
      if (!n) return false;
      if (!n.canonicalKey) return true;
      if (seenKeys.has(n.canonicalKey)) return false;
      seenKeys.add(n.canonicalKey);
      return true;
    });
}

/**
 * 概念前置知识查询：目标概念沿入边（prerequisite + successor）取前置概念，
 * 按边权重降序，最多 max 个。search 依赖提示 / learning_path 共用。
 */
export async function getConceptDependencies(
  repositoryId: string,
  conceptId: string,
  max: number = 5
): Promise<{ conceptId: string; conceptName: string; category: string; docPath: string | null; address: string | null; source: string; weight: number }[]> {
  if (!repositoryId || !conceptId) return [];
  // 归并继承：前置查询按「归并组成员集合」取 targetId in members——跨成员挂在组内
  // 其他变体上的前置边不再漏掉。未归并时 memberIds = [conceptId]，行为不变。
  const memberIds = await resolveCanonicalMemberIds(repositoryId, conceptId);
  const edges = await prisma.tutorialConceptEdge.findMany({
    where: { repositoryId, targetId: { in: memberIds }, type: { in: ['prerequisite', 'successor'] } },
    select: { sourceId: true, weight: true, source: true },
    orderBy: { weight: 'desc' },
  });
  if (edges.length === 0) return [];

  // 多成员取边后按前置概念去重（同一前置可能连到组内多个变体），保留权重最高的一条
  const seenSources = new Set<string>();
  const dedupedEdges = edges.filter((e) => {
    if (seenSources.has(e.sourceId)) return false;
    seenSources.add(e.sourceId);
    return true;
  });
  const topEdges = dedupedEdges.slice(0, max);
  if (topEdges.length === 0) return [];

  const nodes = await prisma.tutorialConceptNode.findMany({
    where: { id: { in: topEdges.map((e) => e.sourceId) }, repositoryId },
    select: {
      id: true,
      conceptName: true,
      category: true,
      headingPath: true,
      document: { select: { path: true, title: true } },
    },
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  return topEdges
    .map((e) => {
      const node = nodeById.get(e.sourceId);
      if (!node) return null;
      return {
        conceptId: node.id,
        conceptName: node.conceptName,
        category: node.category,
        docPath: node.document?.path || null,
        address: node.document?.path && node.headingPath
          ? buildCleanSectionAddress(node.document.path, node.headingPath)
          : null,
        // 携带证据来源与权重，让依赖提示可标注可信度（确定性 vs LLM 推断）
        source: e.source ?? 'cooccurrence',
        weight: e.weight,
      };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);
}

/**
 * 代码章节源码上下文（code_dep 维度，零新数据——复用 repoProfile.codeClusters 快照）：
 * 概念归属文档是虚拟代码章节（chapters/NN.mdx）时，解析其所属模块的目录与源码文件清单。
 * 让「概念 × 源码」维度在 MCP 查询输出可见；非代码章节返回 null。
 */
export async function getConceptCodeContext(
  repositoryId: string,
  documentPath: string
): Promise<{ title: string; directories: string[]; files: string[] } | null> {
  const { isCodeChapterPath } = await import('@/engine/update-candidate-set');
  if (!isCodeChapterPath(documentPath)) return null;
  const order = parseInt(documentPath.split('/').pop()?.replace(/\D/g, '') || '', 10);
  if (Number.isNaN(order)) return null;
  try {
    const repo = await prisma.repository.findUnique({
      where: { id: repositoryId },
      select: { repoProfile: true },
    });
    const clusters = (((repo?.repoProfile as Record<string, unknown> | null)?.[
      REPO_PROFILE_CLUSTERS_KEY
    ] ?? []) as Array<{ teachingOrder: number; title?: string; directories?: string[]; files?: string[] }>);
    const cluster = clusters.find((c) => c.teachingOrder === order);
    if (!cluster) return null;
    return {
      title: cluster.title || `Chapter ${order}`,
      directories: cluster.directories || [],
      files: cluster.files || [],
    };
  } catch (err) {
    console.warn('[concept-graph] getConceptCodeContext failed:', err);
    return null;
  }
}

export interface GroundedSymbolInfo {
  name: string;
  kind: 'function' | 'type';
  file: string;
  score: number;
}

export interface ConceptGrounding {
  backboneFiles: { path: string; role: string; pageRank: number }[];
  goldenSymbols: GroundedSymbolInfo[];
}

/**
 * 认知图谱与物理代码语义图（RSG）跨图穿透：
 * 提取概念对应的 Tree-sitter WASM AST 黄金符号（Golden Symbols）与 PageRank 核心主干文件。
 * 若无 RSG 磁盘快照，则降级返回 null（保证离线或非代码仓静默容错）。
 */
export async function getConceptGrounding(
  repositoryId: string,
  conceptName: string,
  documentPath?: string | null
): Promise<ConceptGrounding | null> {
  try {
    const repo = await prisma.repository.findUnique({
      where: { id: repositoryId },
      select: { owner: true, repo: true, gitSha: true },
    });
    if (!repo || !repo.gitSha) return null;

    // 1. 若为代码章节（chapters/NN.mdx），先定位章节所属的文件清单
    let scopeFilesArr: string[] | null = null;
    if (documentPath) {
      const codeCtx = await getConceptCodeContext(repositoryId, documentPath);
      if (codeCtx && codeCtx.files.length > 0) {
        scopeFilesArr = codeCtx.files;
      }
    }

    // 优先委托 Go worker-sidecar 原生图谱查询（Zero-RSG：消灭 Node 堆内大图谱反序列化）
    try {
      const { executeSidecarConceptGrounding } = await import('@/engine/symbols-driver');
      const sidecarRes = await executeSidecarConceptGrounding({
        owner: repo.owner,
        repo: repo.repo,
        sha: repo.gitSha,
        conceptName,
        scopeFiles: scopeFilesArr ?? undefined,
      });
      if (sidecarRes.goldenSymbols.length === 0 && sidecarRes.backboneFiles.length === 0) {
        return null;
      }
      return sidecarRes;
    } catch (sidecarErr) {
      // 容错降级：Sidecar 异常或未就绪时回退至 Node 侧本地反序列化（Fail-Open）
      console.warn('[concept-graph] sidecar concept-grounding failed, falling back to local artifact:', sidecarErr);
    }

    // 2. 本地降级回退 (Fail-Open)
    const { loadSemanticGraphArtifact } = await import('@/engine/ingest/graph-store');
    const artifact = await loadSemanticGraphArtifact(repo.owner, repo.repo, repo.gitSha);
    if (!artifact) return null;

    const scopeFiles = scopeFilesArr ? new Set(scopeFilesArr) : null;

    // 筛选主干文件 (Backbone Files)：优先章节文件，否则取高 PageRank 核心节点
    const backboneFiles: { path: string; role: string; pageRank: number }[] = [];
    if (Array.isArray(artifact.nodes)) {
      const candidateNodes = artifact.nodes
        .filter((n) => (scopeFiles ? scopeFiles.has(n.path) : n.isBackbone || n.role === 'core_contract' || n.role === 'entry_point'))
        .sort((a, b) => (b.pageRank || 0) - (a.pageRank || 0));

      for (const node of candidateNodes.slice(0, 4)) {
        backboneFiles.push({
          path: node.path,
          role: node.role,
          pageRank: Math.round((node.pageRank || 0) * 1000) / 1000,
        });
      }
    }

    const backboneFileSet = new Set(backboneFiles.map((b) => b.path));

    // 3. 筛选 Golden Symbols：优先章节文件/主干文件内的符号，或者符号名与概念关键词匹配的符号
    const normConcept = (conceptName || '').toLowerCase().trim();
    const goldenSymbols: GroundedSymbolInfo[] = [];
    const seenSymbols = new Set<string>();

    if (Array.isArray(artifact.goldenSymbols)) {
      for (const sym of artifact.goldenSymbols) {
        const inScope = scopeFiles ? scopeFiles.has(sym.file) : backboneFileSet.has(sym.file);
        const normSym = (sym.name || '').toLowerCase().trim();
        const nameMatch = normConcept.length > 0 && (normConcept.includes(normSym) || normSym.includes(normConcept));
        if (inScope || nameMatch) {
          const key = `${sym.file}::${sym.name}`;
          if (!seenSymbols.has(key)) {
            seenSymbols.add(key);
            goldenSymbols.push({
              name: sym.name,
              kind: sym.kind,
              file: sym.file,
              score: sym.score,
            });
          }
        }
        if (goldenSymbols.length >= 6) break;
      }
    }

    if (goldenSymbols.length === 0 && backboneFiles.length === 0) return null;

    return {
      backboneFiles,
      goldenSymbols,
    };
  } catch (err) {
    console.warn('[concept-graph] getConceptGrounding failed:', err);
    return null;
  }
}

/**
 * 文档归属概念解析：headingPath 精确/包含匹配优先，兜底取该文档最近更新的概念。
 * 用于 read_section 的「图位置」注入（当前 section 属于哪个概念）。
 */
export async function findConceptForDocument(
  repositoryId: string,
  documentId: string,
  headingPath?: string | null
) {
  if (!repositoryId || !documentId) return null;
  // 给定 headingPath（section 上下文）：仅返回真正匹配的概念，未命中返回 null。
  // 不再退到「本文档任意概念」——否则 buildGraphPositionText 会把不相关 section 归到错误概念（T4 误归因）。
  if (headingPath) {
    return prisma.tutorialConceptNode.findFirst({
      where: {
        repositoryId,
        documentId,
        OR: [
          { headingPath: { equals: headingPath } },
          { headingPath: { contains: headingPath } },
        ],
      },
      include: { document: { select: { path: true, title: true } } },
      orderBy: { updatedAt: 'desc' },
    });
  }
  // 未给 headingPath（整文档上下文）：返回本文档最近概念
  return prisma.tutorialConceptNode.findFirst({
    where: { repositoryId, documentId },
    include: { document: { select: { path: true, title: true } } },
    orderBy: { updatedAt: 'desc' },
  });
}

/**
 * 图位置文本（read_section 响应头注入）：当前 section 所属概念 + 直接邻居。
 * 无归属概念或无边时返回 ''（不注入，保持输出零变化）。
 */
export async function buildGraphPositionText(
  repositoryId: string,
  documentId: string,
  headingPath?: string | null
): Promise<string> {
  try {
    const concept = await findConceptForDocument(repositoryId, documentId, headingPath);
    if (!concept) return '';
    const neighbors = await getConceptNeighbors(repositoryId, concept.id);
    if (neighbors.length === 0) return '';

    let text = `🧭 图位置 (Graph Position): 本节属于「${concept.conceptName}」(${concept.category})\n`;
    text += `- 直接邻居: `;
    text += neighbors
      .slice(0, 4)
      .map((n) => `${neighborRelationTag(n.relation)}${n.conceptName}`)
      .join('、');
    text += ` (⇠=我依赖它 ⇢=它依赖我 ⇋=无向关联)`;
    text += `\n\n`;
    return text;
  } catch (err) {
    console.error('[concept-graph] buildGraphPositionText failed:', err);
    return '';
  }
}

/**
 * 全仓概念拓扑（list_documents 分组展示）：取最近 N 个概念 + 层级深度。
 * 返回按 category 分组的结构，由 formatConceptTaxonomyGrouped 渲染。
 * 归并层：原始节点按 canonicalKey 去重（同组取代表变体），防止同组变体挤占
 * take 名额；mergedVariants = 组内成员总数（含未回填存量时至少为 1）。
 */
export async function buildRepositoryConceptTaxonomy(repositoryId: string, take: number = 50) {
  // 多取一些原始行再按组收敛：大仓同组变体多时，只取 take 行会欠填分组窗口
  const rawTake = Math.min(take * 4, 200);
  const [concepts, edges, groupCounts] = await Promise.all([
    prisma.tutorialConceptNode.findMany({
      where: { repositoryId },
      select: {
        id: true,
        conceptName: true,
        slug: true,
        canonicalKey: true,
        canonicalName: true,
        category: true,
        headingPath: true,
        document: { select: { path: true, title: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: rawTake,
    }),
    prisma.tutorialConceptEdge.findMany({
      where: { repositoryId, type: { in: ['prerequisite', 'successor'] } },
      select: { sourceId: true, targetId: true, type: true, weight: true },
    }),
    // 组成员计数（全仓口径）：给「同名多处」一个直观的 ×N 标注
    prisma.tutorialConceptNode.groupBy({
      by: ['canonicalKey'],
      where: { repositoryId, canonicalKey: { not: null } },
      _count: { _all: true },
    }).catch(() => [] as { canonicalKey: string | null; _count: { _all: number } }[]),
  ]);
  const countByKey = new Map(
    groupCounts.map((g) => [g.canonicalKey as string, g._count._all])
  );

  const depths = computeConceptDepths(concepts.map((c) => c.id), edges as EdgeRef[]);

  // 按组去重：代表变体优先取「conceptName === canonicalName」者，否则取首个（updatedAt 最新）
  const seenKeys = new Set<string>();
  const deduped = [];
  for (const c of concepts) {
    const key = c.canonicalKey || `raw:${c.id}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const representative =
      (c.canonicalName && concepts.find((m) => m.canonicalKey === c.canonicalKey && m.conceptName === c.canonicalName)) || c;
    deduped.push({
      conceptName: representative.conceptName,
      category: representative.category,
      slug: representative.slug,
      docPath: representative.document?.path || null,
      address: representative.document?.path && representative.headingPath
        ? buildCleanSectionAddress(representative.document.path, representative.headingPath)
        : null,
      depth: depths.get(representative.id) ?? depths.get(c.id) ?? 0,
      canonicalName: c.canonicalName,
      mergedVariants: (c.canonicalKey && countByKey.get(c.canonicalKey)) || 1,
    });
    if (deduped.length >= take) break;
  }
  return deduped;
}
