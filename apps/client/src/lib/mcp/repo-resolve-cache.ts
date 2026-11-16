import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { resolveRepository, ResolvedRepositoryResult } from '@/lib/repository-resolver';
import { repositoryDocsInclude } from './repo-tools';
import { TtlCache } from '@/lib/cache/ttl-cache';

/**
 * ─────────────────────────────────────────────────────────────
 * MCP 热路径缓存层（B1 拆分后 mcp 单实例长驻，进程内缓存安全且高收益）
 *
 * stateless 模式每个请求（含 initialize/tools/list 握手）都重新执行：
 *   resolveRepository（1-2 次重查询，含 navTree 大列与文档元数据 include）
 *   + 路由层 defaultBranch 仓检查。同一 Agent 会话内这些数据不变——
 * 典型流量形态是「同一用户连续打同一仓」，缓存命中率天然高。
 *
 * 缓存口径（staleness ≤ MCP_HOT_CACHE_TTL_MS）：
 * - 缓存：仓解析结果（null 未命中也缓存，挡扫描型 miss）、defaultBranch 仓行
 * - 不缓存：鉴权 token、封禁/RPM/日配额（实时执行）、文档正文（按需懒加载不变）
 * - 生效延迟：admin 下架仓（mcpStatus）/改公开性 ≤60s 生效——可接受的产品语义
 * - 返回的 Prisma 行为跨请求共享只读对象，调用方禁止原地修改
 * ─────────────────────────────────────────────────────────────
 */

/** 仓解析缓存：key 含 userId（repositoryDocsInclude 的私有副本可见性按用户区分） */
const resolveCache = new TtlCache<ResolvedRepositoryResult | null>();

export async function resolveRepositoryMcpCached(
  owner: string,
  repo: string,
  versionOrBranch?: string,
  edition?: string,
  userId?: string | null
): Promise<ResolvedRepositoryResult | null> {
  const key = JSON.stringify([owner, repo, versionOrBranch ?? '', edition ?? '', userId ?? '']);
  return resolveCache.getOrLoad(key, () =>
    resolveRepository(owner, repo, versionOrBranch, edition, repositoryDocsInclude(userId))
  );
}

/** 路由层 defaultBranch 仓检查缓存：与 route.ts 原 findFirst 完全同参（无 include） */
const routeCheckCache = new TtlCache<Awaited<ReturnType<typeof prisma.repository.findFirst>>>();

export async function cachedDefaultBranchRepository(owner: string, repo: string) {
  return routeCheckCache.getOrLoad(JSON.stringify([owner, repo]), async () => {
    const primary = await prisma.repository.findFirst({
      where: { owner, repo, branch: ENGINE_CONFIG.defaultBranch },
    });
    if (primary) return primary;
    return prisma.repository.findFirst({
      where: { owner, repo },
      orderBy: { updatedAt: 'desc' },
    });
  });
}
