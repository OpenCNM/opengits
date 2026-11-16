/**
 * repo-tools 共享域：跨工具域复用的类型与辅助（从 repo-tools.ts 迁入）。
 * 职责：仓库运行时类型（RepoContext / RepoRuntime）、目标解析、Hub fan-out
 * 并发与超时原语、locator 输出格式化、错误文案、文档预载 include。
 * 各工具域（resources / search / document / concepts / maintenance）禁止互相 import，
 * 域间共享内容一律收敛于此文件。
 */
import { LocatorHit, searchRepositoryDocs, rerankChunkResults } from '@/lib/mcp/doc-search';
import { summarizeDocChunk } from '@/lib/token-counter';
import {
  MCP_FANOUT_PER_REPO_TIMEOUT_MS,
  MCP_FANOUT_MAX_CONCURRENCY,
  MCP_FANOUT_DETAIL_REPOS,
  MCP_FANOUT_DETAIL_MIN_BUDGET,
} from '@/lib/constants';
import { buildSectionAddress } from '@/lib/mcp/section-address';
import { buildModuleArchitectureMermaidSkeleton } from '@/lib/mermaid/architecture-skeleton';

/**
 * 为单仓查询加超时兜底：Hub fan-out 时慢仓不阻塞整体扇出（超时按空命中处理）。
 * 不向客户端暴露内部超时错误，与 fan-out 吞单仓异常的策略一致。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); }
    );
  });
}

/**
 * 有界并发 map：Hub fan-out 的数据库查询并发度上限（MCP_FANOUT_MAX_CONCURRENCY），
 * 防止一次跨库扇出把连接池瞬间占满连坐主站。保持与 Promise.all 相同的返回顺序；
 * 单仓异常由 fn 自行吞并（与既有扇出策略一致：慢仓/错仓按空命中处理）。
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

/**
 * 与单仓 MCP 一致的文档预载 include（新增 id 供 chunk 查询使用）。
 * 真冻结：只预载"该用户的私有副本 + 共享文档"，绝不把他人私有副本喂给 MCP 上下文。
 * 只预载元数据（id/path/title/summary），正文由 fetchDocumentContent 按需懒加载——
 * 避免 stateless 模式下每个请求（含 initialize/tools/list 握手）全量拖走整仓正文，
 * 击穿数据库吞吐与 Node 堆内存。
 */
export function repositoryDocsInclude(userId?: string | null) {
  return {
    documents: {
      where: {
        status: 'PROCESSED',
        ...(userId ? { OR: [{ ownerUserId: null }, { ownerUserId: userId }] } : { ownerUserId: null }),
      },
      // contentId：MCP read/outline 的切片锚点查询需按内容层回落（documentId 维度
      // 已随零物化停写被 Go DeleteLegacyChunks 物理清空，新文档仅挂 contentId）
      select: { id: true, path: true, title: true, summary: true, contentId: true },
    },
  } as const;
}

/** 单个仓库的运行时上下文（等价于原 createRepositoryMcpServer 的闭包） */
export interface RepoContext {
  owner: string;
  repo: string;
  /** Prisma Repository 记录（含 navTree 与元数据预载文档；正文走 fetchDocumentContent 懒加载） */
  repository: any;
  targetVersionLabel?: string;
  /** 该行讲法 key（'' = 基础讲法；归因与折叠提示消费） */
  edition?: string;
  /** 讲法显示名（仅讲法行有值） */
  editionLabel?: string;
  /** 同仓库同分支的其他讲法行数（扇出折叠提示用；0 或缺省 = 单讲法） */
  editionSiblingCount?: number;
  /**
   * 解析回退标记（resolveRepository isFallback 透传）：
   * 请求的讲法/版本未命中而回退到基础行时为 true——工具输出必须显式警告（fail-loud），
   * 禁止静默降级伪装成功。
   */
  isFallback?: boolean;
  /** 端点显式请求的讲法/版本描述（回退警告文案与遥测归因消费；自然解析无请求时缺省） */
  requestedEdition?: string;
}

/**
 * 讲法/版本回退警告行（fail-loud）：ctx.isFallback 为真时返回警告前缀，否则空串。
 * 各工具域在输出头部注入，保证 Agent 能察觉「要的版本没拿到、当前结果是哪一行」。
 */
export function fallbackWarning(ctx: RepoContext): string {
  if (!ctx.isFallback) return '';
  const requested = ctx.requestedEdition
    ? `"${ctx.requestedEdition}"`
    : 'the requested edition/version';
  const served =
    ctx.edition && ctx.edition !== ''
      ? `edition "${ctx.editionLabel || ctx.edition}"`
      : 'the BASE edition';
  return `⚠ Edition fallback: requested ${requested} was not found; results below come from ${served}. Use list_resources to discover available editions.\n\n`;
}

/** 工具工厂所需的仓库解析运行时 */
export interface RepoRuntime {
  /** 人类可读的作用域名，用于错误与提示文案 */
  label: string;
  /** true = 多仓库 Hub：工具注册可选/必填 repository 参数并支持 fan-out */
  multiRepo: boolean;
  /** 发起用户（工具输出 tokenCap 截断与工具级 tier 门禁的执行主体；匿名/系统通道缺省） */
  userId?: string;
  /**
   * 解析仓库上下文。ref 为 "owner/repo" 或仓库 ID；ref 省略时：
   * 单仓模式返回绑定仓库，Hub 模式返回 null。
   * 解析失败返回 null（由工具输出 isError 文案）。
   */
  resolveRepository(ref?: string): Promise<RepoContext | null>;
  /** 全部可访问仓库（仅 Hub fan-out 使用；单仓模式返回空数组） */
  listRepositories(): Promise<RepoContext[]>;
}

/**
 * Formats locator-mode search output: compact section addresses + snippets
 * instead of full chunk content. The client agent decides which sections to
 * read via read_section / get_document.
 */
export function formatLocatorOutput(opts: { header: string; hits: LocatorHit[] }): string {
  let outputText = `${opts.header}\n\n`;
  for (let i = 0; i < opts.hits.length; i++) {
    const h = opts.hits[i];
    outputText += `--- Result ${i + 1} (Score: ${(h.similarity * 100).toFixed(1)}%) ---\n`;
    outputText += `Document: ${h.title || h.path} [Path: ${h.path}]\n`;
    if (h.heading) outputText += `Section: ${h.heading}\n`;
    if (h.headingPath) outputText += `HeadingPath: ${h.headingPath}\n`;
    outputText += `Address: ${buildSectionAddress(h.path, h.headingPath || h.heading)}\n`;
    outputText += `Snippet: ${h.snippet}\n\n`;
  }
  outputText += `(Use read(target="<Address>") to fetch section digest; drill down into physical facts via read_symbol(symbol="<name>") or read_source_file(path="<path>").)`;
  return outputText;
}

/** Hub fan-out 模式的 locator 输出：每个命中带 [Source: owner/repo · 讲法: label] 归因 */
export function formatFanoutLocatorOutput(opts: { header: string; hits: Array<LocatorHit & { owner: string; repo: string }> }): string {
  let outputText = `${opts.header}\n\n`;
  for (let i = 0; i < opts.hits.length; i++) {
    const h = opts.hits[i];
    const editionPart = h.editionLabel ? ` · 讲法: ${h.editionLabel}` : '';
    outputText += `--- Result ${i + 1} (Score: ${(h.similarity * 100).toFixed(1)}%) [Source: ${h.owner}/${h.repo}${editionPart}] ---\n`;
    outputText += `Document: ${h.title || h.path} [Path: ${h.path}]\n`;
    if (h.heading) outputText += `Section: ${h.heading}\n`;
    if (h.headingPath) outputText += `HeadingPath: ${h.headingPath}\n`;
    outputText += `Address: ${buildSectionAddress(h.path, h.headingPath || h.heading)}\n`;
    outputText += `Snippet: ${h.snippet}\n\n`;
  }
  outputText += `(Use read(target="<Address>", repository="<owner/repo>") to fetch section digest; drill down into physical facts via read_symbol(symbol="<name>", repository="<owner/repo>") or read_source_file(path="<path>", repository="<owner/repo>").)`;
  return outputText;
}

/** 搜索工具的目标解析：null = 显式 ref 未找到；[] = 无可用仓库。
 *  edition 与 ref 组合为 "owner/repo@edition"（讲法行精确指定；单仓模式行已按端点钉死讲法，忽略 edition） */
export async function resolveSearchTargets(runtime: RepoRuntime, ref?: string, edition?: string): Promise<RepoContext[] | null> {
  if (ref) {
    const effectiveRef = runtime.multiRepo && edition ? `${ref}@${edition}` : ref;
    const ctx = await runtime.resolveRepository(effectiveRef);
    return ctx ? [ctx] : null;
  }
  if (runtime.multiRepo) {
    return runtime.listRepositories();
  }
  const ctx = await runtime.resolveRepository();
  return ctx ? [ctx] : [];
}

/** 仓库定位类工具的目标解析：Hub 模式必须显式传 repository */
export async function resolveScopedTarget(runtime: RepoRuntime, ref?: string): Promise<RepoContext | null> {
  if (runtime.multiRepo) {
    return ref ? runtime.resolveRepository(ref) : null;
  }
  return runtime.resolveRepository();
}

export function refNotFoundError(ref: string, runtime: RepoRuntime) {
  return {
    content: [{ type: 'text' as const, text: `Error: Repository "${ref}" not found in ${runtime.label}. Try list_resources to see available tutorials.` }],
    isError: true,
  };
}

export function scopeRequiredError(runtime: RepoRuntime) {
  return {
    content: [{ type: 'text' as const, text: `Error: "repository" is required on ${runtime.label}. Specify which tutorial (e.g. "owner/repo", see list_resources).` }],
    isError: true,
  };
}

export function emptyHubError(runtime: RepoRuntime) {
  return {
    content: [{ type: 'text' as const, text: `${runtime.label} is empty. Save a tutorial first, or pass "repository" to a specific one.` }],
    isError: true,
  };
}

export function classifyPhaseToRole(phase?: string): string {
  const p = (phase || '').toLowerCase().trim();
  if (p.includes('perception') || p.includes('foundation') || p.includes('infra') || p.includes('storage')) return 'infra';
  if (p.includes('interface') || p.includes('entry') || p.includes('pipeline') || p.includes('api')) return 'interface';
  if (p.includes('extension') || p.includes('adapter') || p.includes('util')) return 'utility';
  return 'core';
}

export function formatRoleLabel(role?: string): string {
  switch ((role || '').toLowerCase()) {
    case 'interface':
      return 'Interface & Delivery';
    case 'infra':
      return 'Infrastructure & Storage';
    case 'utility':
      return 'Utilities & Adapters';
    default:
      return 'Core Logic';
  }
}

function sanitizeNodeId(s: string): string {
  const clean = s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!clean || /^[0-9]/.test(clean)) return `n_${clean}`;
  return clean;
}

export function projectMacroTopologyMermaidFromClusters(clusters: any[]): string {
  const roleGroups: Record<string, any[]> = {
    interface: [],
    core: [],
    infra: [],
    utility: [],
  };

  const lookup = new Map<string, string>();

  clusters.forEach((c, idx) => {
    const order = c.teachingOrder ?? idx + 1;
    const nodeId = sanitizeNodeId(`sub_${order}_${c.title}`);
    const role = classifyPhaseToRole(c.cognitive?.phase);
    roleGroups[role].push({ ...c, nodeId, order });

    lookup.set(c.title.toLowerCase(), nodeId);
    lookup.set(sanitizeNodeId(c.title).toLowerCase(), nodeId);
    lookup.set(`ch${order}`, nodeId);
    lookup.set(`chapter ${order}`, nodeId);
    if (Array.isArray(c.directories)) {
      for (const d of c.directories) {
        const clean = d.replace(/^\/+|\/+$/g, '').toLowerCase();
        lookup.set(clean, nodeId);
        const base = clean.split('/').pop();
        if (base) lookup.set(base, nodeId);
      }
    }
  });

  const lines: string[] = ['```mermaid', 'flowchart TD'];

  const groupDefs = [
    { key: 'interface', title: '接入与调度层', subId: 'Interface' },
    { key: 'core', title: '核心业务引擎', subId: 'Core' },
    { key: 'infra', title: '基础支持与数据底座', subId: 'Infra' },
    { key: 'utility', title: '公共工具集', subId: 'Utility' },
  ];

  for (const g of groupDefs) {
    const nodes = roleGroups[g.key];
    if (nodes.length === 0) continue;
    lines.push(`  subgraph ${g.subId}["${g.title}"]`);
    for (const n of nodes) {
      const cleanName = n.title.replace(/"/g, "''");
      const fileCount = Array.isArray(n.files) ? n.files.length : 0;
      lines.push(`    ${n.nodeId}["${cleanName}<br/>${fileCount} files"]`);
    }
    lines.push('  end');
  }

  const seenEdges = new Set<string>();
  for (const c of clusters) {
    const order = c.teachingOrder ?? 1;
    const currId = sanitizeNodeId(`sub_${order}_${c.title}`);
    const upstream = c.cognitive?.upstreamModules;
    if (Array.isArray(upstream)) {
      for (const up of upstream) {
        const cleanUp = String(up || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
        let fromId = lookup.get(cleanUp);
        if (!fromId) {
          const base = cleanUp.split('/').pop();
          if (base) fromId = lookup.get(base);
        }
        if (fromId && fromId !== currId) {
          const edgeKey = `${fromId}->${currId}`;
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            lines.push(`  ${fromId} -->|"depends on"| ${currId}`);
          }
        }
      }
    }
  }

  lines.push('```');
  return lines.join('\n');
}

/** 提取全仓 C4 L1 架构拓扑段（供 outline、explore_concept 及 search 优先使用） */
export function extractMacroTopologySection(repoProfile: unknown): string {
  if (!repoProfile || typeof repoProfile !== 'object') return '';
  const profile = repoProfile as Record<string, unknown>;

  let mermaidDiagram = '';
  const subsystems: Array<{ name: string; fileCount?: number; loc?: number; role?: string }> = [];

  // 1. macroTopologyMermaid (string)
  if (typeof profile.macroTopologyMermaid === 'string' && profile.macroTopologyMermaid.trim()) {
    mermaidDiagram = profile.macroTopologyMermaid.trim();
  }

  // 2. macroTopology object
  if (!mermaidDiagram && profile.macroTopology && typeof profile.macroTopology === 'object') {
    const topo = profile.macroTopology as any;
    if (typeof topo.mermaid === 'string' && topo.mermaid.trim()) {
      mermaidDiagram = topo.mermaid.trim();
    } else if (typeof topo.rawMermaid === 'string' && topo.rawMermaid.trim()) {
      mermaidDiagram = topo.rawMermaid.trim();
    }
    if (Array.isArray(topo.nodes)) {
      for (const n of topo.nodes) {
        if (n && n.name) {
          subsystems.push({
            name: n.name,
            fileCount: n.fileCount,
            loc: n.loc,
            role: n.role,
          });
        }
      }
    }
  }

  // 3. Dynamic projection from codeClusters
  const rawClusters = profile.codeClusters;
  if (Array.isArray(rawClusters) && rawClusters.length > 0) {
    const clusters = rawClusters.filter((c: any) => c && typeof c.title === 'string');
    if (!mermaidDiagram && clusters.length > 0) {
      mermaidDiagram = projectMacroTopologyMermaidFromClusters(clusters);
    }
    if (subsystems.length === 0) {
      for (const c of clusters) {
        const phase = c.cognitive?.phase || '';
        subsystems.push({
          name: c.title,
          fileCount: Array.isArray(c.files) ? c.files.length : 0,
          role: classifyPhaseToRole(phase),
        });
      }
    }
  }

  if (!mermaidDiagram) return '';

  let section = `🏛️ Architecture Topology (C4 L1 System Context):\n\n${mermaidDiagram}\n`;
  if (subsystems.length > 0) {
    section += `\n### Subsystems & Modules:\n`;
    for (const sub of subsystems) {
      const roleLabel = formatRoleLabel(sub.role);
      const filesPart = sub.fileCount !== undefined ? `${sub.fileCount} files` : '';
      const locPart = sub.loc ? ` · ${sub.loc} LOC` : '';
      const stats = [filesPart, locPart].filter(Boolean).join('');
      const statsBracket = stats ? ` (${stats})` : '';
      section += `- **${sub.name}**${statsBracket} [${roleLabel}]\n`;
    }
  }

  return section;
}

export function renderMacroArchitecture(owner: string, repo: string, repoProfile: unknown): string {
  const topoSection = extractMacroTopologySection(repoProfile);
  if (!topoSection) {
    return `No code architecture topology available for ${owner}/${repo} (non-code documentation repository).`;
  }
  return `# 🏛️ System Architecture Topology (C4 L1 System Context)\nRepository: ${owner}/${repo}\n\n${topoSection}\n(Next steps: use explore_concept with concept="<subsystem_name>", action="architecture" to drill down into subsystem component collaboration maps and AST call flows.)`;
}

export function renderSubsystemArchitecture(owner: string, repo: string, repoProfile: unknown, concept: string): string {
  const conceptTrimmed = (concept || '').trim();
  const conceptLower = conceptTrimmed.toLowerCase();

  const profile = (repoProfile && typeof repoProfile === 'object') ? (repoProfile as Record<string, any>) : {};
  const rawClusters = profile.codeClusters;
  const clusters: any[] = Array.isArray(rawClusters) ? rawClusters : [];

  let matchedCluster: any = null;
  for (const c of clusters) {
    if (!c) continue;
    const title = String(c.title || '');
    if (title.toLowerCase() === conceptLower || title.toLowerCase().includes(conceptLower)) {
      matchedCluster = c;
      break;
    }
    if (Array.isArray(c.directories)) {
      for (const dir of c.directories) {
        const cleanDir = String(dir || '').replace(/^\/+|\/+$/g, '').toLowerCase();
        const base = cleanDir.split('/').pop() || '';
        if (cleanDir === conceptLower || base === conceptLower || cleanDir.includes(conceptLower)) {
          matchedCluster = c;
          break;
        }
      }
    }
    if (matchedCluster) break;
    if (Array.isArray(c.files)) {
      for (const file of c.files) {
        const cleanFile = String(file || '').replace(/^\/+|\/+$/g, '').toLowerCase();
        const base = cleanFile.split('/').pop() || '';
        if (cleanFile === conceptLower || base === conceptLower) {
          matchedCluster = c;
          break;
        }
      }
    }
    if (matchedCluster) break;
    const num = parseInt(conceptTrimmed, 10);
    if (!isNaN(num) && (c.teachingOrder === num || c.chapterNo === num)) {
      matchedCluster = c;
      break;
    }
    const chStr = `chapter ${c.teachingOrder}`.toLowerCase();
    const chShort = `ch${c.teachingOrder}`.toLowerCase();
    const chPad = `ch${String(c.teachingOrder).padStart(2, '0')}`.toLowerCase();
    if (conceptLower === chStr || conceptLower === chShort || conceptLower === chPad) {
      matchedCluster = c;
      break;
    }
  }

  if (matchedCluster) {
    const cog = matchedCluster.cognitive;
    const goldenSymbols = cog?.goldenSymbols || [];
    const mermaid = buildModuleArchitectureMermaidSkeleton(
      matchedCluster.title,
      cog,
      goldenSymbols,
      { maxCallSteps: 8, includeExternal: true }
    );

    const lines: string[] = [];
    lines.push('# 🏛️ Subsystem Architecture (C4 L2 Component Map)');
    lines.push(`Subsystem: ${matchedCluster.title} (Chapter ${matchedCluster.teachingOrder ?? 1})`);
    lines.push(`Repository: ${owner}/${repo}`);
    if (matchedCluster.summary) {
      lines.push(`Summary: ${matchedCluster.summary}`);
    }
    if (Array.isArray(matchedCluster.directories) && matchedCluster.directories.length > 0) {
      lines.push(`Directories: ${matchedCluster.directories.join(', ')}`);
    }
    if (Array.isArray(matchedCluster.files) && matchedCluster.files.length > 0) {
      const shownFiles = matchedCluster.files.slice(0, 8);
      const more = matchedCluster.files.length > 8 ? ` ... [${matchedCluster.files.length - 8} more files]` : '';
      lines.push(`Files (${matchedCluster.files.length}): ${shownFiles.join(', ')}${more}`);
    }
    if (cog?.phase) {
      lines.push(`Role / Phase: ${cog.phase}`);
    }
    lines.push('\n## Component Collaboration & AST Call Flow\n');
    lines.push(mermaid);
    lines.push('');

    if (Array.isArray(goldenSymbols) && goldenSymbols.length > 0) {
      lines.push('### Verified AST Golden Symbols:');
      const limit = Math.min(goldenSymbols.length, 6);
      for (let i = 0; i < limit; i++) {
        const sym = goldenSymbols[i];
        const filePart = sym.file ? ` in \`${sym.file}\`` : '';
        const kindPart = sym.kind ? ` (${sym.kind})` : '';
        lines.push(`- \`${sym.name}\`${kindPart}${filePart}`);
      }
      lines.push('');
    }

    if (cog?.rationale) {
      lines.push(`### Architectural Rationale:\n${cog.rationale}\n`);
    }

    const upstream = cog?.upstreamModules;
    const downstream = cog?.downstreamModules;
    if ((Array.isArray(upstream) && upstream.length > 0) || (Array.isArray(downstream) && downstream.length > 0)) {
      lines.push('### Module Dependencies:');
      if (Array.isArray(upstream) && upstream.length > 0) {
        lines.push(`- Upstream (Prerequisites): ${upstream.join(', ')}`);
      }
      if (Array.isArray(downstream) && downstream.length > 0) {
        lines.push(`- Downstream (Dependents): ${downstream.join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  // 尝试匹配 macroTopology 中的节点
  if (profile.macroTopology && typeof profile.macroTopology === 'object') {
    const topo = profile.macroTopology;
    if (Array.isArray(topo.nodes)) {
      for (const n of topo.nodes) {
        if (!n) continue;
        const nName = String(n.name || '');
        const nId = String(n.id || '');
        const nPath = String(n.path || '');
        if (
          nName.toLowerCase() === conceptLower ||
          nId.toLowerCase() === conceptLower ||
          nName.toLowerCase().includes(conceptLower) ||
          nPath.toLowerCase().includes(conceptLower)
        ) {
          const lines: string[] = [];
          lines.push('# 🏛️ Subsystem Component (C4 L2 Component View)');
          lines.push(`Component: ${n.name} [${formatRoleLabel(n.role)}]`);
          lines.push(`Path: ${n.path || ''}`);
          lines.push(`Repository: ${owner}/${repo}`);
          if (n.fileCount) lines.push(`File Count: ${n.fileCount}`);
          if (n.loc) lines.push(`LOC: ${n.loc}`);
          if (Array.isArray(n.topExports) && n.topExports.length > 0) {
            lines.push(`Top Exports: ${n.topExports.join(', ')}`);
          }
          const incoming: string[] = [];
          const outgoing: string[] = [];
          if (Array.isArray(topo.edges)) {
            for (const e of topo.edges) {
              if (e.to === n.id) {
                incoming.push(`${e.from} (${e.label || 'depends on'})`);
              }
              if (e.from === n.id) {
                outgoing.push(`${e.to} (${e.label || 'depends on'})`);
              }
            }
          }
          if (incoming.length > 0 || outgoing.length > 0) {
            lines.push('\n### Component Dependencies:');
            if (incoming.length > 0) {
              lines.push(`- Inbound Calls / Dependencies: ${incoming.join(', ')}`);
            }
            if (outgoing.length > 0) {
              lines.push(`- Outbound Calls / Dependencies: ${outgoing.join(', ')}`);
            }
          }
          return lines.join('\n');
        }
      }
    }
  }

  const available: string[] = [];
  for (const c of clusters) {
    if (c && c.title) available.push(c.title);
  }
  const lines: string[] = [];
  lines.push(`Subsystem "${conceptTrimmed}" not found in architecture topology for ${owner}/${repo}.\n`);
  if (available.length > 0) {
    lines.push('Available subsystems:');
    for (const name of available) {
      lines.push(`- ${name}`);
    }
    lines.push('\n(Use explore_concept with concept="<name>", action="architecture" to inspect a subsystem, or concept="" for the full C4 L1 system architecture.)');
  } else {
    lines.push('This repository does not have subsystem breakdowns. Use concept="" for the full C4 L1 architecture.');
  }
  return lines.join('\n');
}

export function resolveArchitectureTopologyBlock(owner: string, repo: string, repoProfile: unknown, query: string): string {
  const q = (query || '').toLowerCase().trim();
  const isMacro =
    q === 'architecture' ||
    q === 'overview' ||
    q === 'design' ||
    q === 'structure' ||
    q === 'system' ||
    q === 'arch' ||
    q === 'c4' ||
    q === 'topology' ||
    q === 'macro' ||
    q.includes('architecture') ||
    q.includes('topology') ||
    q.includes('overview') ||
    q.includes('system');

  if (isMacro) {
    return extractMacroTopologySection(repoProfile);
  }

  // 检查是否匹配子系统
  const subsystemText = renderSubsystemArchitecture(owner, repo, repoProfile, query);
  if (
    subsystemText &&
    !subsystemText.startsWith('Subsystem "') &&
    !subsystemText.includes('not found in architecture topology')
  ) {
    return subsystemText;
  }

  return '';
}


// -------------------------------------------------------------
// Hub fan-out detail 两轮法（search / check_breaking_changes 共用）
// -------------------------------------------------------------

interface FanoutDetailParams {
  perRepoHits: Array<{ ctx: any; hits: LocatorHit[] }>;
  expandedQuery: string;
  rawQuery: string;
  detail: 'summary' | 'full';
  tokenBudget: number;
  contentTypes?: string[];
  userId?: string | null;
  headerPrefix: string;
  hubLabel: string;
  summaryMode: boolean;
}

/**
 * 轮2 正文装配（两轮法）：按轮1 各仓最佳命中分排序取前 K 个仓，
 * 预算均分（floor(budget/K)，保底 256），每仓独立取 summary/full 正文并带
 * [Source: owner/repo · 讲法] 归因；全部仓零结果时返回 null（回落轮1 locator）。
 */
export async function buildFanoutDetailBlocks(p: FanoutDetailParams): Promise<string | null> {
  const topRepos = p.perRepoHits
    .map(({ ctx, hits }) => ({
      ctx,
      best: hits.length > 0 ? Math.max(...hits.map((h) => h.similarity)) : -1,
    }))
    .filter((s) => s.best >= 0)
    .sort((a, b) => b.best - a.best)
    .slice(0, MCP_FANOUT_DETAIL_REPOS)
    .map((s) => s.ctx);
  if (topRepos.length === 0) return null;

  const perRepoBudget = Math.max(
    MCP_FANOUT_DETAIL_MIN_BUDGET,
    Math.floor(p.tokenBudget / topRepos.length)
  );

  const blocks = await mapWithConcurrency(
    topRepos,
    MCP_FANOUT_MAX_CONCURRENCY,
    async (ctx): Promise<string | null> => {
      try {
        const results = await withTimeout(
          searchRepositoryDocs(
            ctx.repository.id,
            p.expandedQuery,
            3,
            ctx.targetVersionLabel,
            p.contentTypes,
            perRepoBudget,
            undefined,
            p.rawQuery,
            p.userId
          ),
          MCP_FANOUT_PER_REPO_TIMEOUT_MS,
          []
        );
        if (results.length === 0) return null;
        const scored = rerankChunkResults(results, p.rawQuery);
        const sourceLabel = `[Source: ${ctx.owner}/${ctx.repo}${ctx.editionLabel ? ` · 讲法: ${ctx.editionLabel}` : ''}]`;
        let block = `\n\n### ${sourceLabel}\n`;
        for (const r of scored) {
          const chunkText = p.summaryMode ? summarizeDocChunk(r.content || '') : r.content;
          block += `--- Result (Score: ${(r.similarity * 100).toFixed(1)}%) ---\n`;
          block += `Document: ${r.title || r.path} [Path: ${r.path}]\n`;
          if (r.heading) block += `Section Heading: ${r.heading}\n`;
          block += `\n${chunkText}\n\n`;
        }
        return block;
      } catch {
        return null;
      }
    }
  );

  const validBlocks = blocks.filter((b): b is string => b !== null);
  if (validBlocks.length === 0) return null;

  const modeLabel = p.summaryMode ? ' [Summary Mode]' : ' [Full Mode]';
  return (
    `${p.headerPrefix} for "${p.rawQuery}" across ${p.hubLabel}${modeLabel} (top ${validBlocks.length} tutorials):` +
    validBlocks.join('')
  );
}


// -------------------------------------------------------------
// ToolResult 结构化输出契约 + 纯渲染器（输出管线收敛）
// -------------------------------------------------------------

/**
 * 工具结构化返回：handler 返回本形状 + telemetry，由 wrapToolTelemetry
 * 统一「收割遥测」，输出经 renderToolResult 渲染（fallbackWarning 集中注入）。
 *
 * 字段为「预拼段」而非细粒度 title/meta 数组——header/body/footer 的连接语义
 * 因工具而异（concepts 中文标签、read 固定序头部行），强制统一会破坏既有
 * 输出字节（快照基线与 tool-output-parser 语法锁）。渲染器只集中拥有
 * 全员位置 0 的 fallbackWarning 注入，段内格式仍归工具（先保字节）。
 */
export interface ToolResult {
  /** 前置块（graphPos / 架构拓扑块等，自带分隔语义；渲染器置于警告之后） */
  preamble?: string;
  /** 头部段（标题 + meta 行，工具按现有格式拼好） */
  header: string;
  /** 正文 */
  body: string;
  /** 尾注段（提示/引导，自带前导分隔语义） */
  footer?: string;
  isError?: boolean;
}

/** 工具遥测提示：装饰器统一落 McpCallLog（替代工具内手工调用） */
export interface ToolTelemetry {
  resultCount: number;
  status?: 'SUCCESS' | 'ERROR' | 'BLIND_SPOT';
  dimension?: string;
  query?: string;
  expandedQuery?: string;
  tokensSaved?: number;
  tokensReturned?: number;
  resultSnapshot?: Record<string, unknown> | null;
  errorMessage?: string;
}

/** 纯渲染器：fallbackWarning(ctx) 前缀集中注入 + 段拼接（零 IO，黄金对拍的可测面） */
export function renderToolResult(result: ToolResult, ctx?: RepoContext | null): string {
  const warn = ctx ? fallbackWarning(ctx) : '';
  return `${warn}${result.preamble ?? ''}${result.header}${result.body}${result.footer ?? ''}`;
}

