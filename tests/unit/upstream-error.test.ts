import { describe, it, expect, vi, afterEach } from 'vitest';
import { APICallError, NoOutputGeneratedError, NoObjectGeneratedError, RetryError } from 'ai';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  extractUpstreamError,
  serializeClientStreamError,
  parseClientStreamError,
  encodeStructuredDbError,
  decodeStructuredDbError,
  type UpstreamErrorMeta,
} from '@/lib/llm-gateway/upstream-error';
import { resolveUpstreamErrorPresentation } from '@/lib/llm-gateway/upstream-error-ui';
import { ApiError, toApiErrorFromLlm } from '@/lib/api/server/api-error';
import { defineRoute } from '@/lib/api/server/define-route';
import { ApiClientError, apiFetch } from '@/lib/api/client';
import { generateStructured } from '@/lib/ai';
import {
  createInitialWizardData,
  createWizardResetPatch,
  useImportWizardStore,
  wizardFlow,
  wizardSetters,
} from '@/lib/stores/import-wizard-store';

describe('上游 LLM 错误第一性原理拆解 (extractUpstreamError)', () => {
  it('解包 AI SDK RetryError + APICallError（智谱 429 code 1308 5小时上限）', () => {
    const apiErr = new APICallError({
      message: '已达到 5 小时使用上限，2026-11-25 16:06:12 后可继续使用。如需超额按量付费使用，可联系管理员开启超额按量付费。',
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {},
      responseBody:
        '{"error":{"code":"1308","message":"已达到 5 小时使用上限，2026-11-25 16:06:12 后可继续使用。如需超额按量付费使用，可联系管理员开启超额按量付费。"}}',
      isRetryable: true,
    });
    const retryErr = new RetryError({
      message: 'Failed after 3 attempts. Last error: rate limit',
      reason: 'maxRetriesExceeded',
      errors: [apiErr, apiErr, apiErr],
    });

    const info = extractUpstreamError(retryErr, { provider: 'zhipu', model: 'glm-5.3-flash' });
    expect(info.code).toBe('UPSTREAM_QUOTA_EXCEEDED');
    expect(info.upstreamStatus).toBe(429);
    expect(info.upstreamCode).toBe('1308');
    expect(info.provider).toBe('zhipu');
    expect(info.model).toBe('glm-5.3-flash');
    expect(info.isRetryable).toBe(false);
    expect(info.message).toContain('已达到 5 小时使用上限');
  });

  it('解包 NoOutputGeneratedError 嵌套 RetryError', () => {
    const apiErr = new APICallError({
      message: 'Incorrect API key provided',
      url: 'https://api.openai.com/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 401,
      responseBody: '{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}',
      isRetryable: false,
    });
    const noOutput = new NoOutputGeneratedError({
      message: 'No output generated. Check the stream for errors.',
      cause: apiErr,
    });

    const info = extractUpstreamError(noOutput, { provider: 'openai', model: 'gpt-4o' });
    expect(info.code).toBe('UPSTREAM_AUTH_ERROR');
    expect(info.upstreamStatus).toBe(401);
    expect(info.upstreamCode).toBe('invalid_api_key');
    expect(info.message).toBe('Incorrect API key provided');
    expect(info.isRetryable).toBe(false);
  });

  it('覆盖 402/404/400/429瞬态/503/网络超时 全矩阵分类', () => {
    const balance = extractUpstreamError({
      statusCode: 402,
      responseBody: '{"error":{"message":"Insufficient Balance"}}',
    });
    expect(balance.code).toBe('UPSTREAM_QUOTA_EXCEEDED');
    expect(balance.message).toBe('Insufficient Balance');

    const notFound = extractUpstreamError({
      statusCode: 404,
      responseBody: '{"error":{"code":"model_not_found","message":"The model foo does not exist"}}',
    });
    expect(notFound.code).toBe('UPSTREAM_MODEL_NOT_FOUND');

    const badReq = extractUpstreamError({
      statusCode: 400,
      responseBody: '{"error":{"code":"context_length_exceeded","message":"Maximum context length exceeded"}}',
    });
    expect(badReq.code).toBe('UPSTREAM_BAD_REQUEST');

    const transient429 = extractUpstreamError({
      statusCode: 429,
      responseBody: '{"error":{"message":"Rate limit reached for requests per min"}}',
    });
    expect(transient429.code).toBe('RATE_LIMITED');
    expect(transient429.isRetryable).toBe(true);

    const server503 = extractUpstreamError({
      statusCode: 503,
      message: 'Service Unavailable',
    });
    expect(server503.code).toBe('UPSTREAM_SERVER_ERROR');
    expect(server503.isRetryable).toBe(true);

    const netErr = new TypeError('fetch failed');
    (netErr as any).cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:443' };
    const netInfo = extractUpstreamError(netErr);
    expect(netInfo.code).toBe('UPSTREAM_NETWORK_ERROR');
    expect(netInfo.isRetryable).toBe(true);
  });

  it('serializeClientStreamError / parseClientStreamError 往返无损', () => {
    const raw = serializeClientStreamError(
      new APICallError({
        message: 'Invalid token',
        url: 'https://api.deepseek.com/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 401,
        responseBody: '{"error":{"message":"Authentication Fails","code":"authentication_error"}}',
        isRetryable: false,
      }),
      { provider: 'deepseek', model: 'deepseek-chat' }
    );

    const parsed = parseClientStreamError(raw);
    expect(parsed.code).toBe('UPSTREAM_AUTH_ERROR');
    expect(parsed.message).toBe('Authentication Fails');
    expect(parsed.provider).toBe('deepseek');
    expect(parsed.model).toBe('deepseek-chat');
    expect(parsed.upstreamStatus).toBe(401);
    expect(parsed.upstreamCode).toBe('authentication_error');
  });
});

describe('__OG_ERR__: 结构化 DB 错误编解码与 UI 呈现解析', () => {
  it('encodeStructuredDbError / decodeStructuredDbError 往返无损并严格遵守 500 字符有效 JSON 上限', () => {
    const meta: UpstreamErrorMeta = {
      code: 'UPSTREAM_QUOTA_EXCEEDED',
      provider: 'zhipu',
      model: 'glm-5.3-flash',
      upstreamStatus: 429,
      upstreamCode: '1308',
      upstreamMessage: '已达到 5 小时使用上限，请稍后重试',
    };
    const encoded = encodeStructuredDbError(meta);
    expect(encoded.startsWith('__OG_ERR__:')).toBe(true);
    expect(encoded.length).toBeLessThanOrEqual(500);
    expect(decodeStructuredDbError(encoded)).toEqual(meta);

    // 超长含中文与引号的错误消息必须先裁剪再序列化，保证 <= 500 且 JSON 合法
    const hugeMeta: UpstreamErrorMeta = {
      code: 'UPSTREAM_BAD_REQUEST',
      provider: 'openai',
      model: 'gpt-4o-mini',
      upstreamStatus: 400,
      upstreamCode: 'context_length_exceeded',
      upstreamMessage: '输入过长"quoted"：'.repeat(80),
    };
    const encodedHuge = encodeStructuredDbError(hugeMeta);
    expect(encodedHuge.length).toBeLessThanOrEqual(500);
    const decodedHuge = decodeStructuredDbError(encodedHuge);
    expect(decodedHuge).not.toBeNull();
    expect(decodedHuge?.code).toBe('UPSTREAM_BAD_REQUEST');
    expect(decodedHuge?.upstreamMessage?.endsWith('...')).toBe(true);
  });

  it('decodeStructuredDbError 兼容 Go sidecar 的 message 字段与前置文案，非前缀或损坏 JSON 返回 null', () => {
    const goPayload =
      '__OG_ERR__:{"code":"UPSTREAM_AUTH_ERROR","provider":"deepseek","model":"deepseek-chat","upstreamStatus":401,"upstreamCode":"invalid_api_key","message":"Incorrect API key"}';
    expect(decodeStructuredDbError(goPayload)).toEqual({
      code: 'UPSTREAM_AUTH_ERROR',
      provider: 'deepseek',
      model: 'deepseek-chat',
      upstreamStatus: 401,
      upstreamCode: 'invalid_api_key',
      upstreamMessage: 'Incorrect API key',
    });

    const prefixed = `转录失败: ${goPayload}`;
    expect(decodeStructuredDbError(prefixed)?.code).toBe('UPSTREAM_AUTH_ERROR');
    expect(decodeStructuredDbError('plain error message')).toBeNull();
    expect(decodeStructuredDbError('__OG_ERR__:{broken json')).toBeNull();
    expect(decodeStructuredDbError(null)).toBeNull();
  });

  it('resolveUpstreamErrorPresentation 无缝消费 __OG_ERR__:、ApiClientError.meta 与裸 UpstreamErrorMeta', () => {
    const dbErr =
      '__OG_ERR__:{"code":"UPSTREAM_MODEL_NOT_FOUND","provider":"openai","model":"gpt-99","upstreamStatus":404,"upstreamCode":"model_not_found","message":"The model gpt-99 does not exist"}';
    const fromDb = resolveUpstreamErrorPresentation(dbErr);
    expect(fromDb.code).toBe('UPSTREAM_MODEL_NOT_FOUND');
    expect(fromDb.provider).toBe('openai');
    expect(fromDb.model).toBe('gpt-99');
    expect(fromDb.upstreamStatus).toBe(404);
    expect(fromDb.upstreamCode).toBe('model_not_found');
    expect(fromDb.upstreamMessage).toBe('The model gpt-99 does not exist');
    expect(fromDb.primaryAction).toBe('switch_model');
    expect(fromDb.showModelSwitcher).toBe(true);

    const apiErr = new ApiClientError(401, '上游鉴权失败: [anthropic/claude-3-7] bad key', {
      code: 'UPSTREAM_AUTH_ERROR',
      detail: '[anthropic/claude-3-7] bad key',
      meta: {
        code: 'UPSTREAM_AUTH_ERROR',
        provider: 'anthropic',
        model: 'claude-3-7',
        upstreamStatus: 401,
        upstreamCode: 'authentication_error',
        upstreamMessage: 'invalid x-api-key',
      },
    });
    const fromClient = resolveUpstreamErrorPresentation(apiErr);
    expect(fromClient.code).toBe('UPSTREAM_AUTH_ERROR');
    expect(fromClient.provider).toBe('anthropic');
    expect(fromClient.model).toBe('claude-3-7');
    expect(fromClient.upstreamStatus).toBe(401);
    expect(fromClient.upstreamCode).toBe('authentication_error');
    expect(fromClient.upstreamMessage).toBe('invalid x-api-key');
    expect(fromClient.primaryAction).toBe('config_key');
    expect(fromClient.showConfigKey).toBe(true);

    const directMeta: UpstreamErrorMeta = {
      code: 'UPSTREAM_SERVER_ERROR',
      provider: 'dashscope',
      model: 'qwen-plus',
      upstreamStatus: 503,
      upstreamMessage: 'Service temporarily unavailable',
    };
    const fromMeta = resolveUpstreamErrorPresentation(directMeta);
    expect(fromMeta.code).toBe('UPSTREAM_SERVER_ERROR');
    expect(fromMeta.provider).toBe('dashscope');
    expect(fromMeta.upstreamStatus).toBe(503);
    expect(fromMeta.upstreamMessage).toBe('Service temporarily unavailable');
    expect(fromMeta.primaryAction).toBe('retry');
  });
});

describe('ApiError.meta / defineRoute / ApiClientError.meta 端到端协议保真', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('toApiErrorFromLlm 填充 ApiError.meta 并经 defineRoute 完整输出至 ApiFailure.meta', async () => {
    const upstreamErr = new APICallError({
      message: 'Quota exceeded',
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      requestBodyValues: {},
      statusCode: 429,
      responseBody: '{"error":{"code":"1308","message":"已达到 5 小时使用上限"}}',
      isRetryable: false,
    });

    const apiErr = toApiErrorFromLlm(upstreamErr, 'fallback', {
      provider: 'zhipu',
      model: 'glm-5.3-flash',
    });
    expect(apiErr).toBeInstanceOf(ApiError);
    expect(apiErr.status).toBe(429);
    expect(apiErr.code).toBe('UPSTREAM_QUOTA_EXCEEDED');
    expect(apiErr.meta).toEqual({
      code: 'UPSTREAM_QUOTA_EXCEEDED',
      provider: 'zhipu',
      model: 'glm-5.3-flash',
      upstreamStatus: 429,
      upstreamCode: '1308',
      upstreamMessage: '已达到 5 小时使用上限',
    });

    const handler = defineRoute({
      scope: 'test/upstream-meta',
      auth: 'none',
      handler: () => {
        throw apiErr;
      },
    });
    const res = await handler(new NextRequest('http://localhost/api/test'), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      code: 'UPSTREAM_QUOTA_EXCEEDED',
      meta: apiErr.meta,
    });
  });

  it('apiFetch 保留信封与非信封错误 JSON 中的 meta 至 ApiClientError.meta', async () => {
    const meta: UpstreamErrorMeta = {
      code: 'UPSTREAM_AUTH_ERROR',
      provider: 'openai',
      model: 'gpt-4o',
      upstreamStatus: 401,
      upstreamCode: 'invalid_api_key',
      upstreamMessage: 'Incorrect API key provided',
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            error: '上游认证失败',
            code: 'UPSTREAM_AUTH_ERROR',
            detail: '[openai/gpt-4o] Incorrect API key provided',
            meta,
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    await expect(apiFetch('/api/test-envelope', { onUnauthorized: 'throw' })).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 401,
      code: 'UPSTREAM_AUTH_ERROR',
      detail: '[openai/gpt-4o] Incorrect API key provided',
      meta,
    });

    // 非信封兼容分支（使用 402 避免触发 onUnauthorized 默认重定向）
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: '余额不足',
            code: 'UPSTREAM_QUOTA_EXCEEDED',
            meta: { ...meta, code: 'UPSTREAM_QUOTA_EXCEEDED', upstreamStatus: 402 },
          }),
          { status: 402, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    await expect(apiFetch('/api/test-legacy')).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 402,
      code: 'UPSTREAM_QUOTA_EXCEEDED',
      meta: { ...meta, code: 'UPSTREAM_QUOTA_EXCEEDED', upstreamStatus: 402 },
    });
  });
});

describe('generateStructured fail-closed 与 import-wizard-store ingestError', () => {
  it('generateStructured 对被 NoObjectGeneratedError 包裹的上游 HTTP 错误立即 fail-closed 抛出，不误降级 json_mode', async () => {
    let calls = 0;
    const fakeModel = {
      specificationVersion: 'v2',
      provider: 'test',
      modelId: 'test-model',
      supportedUrls: {},
      doGenerate: async () => {
        calls++;
        const apiErr = new APICallError({
          message: 'Incorrect API key',
          url: 'https://api.openai.com/v1/chat/completions',
          requestBodyValues: {},
          statusCode: 401,
          responseBody: '{"error":{"code":"invalid_api_key","message":"Incorrect API key"}}',
          isRetryable: false,
        });
        throw new NoObjectGeneratedError({
          message: 'No object generated.',
          cause: apiErr,
          text: '',
          response: { id: '1', timestamp: new Date(), modelId: 'test-model' },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finishReason: 'error',
        });
      },
      doStream: async () => {
        throw new Error('not implemented');
      },
    } as any;

    await expect(
      generateStructured({
        provider: 'fail-closed-test-provider',
        modelId: 'test-model',
        model: fakeModel,
        schema: z.object({ ok: z.boolean() }),
        prompt: 'hi',
      })
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('import-wizard-store ingestError / setIngestError 在 reset 与 goBackToScope 中随 ingestFailed 同步清理', () => {
    useImportWizardStore.setState(createInitialWizardData('en'));
    expect(useImportWizardStore.getState().ingestError).toBeNull();

    const sampleErr: UpstreamErrorMeta = {
      code: 'UPSTREAM_QUOTA_EXCEEDED',
      provider: 'zhipu',
      model: 'glm-4',
      upstreamStatus: 429,
      upstreamMessage: 'Quota exceeded',
    };
    wizardSetters.setIngestFailed(true);
    wizardSetters.setIngestError(sampleErr);
    expect(useImportWizardStore.getState().ingestError).toEqual(sampleErr);

    wizardFlow.goBackToScope();
    expect(useImportWizardStore.getState().ingestFailed).toBe(false);
    expect(useImportWizardStore.getState().ingestError).toBeNull();

    wizardSetters.setIngestFailed(true);
    wizardSetters.setIngestError(sampleErr);
    const resetPatch = createWizardResetPatch('en');
    expect(resetPatch.ingestFailed).toBe(false);
    expect(resetPatch.ingestError).toBeNull();
  });
});
