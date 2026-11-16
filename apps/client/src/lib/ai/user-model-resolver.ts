import { prisma } from '@/lib/db';
import { tryDecryptApiKey } from '@/lib/crypto/api-key-cipher';
import { getModel, MissingApiKeyError } from '@/lib/ai';
import { ENGINE_CONFIG } from '@/lib/config';
import { TtlCache } from '@/lib/cache/ttl-cache';
import {
  USER_MODEL_CACHE_TTL_MS,
  USER_MODEL_NEGATIVE_CACHE_TTL_MS,
  USER_MODEL_CACHE_MAX_ENTRIES,
  AI_PROVIDER_PRESETS,
} from '@/lib/constants';

/**
 * 模型候选通道（支持多服务商级联降级）
 */
export interface ModelCandidate {
  provider: string;
  modelId: string;
  label?: string;
  apiKey?: string;
  baseURL?: string;
  apiFormat?: 'openai' | 'anthropic';
}

/**
 * 教学代码转录标准级联拓扑（主用 -> 备用一 -> 备用二）
 */
export const DEFAULT_TRANSCRIPTION_CASCADE: ModelCandidate[] = [
  { provider: 'deepseek', modelId: 'deepseek-chat', label: 'DeepSeek V3 (主用)' },
  { provider: 'dashscope', modelId: 'qwen-plus', label: '通义千问 Plus (备选一)' },
  { provider: 'zhipu', modelId: 'glm-4-flash', label: '智谱 GLM-4 Flash (备选二)' },
];

/**
 * BYOK 用户模型解析（Phase C1）：
 * 把「当前激活的 UserModelProvider」解密成一份可直接注入 LLM 调用的明文配置。
 *
 * 优先级语义（与 document-processor 的模型链配合）：
 *   调用方显式 model > 用户激活服务商的 selectedModel > repoProfile > 默认模型
 * 注意：仅激活项（缩小解密面）；解密失败或未配置返回 null。
 */
interface ResolvedUserModel {
  provider: string;
  modelId: string;
  apiKey: string;
  baseURL: string;
  apiFormat: 'openai' | 'anthropic';
}

const userModelCache = new TtlCache<ResolvedUserModel | null>(
  USER_MODEL_CACHE_TTL_MS,
  USER_MODEL_CACHE_MAX_ENTRIES
);

const userModelCascadeCache = new TtlCache<ResolvedUserModel[]>(
  USER_MODEL_CACHE_TTL_MS,
  USER_MODEL_CACHE_MAX_ENTRIES
);

/** 显式清除指定用户的模型解析缓存（配置增删改查时调用） */
export function invalidateUserModelCache(userId: string): void {
  if (userId) {
    userModelCache.delete(userId);
    userModelCascadeCache.delete(userId);
  }
}

/** 清空全部模型缓存（测试与演练用） */
export function clearUserModelCache(): void {
  userModelCache.clear();
  userModelCascadeCache.clear();
}

export async function resolveActiveUserModel(
  userId?: string | null
): Promise<ResolvedUserModel | null> {
  if (!userId) return null;

  return userModelCache.getOrLoad(
    userId,
    async () => {
      const active = await prisma.userModelProvider.findFirst({
        where: { userId, isActive: true },
        select: {
          providerKey: true,
          baseUrl: true,
          apiKey: true,
          apiFormat: true,
          selectedModel: true,
        },
      });
      if (!active || !active.apiKey) return null;

      const apiKey = tryDecryptApiKey(active.apiKey);
      if (!apiKey) return null;

      return {
        provider: active.providerKey,
        modelId: active.selectedModel,
        apiKey,
        baseURL: active.baseUrl,
        apiFormat: active.apiFormat as 'openai' | 'anthropic',
      };
    },
    (val) => (val === null ? USER_MODEL_NEGATIVE_CACHE_TTL_MS : USER_MODEL_CACHE_TTL_MS)
  );
}

/**
 * 获取用户配置的所有可用模型服务商有序链表（主用激活项排在首位，其余作为备选通道）
 */
export async function resolveUserModelCascade(
  userId?: string | null
): Promise<ResolvedUserModel[]> {
  if (!userId) return [];

  return userModelCascadeCache.getOrLoad(
    userId,
    async () => {
      const providers = await prisma.userModelProvider.findMany({
        where: { userId },
        orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
        select: {
          providerKey: true,
          baseUrl: true,
          apiKey: true,
          apiFormat: true,
          selectedModel: true,
          isActive: true,
        },
      });

      const list: ResolvedUserModel[] = [];
      for (const p of providers) {
        if (!p.apiKey) continue;
        const apiKey = tryDecryptApiKey(p.apiKey);
        if (!apiKey) continue;
        list.push({
          provider: p.providerKey,
          modelId: p.selectedModel || AI_PROVIDER_PRESETS[p.providerKey]?.defaultModel || 'default',
          apiKey,
          baseURL: p.baseUrl || AI_PROVIDER_PRESETS[p.providerKey]?.baseUrl || '',
          apiFormat: (p.apiFormat as 'openai' | 'anthropic') || 'openai',
        });
      }
      return list;
    },
    (val) => (val.length === 0 ? USER_MODEL_NEGATIVE_CACHE_TTL_MS : USER_MODEL_CACHE_TTL_MS)
  );
}

/**
 * Scout 链路 BYOK 总开关（安全阀）：设为 '1' 时 scout 禁用 BYOK。
 */
export function isScoutByokEnabled(): boolean {
  return process.env.SCOUT_BYOK_DISABLED !== '1';
}

/**
 * 把用户模型转成 generateStructured 的 model 注入对象。
 * 无有效模型或非 openai 格式返回 undefined。
 */
export function toInjectableStructuredModel(
  userModel: ResolvedUserModel | ModelCandidate | null
): ReturnType<typeof getModel> | undefined {
  if (!userModel || !isScoutByokEnabled()) return undefined;
  if (userModel.apiFormat && userModel.apiFormat !== 'openai') return undefined;
  if (!userModel.apiKey) return undefined;
  return getModel(userModel.provider, userModel.modelId, {
    apiKey: userModel.apiKey,
    baseURL: userModel.baseURL,
    apiFormat: userModel.apiFormat,
  });
}
