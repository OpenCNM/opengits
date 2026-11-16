// 教程文档行解析（真冻结读取语义的统一入口）。
//
// 为什么是显式两步查找而非单查询 + orderBy：
// 1. 私有行（ownerUserId=用户）优先于共享行（ownerUserId=null）的语义不能依赖
//    数据库对 NULL 的排序行为（各库/版本不一致）；
// 2. 规避对象字面量陷阱——此前主查询 spread 可见性过滤后又写显式 OR（path 匹配），
//    后者覆盖了前者的 OR，登录用户实际可命中他人私有行。

import { prisma } from './db';

/**
 * 主查询统一 include：仓库元数据 + 内容层正文（内容寻址 Phase 4）。
 * repository 显式 select 收窄：整行含 navTree/skeleton/reviewPipeline/reviewLlm
 * 大 Json 列（TOAST 解压），而文档热路径（docs-page-loader + docs page）只消费
 * 下列字段。注意 loader 返回值经 `as any` 放宽，tsc 不兜底——新增消费字段
 * 必须同步加进此 select（字段清单核对见 2026-10-13 性能修复）。
 */
const DOC_INCLUDE = {
  repository: {
    select: {
      id: true,
      owner: true,
      repo: true,
      branch: true,
      isPublic: true,
      relayEnabled: true,
      gitSha: true,
      hasUpstreamUpdate: true,
      autoSyncEnabled: true,
      publishedAt: true,
      reviewStatus: true,
      rejectionReason: true,
      repoProfile: true,
      transcriptionModels: true,
    },
  },
  contentRef: { select: { content: true } },
} as const;

function queryDoc(where: { repository: { id: string }; ownerUserId: string | null; OR?: Array<{ path: string }> }) {
  return prisma.document.findFirst({ where, include: DOC_INCLUDE });
}

export type VisibleDoc = Awaited<ReturnType<typeof queryDoc>>;

/**
 * 按可见性与优先级解析教程文档行：
 * - 登录用户：先查自己的私有行，未命中回落共享行
 * - 游客：仅共享行
 * @param pathCandidates 依次尝试的 path 列表（如 [relativePath, rawPath]）
 */
export async function findVisibleDoc(
  repoWhere: { id: string },
  pathCandidates: string[],
  userId?: string | null
): Promise<VisibleDoc> {
  const paths = pathCandidates.filter(Boolean);
  if (paths.length === 0) return null;
  const orPaths = { OR: paths.map((p) => ({ path: p })) };

  if (userId) {
    const own = await prisma.document.findFirst({
      where: { repository: repoWhere, ownerUserId: userId, ...orPaths },
      include: DOC_INCLUDE,
    });
    if (own) return own;
  }
  return prisma.document.findFirst({
    where: { repository: repoWhere, ownerUserId: null, ...orPaths },
    include: DOC_INCLUDE,
  });
}
