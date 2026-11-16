import { defineRoute, ok } from '@/lib/api/server/define-route';
import { prisma } from '@/lib/db';
import { MCP_QUERY_STATUS } from '@/lib/constants';

/**
 * MCP 调用明细流（隐私安全版 + 用户隔离）。
 * 数据源为 McpCallLog：仅工具名/仓库/维度/状态/命中数/耗时，无原始查询词。
 * 普通用户只能读取自己（token 解析所得 userId）的调用记录，admin 可看全量。
 * 响应结构与前端 McpQueryLogStream 兼容（logs + pagination）。
 */
export const GET = defineRoute({
  scope: 'GET /api/mcp/query-logs',
  auth: 'user',
  handler: async ({ userId, request }) => {
    const url = new URL(request.url);
    const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(url.searchParams.get('pageSize') || '15', 10) || 15, 1), 100);
    const repositoryId = url.searchParams.get('repositoryId') || undefined;
    const toolName = url.searchParams.get('toolName') || undefined;
    const dimension = url.searchParams.get('dimension') || undefined;
    const search = url.searchParams.get('search') || undefined;
    const isBlindSpot = url.searchParams.get('isBlindSpot') === 'true';
    const status = url.searchParams.get('status') || undefined;

    const where: any = {};
    // 用户隔离：普通用户只能看自己的调用明细（userId 由 guard 写入 McpCallLog）；
    // admin 放行全量平台日志。跨用户翻他人调用流水属信息泄露。
    const viewer = await prisma.user.findUnique({
      where: { id: userId! },
      select: { role: true },
    });
    const isAdmin = viewer?.role === 'ADMIN' || viewer?.role === 'SUPER_ADMIN';
    if (!isAdmin) where.userId = userId;
    if (repositoryId) where.repositoryId = repositoryId;
    if (toolName) where.toolName = toolName;
    if (dimension) where.dimension = dimension;
    if (isBlindSpot) where.status = MCP_QUERY_STATUS[2];
    else if (status) where.status = status;
    if (search) where.toolName = { contains: search, mode: 'insensitive' };

    const [logs, total] = await Promise.all([
      prisma.mcpCallLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.mcpCallLog.count({ where }),
    ]);

    // 仓库名映射（仅 id → owner/repo，用于前端展示归因）
    const repoIds = [...new Set(logs.map((l) => l.repositoryId).filter(Boolean))] as string[];
    const repos =
      repoIds.length > 0
        ? await prisma.repository.findMany({
            where: { id: { in: repoIds } },
            select: { id: true, owner: true, repo: true },
          })
        : [];
    const repoMap = new Map(repos.map((r) => [r.id, r]));

    const items = logs.map((log) => ({
      id: log.id,
      repositoryId: log.repositoryId,
      repository:
        log.repositoryId && repoMap.has(log.repositoryId)
          ? { owner: repoMap.get(log.repositoryId)!.owner, name: repoMap.get(log.repositoryId)!.repo }
          : null,
      toolName: log.toolName,
      query: '', // 隐私安全：不存储/不返回原始查询词
      dimension: log.dimension,
      tokenBudget: 0,
      tokensReturned: 0,
      resultCount: log.resultCount,
      isBlindSpot: log.status === MCP_QUERY_STATUS[2],
      responseTimeMs: log.responseTimeMs,
      status: log.status,
      requestedEdition: log.requestedEdition ?? null,
      resolvedEdition: log.resolvedEdition ?? null,
      isFallback: log.isFallback ?? false,
      errorMessage: null,
      resultSnapshot: null,
      createdAt: log.createdAt.toISOString(),
    }));

    return ok({
      logs: items,
      pagination: {
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        page,
        pageSize,
      },
    });
  },
});
