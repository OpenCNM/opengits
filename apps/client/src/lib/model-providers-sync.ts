import type { UserModelProviderDTO } from '@/types/user-model-provider';

/**
 * 云端/本地多服务商配置合并（Phase A 密钥安全改造的核心守卫）。
 *
 * 背景：云端 GET 响应不再回传明文 apiKey（只有 maskedApiKey + hasApiKey）。
 * 若照旧"云端整表覆盖本地"，会把 localStorage 里现存的明文 key 抹成 undefined，
 * 直接炸掉聊天链路（InkSpirit 读 VAR_API_KEY）。因此云端记录缺明文时，按
 * providerKey 从本地副本继承 apiKey——结构以云端为准，密钥明文以本地为准。
 *
 * 同时补齐纯本地新增（离线添加、尚未上云）的记录，避免整表覆盖丢配置。
 * 本模块必须保持纯函数、零服务端依赖（客户端组件直接引用）。
 */
export function mergeCloudProviders(
  cloud: UserModelProviderDTO[],
  local: UserModelProviderDTO[]
): UserModelProviderDTO[] {
  if (!cloud.length) return local;

  const localByKey = new Map(local.map((p) => [p.providerKey, p]));

  const merged = cloud.map((c) => {
    if (c.apiKey) return c; // 云端自带明文（理论不存在，防御性保留）
    const l = localByKey.get(c.providerKey);
    if (l?.apiKey) {
      // 保留本地明文副本，其余字段以云端为权威
      return { ...c, apiKey: l.apiKey };
    }
    return c;
  });

  // 本地独有（尚未上云）的记录追加在尾部，isActive 以云端已有激活项优先
  const cloudKeys = new Set(cloud.map((c) => c.providerKey));
  const localOnly = local.filter((p) => !cloudKeys.has(p.providerKey));
  return [...merged, ...localOnly];
}

/**
 * 运行时 key 写入守卫：active.apiKey 为空（云端拉取的掩码记录）时
 * 绝不把空值/undefined 写进 VAR_API_KEY（localStorage 会字面量存成 "undefined"）。
 * 返回应写入的值；null 表示保持现状不动。
 */
export function runtimeApiKeyToWrite(active: UserModelProviderDTO | undefined): string | null | 'CLEAR' {
  if (!active) return 'CLEAR';
  if (active.apiKey && active.apiKey.trim()) return active.apiKey;
  return null; // 无明文：保留 localStorage 现状（用户本机副本或历史 key）
}
