import { prisma } from '@/lib/db';
import { TtlCache } from '@/lib/cache/ttl-cache';

export interface GlobalToolPolicy {
  toolName: string;
  isEnabled: boolean;
  tokenBudget: number;
  customDescription?: string | null;
  tierRequirement: string;
}

/**
 * 加载所有全局工具控制策略（包含重载说明、一键开关与 Token 预算）。
 * 供 repo-tools 的 isToolEnabled / getToolDesc / policyTokenCap 门禁标准
 * 6 大 MCP 工具使用（tokenBudget 由 wrapToolTelemetry 与用户级上限取小执行）。
 *
 * stateless 模式每请求重建工具注册都要拉一次策略表——60s TTL 进程内缓存
 * 砍掉这条固定查询（admin 改策略 ≤60s 生效；失败不缓存，下次重试）。
 *
 * 注：声明式动态 REST 工具（DynamicMcpTool + executeDynamicHttpTool）已移除——
 * 它构成 SSRF 链（任意用户注册 targetUrl，无内网/元数据主机黑名单）。
 */
const policyCache = new TtlCache<Map<string, GlobalToolPolicy>>();

export async function getGlobalToolPolicies(): Promise<Map<string, GlobalToolPolicy>> {
  return policyCache.getOrLoad('global', async () => {
    const policies = await prisma.globalMcpToolPolicy.findMany();
    const policyMap = new Map<string, GlobalToolPolicy>();
    for (const p of policies) {
      policyMap.set(p.toolName, {
        toolName: p.toolName,
        isEnabled: p.isEnabled,
        tokenBudget: p.tokenBudget,
        customDescription: p.customDescription,
        tierRequirement: p.tierRequirement || 'FREE',
      });
    }
    return policyMap;
    // 失效封闭：策略表加载失败必须上抛（getOrLoad 失败不落缓存，下次重试）。
    // 严禁吞错降级为空表——那会让 admin 的工具禁用与 tier 门禁在 DB 抖动时静默失效（fail-open）。
  });
}
