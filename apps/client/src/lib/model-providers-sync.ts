import type { UserModelProviderDTO } from '@/types/user-model-provider';

export function mergeCloudProviders(
  cloud: UserModelProviderDTO[],
  local: UserModelProviderDTO[]
): UserModelProviderDTO[] {
  if (!cloud.length) return local;

  const localByKey = new Map(local.map((p) => [p.providerKey, p]));

  const merged = cloud.map((c) => {
    if (c.apiKey) return c;
    const l = localByKey.get(c.providerKey);
    if (l?.apiKey) {
      return { ...c, apiKey: l.apiKey };
    }
    return c;
  });

  const cloudKeys = new Set(cloud.map((c) => c.providerKey));
  const localOnly = local.filter((p) => !cloudKeys.has(p.providerKey));
  return [...merged, ...localOnly];
}

export function runtimeApiKeyToWrite(active: UserModelProviderDTO | undefined): string | null | 'CLEAR' {
  if (!active) return 'CLEAR';
  if (active.apiKey && active.apiKey.trim()) return active.apiKey;
  return null;
}
