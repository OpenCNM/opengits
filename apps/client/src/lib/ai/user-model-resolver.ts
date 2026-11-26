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

export interface ModelCandidate {
  provider: string;
  modelId: string;
  label?: string;
  apiKey?: string;
  baseURL?: string;
  apiFormat?: 'openai' | 'anthropic';
}

export const DEFAULT_TRANSCRIPTION_CASCADE: ModelCandidate[] = [
  { provider: 'deepseek', modelId: 'deepseek-chat', label: 'DeepSeek V3 (主用)' },
  { provider: 'dashscope', modelId: 'qwen-plus', label: '通义千问 Plus (备选一)' },
  { provider: 'zhipu', modelId: 'glm-4-flash', label: '智谱 GLM-4 Flash (备选二)' },
];

// Only decrypts the active provider row to minimize plaintext key exposure; fails closed on missing/corrupt keys.
export interface ResolvedUserModel {
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

export function invalidateUserModelCache(userId: string): void {
  if (userId) {
    userModelCache.delete(userId);
    userModelCascadeCache.delete(userId);
  }
}

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

export async function inspectUserModelKeyStatus(
  userId?: string | null
): Promise<{ status: 'ok' | 'missing' | 'decrypt_failed'; provider?: string; modelId?: string }> {
  if (!userId) return { status: 'missing' };

  const selectFields = {
    providerKey: true,
    apiKey: true,
    selectedModel: true,
  } as const;

  let rows: Array<{ providerKey: string; apiKey: string; selectedModel: string }> = [];
  if (typeof prisma.userModelProvider.findMany === 'function') {
    rows = await prisma.userModelProvider.findMany({
      where: { userId },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
      select: selectFields,
    });
  } else {
    const first = await prisma.userModelProvider.findFirst({
      where: { userId },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
      select: selectFields,
    });
    if (first) rows = [first];
  }

  let firstDecryptFailed: { provider: string; modelId: string } | null = null;
  for (const row of rows) {
    if (!row.apiKey || !row.apiKey.trim()) continue;
    const decrypted = tryDecryptApiKey(row.apiKey);
    if (decrypted) {
      return { status: 'ok', provider: row.providerKey, modelId: row.selectedModel };
    }
    if (!firstDecryptFailed) {
      firstDecryptFailed = { provider: row.providerKey, modelId: row.selectedModel };
    }
  }

  if (firstDecryptFailed) {
    console.warn(
      `[user-model-resolver] stored API key failed to decrypt for userId=${userId} provider=${firstDecryptFailed.provider} model=${firstDecryptFailed.modelId}`
    );
    return {
      status: 'decrypt_failed',
      provider: firstDecryptFailed.provider,
      modelId: firstDecryptFailed.modelId,
    };
  }

  return { status: 'missing' };
}

// Emergency kill-switch ('1') disables BYOK during scout.
export function isScoutByokEnabled(): boolean {
  return process.env.SCOUT_BYOK_DISABLED !== '1';
}

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

export type UserKeyResolution =
  | { ok: true; model: ResolvedUserModel }
  | {
      ok: false;
      code: 'MISSING_API_KEY' | 'KEY_DECRYPT_FAILED';
      provider?: string;
      modelId?: string;
    };

// Propagate DB/infra errors rather than misdiagnosing outages as MISSING_API_KEY.
export async function resolveUserModelWithKeyStatus(
  userId?: string | null
): Promise<UserKeyResolution> {
  const model = await resolveActiveUserModel(userId);
  if (model) return { ok: true, model };
  const status = await inspectUserModelKeyStatus(userId);
  if (status.status === 'decrypt_failed') {
    return {
      ok: false,
      code: 'KEY_DECRYPT_FAILED',
      provider: status.provider,
      modelId: status.modelId,
    };
  }
  return { ok: false, code: 'MISSING_API_KEY' };
}
