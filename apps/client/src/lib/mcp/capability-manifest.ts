import { prisma } from '@/lib/db';
import { NavNode } from '@/engine/structurizer';
import { getEffectiveNavTree } from '@/lib/mcp/outline-projector';
import { RepoProfile } from '@/engine/repo-sniffer';
import { WEB_DOC_PREFIX } from '@/lib/constants';
import { deriveEditionLabel, isWebDocRepository, resolveRepositoryDisplayName } from '@/lib/repository-resolver';
import { computeGraphStats, GraphStats } from '@/lib/mcp/graph-condense';

/**
 * MCP 工具清单：单一事实源 tool-contracts.ts。
 */
import { MCP_AVAILABLE_TOOLS } from './tool-contracts';
export { MCP_AVAILABLE_TOOLS };

export interface ChapterCapability {
  title: string;
  summary: string;
  contentTypes: string[];
  keyTopics: string[];
}

export interface TutorialCapabilityManifest {
  identity: {
    id: string;
    owner: string;
    repo: string;
    displayName: string;
    category: string | null;
    tags: string[];
    version: string | null;
    /** 讲法 key（基础讲法为 null；Hub 检索 @edition 引用与此对齐） */
    edition: string | null;
    /** 讲法显示名（基础讲法为 null） */
    editionLabel: string | null;
    verified: boolean;
    stars: number;
    /** 来源类型（'web' = 官方网页文档，'github' = GitHub 仓库） */
    sourceType: 'web' | 'github';
    /** 原站或原仓库可访问 URL */
    sourceUrl: string;
    /** 最近转录/同步时间 (YYYY-MM-DD) */
    lastSyncedAt: string;
  };
  contentProfile: {
    repoType: string;
    ingestMode: string;
    tier: string;
    docCodeRatio: { docFiles: number; codeFiles: number; ratio: number };
    totalDocuments: number;
    totalChapters: number;
    /** 图谱健康指标（巨仓稀疏化/碎片化观测；light 模式下 canonicalGroups 等为 0） */
    graphStats?: GraphStats;
  };
  techStack: {
    primaryLanguages: string[];
    framework: string | null;
    architectureStyle: string;
    hasTests: boolean;
    testFramework: string | null;
    entryPoints: string[];
  } | null;
  teachingCapabilities: {
    chapters: ChapterCapability[];
    contentDimensions: {
      architecture: number;
      code: number;
      api_reference: number;
      warning: number;
      prose: number;
    };
  };
  bestUsedFor: string[];
  mcpEndpoint: {
    url: string;
    availableTools: string[];
  };
}

export async function buildCapabilityManifest(
  repositoryId: string,
  opts?: { graphStatsLight?: boolean }
): Promise<TutorialCapabilityManifest | null> {
  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    include: {
      documents: {
        // 真冻结：无用户上下文时仅取共享文档（能力清单面向公开探索场景）
        where: { status: 'PROCESSED', ownerUserId: null },
        select: {
          id: true,
          title: true,
          path: true,
          summary: true,
        },
      },
    },
  });

  if (!repo) return null;

  const profile = (repo.repoProfile as unknown as RepoProfile) || {};
  const navTree = await getEffectiveNavTree(repositoryId, {
    owner: repo.owner,
    repo: repo.repo,
    fallbackNavTree: repo.navTree,
  });
  const codebaseProfile = profile.codebaseProfile;

  // 1. Fetch content dimensions counts from DocumentChunk
  const dimensionCountsRaw = await prisma.$queryRaw<Array<{ contentType: string; count: bigint }>>`
    SELECT "contentType", COUNT(*)::bigint as count
    FROM "DocumentChunk"
    JOIN "Document" ON "DocumentChunk"."documentId" = "Document"."id"
    WHERE "Document"."repositoryId" = ${repositoryId}
      AND "Document"."ownerUserId" IS NULL
    GROUP BY "contentType"
  `;

  const contentDimensions = {
    architecture: 0,
    code: 0,
    api_reference: 0,
    warning: 0,
    prose: 0,
  };

  for (const row of dimensionCountsRaw) {
    const type = row.contentType;
    const cnt = Number(row.count);
    if (type in contentDimensions) {
      contentDimensions[type as keyof typeof contentDimensions] += cnt;
    } else if (type === 'module_overview' || type === 'architecture_diagram') {
      contentDimensions.architecture += cnt;
    } else if (type === 'type_definition' || type === 'function_impl' || type === 'entry_point') {
      contentDimensions.code += cnt;
    } else {
      contentDimensions.prose += cnt;
    }
  }

  // 2. Build chapter capabilities from navTree & document summaries
  const chapters: ChapterCapability[] = [];
  const docMap = new Map(repo.documents.map(d => [d.path.toLowerCase(), d]));

  for (const node of navTree) {
    const matchedDoc = node.path ? docMap.get(node.path.toLowerCase()) : null;
    const nodeAny = node as any;
    chapters.push({
      title: node.title || node.name || 'Untitled Section',
      summary: matchedDoc?.summary || nodeAny.description || `${node.title || node.name} tutorial section`,
      contentTypes: nodeAny.role ? [nodeAny.role] : ['prose'],
      keyTopics: node.children ? node.children.map(c => c.title || c.name).filter(Boolean).slice(0, 5) : [],
    });
  }

  // Fallback if navTree was empty
  if (chapters.length === 0 && repo.documents.length > 0) {
    for (const doc of repo.documents.slice(0, 15)) {
      chapters.push({
        title: doc.title || doc.path,
        summary: doc.summary || `${doc.title || doc.path} document section`,
        contentTypes: ['prose'],
        keyTopics: [],
      });
    }
  }

  const isWeb = isWebDocRepository(repo);
  const displayName = resolveRepositoryDisplayName(repo);
  const rawProfile = (profile as unknown as Record<string, unknown>) || {};
  const lastSyncedAt = (
    (typeof rawProfile.syncedAt === 'string' && rawProfile.syncedAt)
      ? rawProfile.syncedAt.slice(0, 10)
      : (repo.updatedAt || repo.createdAt).toISOString().slice(0, 10)
  );
  const sourceUrl = isWeb
    ? ((rawProfile.originalUrl as string) || `https://${repo.repo.replace(new RegExp(`^${WEB_DOC_PREFIX}`), '')}`)
    : `https://github.com/${repo.owner}/${repo.repo}`;

  return {
    identity: {
      id: repo.id,
      owner: repo.owner,
      repo: repo.repo,
      displayName,
      category: repo.category || null,
      tags: repo.tags || [],
      version: repo.semVerLabel || repo.branch || null,
      // 讲法（转录风格）元数据：讲法行标注 key 与显示名，Hub 清单/检索归因消费
      edition: (repo.edition ?? '') !== '' ? repo.edition : null,
      editionLabel: (repo.edition ?? '') !== '' ? deriveEditionLabel(repo.repoProfile) : null,
      verified: repo.isVerified,
      stars: repo.starCount,
      sourceType: isWeb ? 'web' : 'github',
      sourceUrl,
      lastSyncedAt,
    },
    contentProfile: {
      repoType: profile.repoType || (isWeb ? 'web-docs' : 'docs'),
      ingestMode: profile.ingestMode || 'hybrid',
      tier: profile.tier || 'A',
      docCodeRatio: {
        docFiles: profile.docCodeRatio?.docFiles || 0,
        codeFiles: profile.docCodeRatio?.codeFiles || 0,
        ratio: profile.docCodeRatio?.ratio || 0,
      },
      totalDocuments: repo.documents.length,
      totalChapters: chapters.length,
      graphStats: await computeGraphStats(repo.id, repo.repoProfile, {
        light: opts?.graphStatsLight === true,
      }),
    },
    techStack: codebaseProfile
      ? {
          primaryLanguages: codebaseProfile.primaryLanguages || [],
          framework: codebaseProfile.framework || null,
          architectureStyle: codebaseProfile.architectureStyle || 'single_package',
          hasTests: codebaseProfile.hasTests || false,
          testFramework: codebaseProfile.testFramework || null,
          entryPoints: codebaseProfile.entryPoints || [],
        }
      : null,
    teachingCapabilities: {
      chapters,
      contentDimensions,
    },
    bestUsedFor: repo.bestUsedFor && repo.bestUsedFor.length > 0
      ? repo.bestUsedFor
      : (isWeb
          ? [
              `Consult official ${displayName} API reference, configuration, and guides`,
              `Verify accurate usage patterns and official best practices for ${displayName}`,
              `Search documentation and tutorials for ${displayName}`,
            ]
          : [
              `Learn ${repo.owner}/${repo.repo} architectural patterns and concepts`,
              `Reference code examples and API usage for ${repo.repo}`,
              `Understand project structure and key features`,
            ]),
    mcpEndpoint: {
      url: `/api/mcp/${repo.owner}/${repo.repo}`,
      availableTools: [...MCP_AVAILABLE_TOOLS],
    },
  };
}

export async function buildBookshelfManifest(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      savedRepos: {
        select: {
          repository: {
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  const repoIds = user?.savedRepos?.map((sr) => sr.repository.id) ?? [];
  if (repoIds.length === 0) {
    return [];
  }

  // 书架批量：图谱指标用 light 模式（N 仓 fan-out 只取两个 count，防查询放大）
  const manifestPromises = repoIds.map(id => buildCapabilityManifest(id, { graphStatsLight: true }));
  const manifests = await Promise.all(manifestPromises);
  return manifests.filter(Boolean) as TutorialCapabilityManifest[];
}
