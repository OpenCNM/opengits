import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { UpsertUserModelProviderSchema } from '@/types/user-model-provider';
import { encryptApiKey } from '@/lib/crypto/api-key-cipher';
import { invalidateUserModelCache } from '@/lib/ai/user-model-resolver';
import { callSidecar, SidecarError } from '@/lib/sidecar-client';

export const dynamic = 'force-dynamic';

interface UserModelProviderView {
  id: string;
  providerKey: string;
  name: string;
  baseUrl: string;
  maskedApiKey: string;
  hasApiKey: boolean;
  apiFormat: string;
  models: string[];
  selectedModel: string;
  isActive: boolean;
  healthStatus: string;
  latencyMs: number | null;
  lastError: string | null;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserModelProvidersListSidecarResponse {
  ok: boolean;
  providers: UserModelProviderView[];
  error?: string;
}

interface UserModelProviderUpsertSidecarResponse {
  ok: boolean;
  provider?: UserModelProviderView;
  error?: string;
  code?: string;
}

interface UserModelProviderPatchSidecarResponse {
  ok: boolean;
  provider?: UserModelProviderView;
  error?: string;
  code?: string;
}

interface UserModelProviderDeleteSidecarResponse {
  ok: boolean;
  deleted?: boolean;
  error?: string;
  code?: string;
}

async function callSidecarSafe<T>(path: string, payload: unknown, label: string): Promise<T> {
  try {
    return await callSidecar<T>(path, payload, { label });
  } catch (err) {
    if (err instanceof SidecarError) {
      if (err.status === 400) {
        if (err.message.includes('API_KEY_REQUIRED') || err.message.includes('必须填写 API Key')) {
          throw ApiError.badRequest('新增配置必须填写 API Key', { code: 'API_KEY_REQUIRED' });
        }
        if (err.message.includes('PROVIDER_KEY_REQUIRED') || err.message.includes('providerKey is required')) {
          throw ApiError.badRequest('providerKey is required', { code: 'PROVIDER_KEY_REQUIRED' });
        }
        throw ApiError.badRequest(err.message);
      }
      if (err.status === 404) {
        throw ApiError.notFound('Provider not found', { code: 'PROVIDER_NOT_FOUND' });
      }
      if (err.status === 401) {
        throw ApiError.unauthorized();
      }
    }
    throw err;
  }
}

// GET: 获取当前登录用户的多服务商模型配置列表（密钥仅掩码形态返回）
export const GET = defineRoute({
  scope: 'GET /api/user/model-providers',
  auth: 'user',
  handler: async ({ userId }) => {
    if (!userId) throw ApiError.unauthorized();

    const res = await callSidecarSafe<UserModelProvidersListSidecarResponse>(
      '/v1/user/model-providers/list',
      { userId },
      'user/model-providers /v1/user/model-providers/list'
    );

    return ok({ providers: res.providers ?? [] });
  },
});

// POST: 添加或更新服务商聚合配置（apiKey 落库前 AES-256-GCM 加密；空 key = 编辑保留旧值）
export const POST = defineRoute({
  scope: 'POST /api/user/model-providers',
  auth: 'user',
  bodySchema: UpsertUserModelProviderSchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const { providerKey, name, baseUrl, apiKey, apiFormat, models, selectedModel, isActive } = body;
    const trimmedKey = apiKey?.trim() ?? '';
    const encryptedApiKey = trimmedKey ? encryptApiKey(trimmedKey) : '';

    const res = await callSidecarSafe<UserModelProviderUpsertSidecarResponse>(
      '/v1/user/model-providers/upsert',
      {
        userId,
        providerKey,
        name,
        baseUrl,
        encryptedApiKey,
        apiFormat,
        models,
        selectedModel,
        isActive,
      },
      'user/model-providers /v1/user/model-providers/upsert'
    );

    invalidateUserModelCache(userId);
    return ok({ provider: res.provider! });
  },
});

// PATCH: 一键设为全局默认服务商 / 切换厂商内主模型
export const PATCH = defineRoute({
  scope: 'PATCH /api/user/model-providers',
  auth: 'user',
  bodySchema: z.object({
    providerKey: z.string().min(1),
    selectedModel: z.string().min(1).optional(),
    makeActive: z.boolean().optional(),
  }),
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const { providerKey, selectedModel, makeActive } = body;

    const res = await callSidecarSafe<UserModelProviderPatchSidecarResponse>(
      '/v1/user/model-providers/patch',
      {
        userId,
        providerKey,
        selectedModel,
        makeActive,
      },
      'user/model-providers /v1/user/model-providers/patch'
    );

    invalidateUserModelCache(userId);
    return ok({ provider: res.provider ?? null });
  },
});

// DELETE: 移除指定厂商配置（具备删除激活厂商时的自动提拔与安全归零防御）
export const DELETE = defineRoute({
  scope: 'DELETE /api/user/model-providers',
  auth: 'user',
  handler: async ({ request, userId }) => {
    if (!userId) throw ApiError.unauthorized();

    const { searchParams } = new URL(request.url);
    const providerKey = searchParams.get('providerKey');
    if (!providerKey) {
      throw ApiError.badRequest('providerKey is required', { code: 'PROVIDER_KEY_REQUIRED' });
    }

    await callSidecarSafe<UserModelProviderDeleteSidecarResponse>(
      '/v1/user/model-providers/delete',
      {
        userId,
        providerKey,
      },
      'user/model-providers /v1/user/model-providers/delete'
    );

    invalidateUserModelCache(userId);
    return ok({ deleted: true });
  },
});
