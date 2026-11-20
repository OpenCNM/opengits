import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { tryDecryptApiKey } from '@/lib/crypto/api-key-cipher';
import { callSidecar } from '@/lib/sidecar-client';
import { isPublicHttpEndpoint } from '@/lib/url-inspector';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';

const TestProviderSchema = z.object({
  name: z.string().optional(),
  // SSRF 防护：本端点会以 baseUrl 为目标发起服务端请求，禁止私网/回环/云元数据
  baseUrl: z.string().min(1, 'Base URL is required').refine(isPublicHttpEndpoint, 'Base URL cannot point to private or loopback addresses'),
  /** 明文 key（表单实时测速）；空则按 providerKey 从云端配置解密自取（已保存项测速） */
  apiKey: z.string().optional(),
  providerKey: z.string().optional(),
  apiFormat: z.enum(['openai', 'anthropic']).default('openai'),
  model: z.string().min(1, 'Model name is required'),
});

interface ProviderTestParams {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface ProviderTestResult {
  message: string;
  preview?: string;
}

interface ProviderTesterStrategy {
  test(params: ProviderTestParams): Promise<ProviderTestResult>;
}

class OpenAIProviderTester implements ProviderTesterStrategy {
  async test({ baseUrl, apiKey, model }: ProviderTestParams): Promise<ProviderTestResult> {
    const customProvider = createOpenAI({
      apiKey,
      baseURL: baseUrl,
    });

    const aiModel = customProvider.chat(model);
    try {
      // [直连说明] 诊断端点必须绕过 ai.ts 漏斗直连裸 SDK——本端点测的就是 provider 本身（漏斗的熔断/降级反而会污染诊断结果）
      const textResult = await generateText({
        model: aiModel,
        prompt: 'Say OK',
      });

      return {
        message: 'Connection successful, model responded',
        preview: textResult.text?.trim() || 'OK',
      };
    } catch (err) {
      throw toProviderTestError(err);
    }
  }
}

class AnthropicProviderTester implements ProviderTesterStrategy {
  async test({ baseUrl, apiKey, model }: ProviderTestParams): Promise<ProviderTestResult> {
    const endpointUrl = baseUrl.endsWith('/messages') ? baseUrl : `${baseUrl}/v1/messages`;

    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    if (!response.ok) {
      const errorJson = await response.json().catch(() => null);
      const errorText = errorJson?.error?.message || response.statusText || `HTTP ${response.status}`;
      throw new ProviderTestError(errorText, response.status);
    }

    return {
      message: 'Connection successful, model responded',
    };
  }
}

/** 服务商测速失败的原始错误；携带 HTTP 状态码供 ERROR_RULES 按状态精确映射 */
class ProviderTestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderTestError';
    this.status = status;
  }
}

function toProviderTestError(err: unknown): ProviderTestError {
  if (err instanceof ProviderTestError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // AI SDK 的 APICallError 以 statusCode 字段携带 HTTP 状态，结构探测以免依赖具体错误类
  const status =
    err instanceof Error && 'statusCode' in err && typeof err.statusCode === 'number'
      ? err.statusCode
      : undefined;
  return new ProviderTestError(message, status);
}

const PROVIDER_TESTERS: Record<'openai' | 'anthropic', ProviderTesterStrategy> = {
  openai: new OpenAIProviderTester(),
  anthropic: new AnthropicProviderTester(),
};

// status 精确匹配优先（服务商 HTTP 语义稳定），pattern 只兜底无状态码的网络层错误；
// 裸文本（如 "not found"）不再参与映射，避免把 400 的 "Invalid model: not found" 误报成 404
const ERROR_RULES: Array<{ status?: number; pattern?: RegExp; code: string; message: string }> = [
  { status: 401, code: 'INVALID_API_KEY', message: 'API key authentication failed' },
  { status: 403, code: 'ACCESS_FORBIDDEN', message: 'Provider denied access to this model' },
  { status: 404, code: 'BASE_URL_NOT_FOUND', message: 'Base URL endpoint not found (404)' },
  { status: 429, code: 'QUOTA_EXCEEDED', message: 'Provider quota exceeded or rate limited (429)' },
  { pattern: /unauthorized|incorrect api key|invalid_api_key/i, code: 'INVALID_API_KEY', message: 'API key authentication failed' },
  { pattern: /ENOTFOUND|ECONNREFUSED|fetch failed|timeout/i, code: 'CONNECTION_FAILED', message: 'Cannot connect to Base URL' },
  { pattern: /model_not_found|does not exist/i, code: 'MODEL_NOT_FOUND', message: 'Specified model not found' },
];

function resolveFriendlyError(err: unknown): { code: string; message: string; detail?: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const status = extractErrorStatus(err);
  const byStatus = status !== undefined ? ERROR_RULES.find((r) => r.status === status) : undefined;
  const matched = byStatus ?? ERROR_RULES.find((r) => r.pattern?.test(raw));
  if (!matched) {
    return { code: 'PROVIDER_TEST_FAILED', message: raw };
  }
  // 原始错误保留在 detail 旁路，避免友好文案吞掉服务商的真实提示
  return { code: matched.code, message: matched.message, detail: raw };
}

function extractErrorStatus(err: unknown): number | undefined {
  if (err instanceof ProviderTestError) return err.status;
  if (err instanceof Error && 'statusCode' in err && typeof err.statusCode === 'number') {
    return err.statusCode;
  }
  return undefined;
}

export const POST = defineRoute({
  scope: 'POST /api/ai/test-provider',
  auth: 'user',
  bodySchema: TestProviderSchema,
  handler: async ({ body, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();

    const { baseUrl, apiKey, providerKey, apiFormat, model } = body;
    const sanitizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
    const sanitizedModel = model.trim();

    let sanitizedApiKey = apiKey?.trim() || '';
    let cloudCipherDecryptFailed = false;
    if (!sanitizedApiKey && providerKey) {
      try {
        const res = await callSidecar<{ ok: boolean; apiKey?: string }>(
          '/v1/user/model-providers/get-cipher',
          { userId, providerKey },
          { label: 'ai/test-provider /v1/user/model-providers/get-cipher' }
        );
        if (res.apiKey) {
          const decrypted = tryDecryptApiKey(res.apiKey);
          if (decrypted) {
            sanitizedApiKey = decrypted;
          } else {
            // 密文在但解不开：真根因是环境密钥变更，不是"未配置"（批次 B 收口）
            cloudCipherDecryptFailed = true;
          }
        }
      } catch {
        sanitizedApiKey = '';
      }
    }
    if (!sanitizedApiKey) {
      if (cloudCipherDecryptFailed) {
        throw ApiError.fromCode('KEY_DECRYPT_FAILED');
      }
      throw ApiError.badRequest('apiKey: API Key is required (none found in cloud config)', { code: 'MISSING_API_KEY' });
    }

    // apiFormat 已被 zod enum 收敛为 'openai' | 'anthropic'，注册表必然命中
    const tester = PROVIDER_TESTERS[apiFormat];
    const startTime = Date.now();

    try {
      const result = await tester.test({
        baseUrl: sanitizedBaseUrl,
        apiKey: sanitizedApiKey,
        model: sanitizedModel,
      });

      const latencyMs = Date.now() - startTime;

      return ok({ latencyMs, message: result.message, preview: result.preview });
    } catch (err: unknown) {
      // ERROR_RULES 友好映射保留；改抛 ApiError 走统一失败信封（原始错误在 detail 旁路，经 sanitizeLogPayload 清洗）
      const { code, message, detail } = resolveFriendlyError(err);
      const { sanitizeLogPayload } = await import('@/lib/crypto/sanitize-log-payload');
      throw new ApiError(400, message, { code, detail: sanitizeLogPayload(detail) });
    }
  },
});
