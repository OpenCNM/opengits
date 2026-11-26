import { prisma } from '@/lib/db';
import { TtlCache } from '@/lib/cache/ttl-cache';

export interface GlobalToolPolicy {
  toolName: string;
  isEnabled: boolean;
  tokenBudget: number;
  customDescription?: string | null;
  tierRequirement: string;
}

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
    // Fail closed on policy load error; degrading to an empty map would silently disable admin tool bans and tier caps.
  });
}
