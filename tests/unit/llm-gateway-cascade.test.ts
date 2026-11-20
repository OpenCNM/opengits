import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * ─────────────────────────────────────────────────────────────
 * BYOK 候选解析 Fail-Closed 契约（2026-11 A 类基础设施故障收口）
 *
 * 伪弹性收口语义：
 * - 用户级联为空 → 按密钥物理状态精确报错（decrypt_failed →
 *   KEY_DECRYPT_FAILED；missing → MISSING_API_KEY），绝不静默回落平台级联；
 * - userId 缺席 + keyOrigin='user' → fail-closed（不蹭平台默认模型）；
 * - resolver 基础设施异常（DB 不可达）≠ 缺 Key → GENERATION_FAILED 502 说真话。
 *
 * 文件级 vi.mock 隔离（不污染 llm-gateway.test.ts 的无 mock 约定）。
 * ─────────────────────────────────────────────────────────────
 */
const resolveUserModelCascadeMock = vi.hoisted(() => vi.fn());
const inspectUserModelKeyStatusMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/user-model-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/user-model-resolver')>();
  return {
    ...actual,
    resolveUserModelCascade: resolveUserModelCascadeMock,
    inspectUserModelKeyStatus: inspectUserModelKeyStatusMock,
  };
});

import {
  resolveCascadeCandidates,
  runLlmGatewayGenerate,
  runLlmGatewayStream,
  UserKeyUnavailableError,
  LLM_GATEWAY_ERROR_CODES,
} from '@/lib/llm-gateway/service';

describe('LLM 网关候选解析 Fail-Closed（A 类收口）', () => {
  beforeEach(() => {
    resolveUserModelCascadeMock.mockReset();
    inspectUserModelKeyStatusMock.mockReset();
  });

  it('用户级联非空：原样透传候选（不回归），不触发密钥探测', async () => {
    resolveUserModelCascadeMock.mockResolvedValue([
      { provider: 'zhipu', modelId: 'glm-4.7', apiKey: 'k1', baseURL: 'https://open.bigmodel.cn', apiFormat: 'openai' },
    ]);
    const candidates = await resolveCascadeCandidates('outline_plan_v1', 'u1');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ provider: 'zhipu', modelId: 'glm-4.7', apiKey: 'k1' });
    expect(inspectUserModelKeyStatusMock).not.toHaveBeenCalled();
  });

  it('级联空 + decrypt_failed：抛 KEY_DECRYPT_FAILED，绝不返回平台级联候选', async () => {
    resolveUserModelCascadeMock.mockResolvedValue([]);
    inspectUserModelKeyStatusMock.mockResolvedValue({
      status: 'decrypt_failed',
      provider: 'zhipu',
      modelId: 'glm-4.7',
    });
    const err = await resolveCascadeCandidates('outline_plan_v1', 'u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserKeyUnavailableError);
    expect((err as UserKeyUnavailableError).code).toBe('KEY_DECRYPT_FAILED');
    expect((err as UserKeyUnavailableError).message).toContain('重新填写');
    expect(LLM_GATEWAY_ERROR_CODES.KEY_DECRYPT_FAILED).toBe(409);
  });

  it('级联空 + missing：抛 MISSING_API_KEY（真实根因：未配置）', async () => {
    resolveUserModelCascadeMock.mockResolvedValue([]);
    inspectUserModelKeyStatusMock.mockResolvedValue({ status: 'missing' });
    const err = await resolveCascadeCandidates('outline_plan_v1', 'u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserKeyUnavailableError);
    expect((err as UserKeyUnavailableError).code).toBe('MISSING_API_KEY');
    expect((err as UserKeyUnavailableError).message).toContain('未在云端配置');
  });

  it('userId 缺席 + keyOrigin=user purpose：fail-closed，不回落平台级联', async () => {
    const err = await resolveCascadeCandidates('outline_plan_v1', null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserKeyUnavailableError);
    expect((err as UserKeyUnavailableError).code).toBe('MISSING_API_KEY');
    expect((err as UserKeyUnavailableError).message).toContain('keyOrigin=user');
  });

  it('generate 集成：decrypt_failed → {ok:false, code:KEY_DECRYPT_FAILED}（409 契约）', async () => {
    resolveUserModelCascadeMock.mockResolvedValue([]);
    inspectUserModelKeyStatusMock.mockResolvedValue({
      status: 'decrypt_failed',
      provider: 'zhipu',
      modelId: 'glm-4.7',
    });
    const result = await runLlmGatewayGenerate(
      { purpose: 'mcp_concept_edges', variables: { conceptList: '- a', contextText: 'ctx' }, userId: 'u1' }
    );
    expect(result).toMatchObject({ ok: false, code: 'KEY_DECRYPT_FAILED' });
    if (!result.ok) {
      expect(LLM_GATEWAY_ERROR_CODES[result.code as keyof typeof LLM_GATEWAY_ERROR_CODES]).toBe(409);
    }
  });

  it('meta-compiler purpose：decrypt_failed → Frame-1 Fail-Fast，绝不伪降级后二次烧探测', async () => {
    // code_chapter_lesson 开启 metaCompiler（空 variables 触发 phase1）：
    // phase1 返回 KEY_DECRYPT_FAILED 时必须作为 fatalError 立即上抛——
    // 若误入"falling back to brief=null"分支，主流程会再查一次 DB 才失败
    resolveUserModelCascadeMock.mockResolvedValue([]);
    inspectUserModelKeyStatusMock.mockResolvedValue({
      status: 'decrypt_failed',
      provider: 'zhipu',
      modelId: 'glm-4.7',
    });
    const generateCallsSpy = vi.fn();
    const result = await runLlmGatewayGenerate(
      { purpose: 'code_chapter_lesson', variables: {}, userId: 'u1' },
      {
        generateFn: (async (opts: unknown) => {
          generateCallsSpy(opts);
          throw new Error('should never reach provider stub — fatal must short-circuit meta fallback');
        }) as never,
      }
    );
    expect(result).toMatchObject({ ok: false, code: 'KEY_DECRYPT_FAILED' });
    // 更强的 fail-fast 事实：fatal 在候选解析阶段即短路——meta phase1 的
    // provider 桩 0 次触达，更不存在主流程二次调用
    expect(generateCallsSpy).toHaveBeenCalledTimes(0);
  });

  it('generate 集成：resolver 基础设施异常（DB 不可达）→ GENERATION_FAILED（502）且对外脱敏', async () => {
    resolveUserModelCascadeMock.mockRejectedValue(new Error('PrismaClientInitializationError: db unreachable'));
    const result = await runLlmGatewayGenerate(
      { purpose: 'mcp_concept_edges', variables: { conceptList: '- a', contextText: 'ctx' }, userId: 'u1' }
    );
    expect(result).toMatchObject({ ok: false, code: 'GENERATION_FAILED' });
    if (!result.ok) {
      expect(result.message).toContain('model cascade resolution failed');
      // 对外脱敏契约（round-2 安全审查）：异常原文（DB host/schema 等内部细节）
      // 绝不进入面向客户端的 message——原文只进服务端 console.error
      expect(result.message).not.toContain('db unreachable');
      expect(result.message).not.toContain('Prisma');
    }
  });

  it('generate 集成：注入空候选 → MISSING_API_KEY（不再默认注入平台模型）', async () => {
    const result = await runLlmGatewayGenerate(
      { purpose: 'mcp_concept_edges', variables: { conceptList: '- a', contextText: 'ctx' }, userId: 'u1' },
      { cascadeCandidates: [] }
    );
    expect(result).toMatchObject({ ok: false, code: 'MISSING_API_KEY' });
    if (!result.ok) {
      expect(result.message).toContain('no model candidates resolved');
    }
  });

  it('stream 集成：decrypt_failed → NDJSON error 事件携带 KEY_DECRYPT_FAILED', async () => {
    resolveUserModelCascadeMock.mockResolvedValue([]);
    inspectUserModelKeyStatusMock.mockResolvedValue({ status: 'decrypt_failed', provider: 'zhipu' });
    const stream = runLlmGatewayStream(
      { purpose: 'doc_transcribe_enhance_localize', variables: { targetLanguage: '中文', content: '# d', condensationMode: 'balanced' }, userId: 'u1' },
      { callId: 'cascade-test' }
    );
    const text = await new Response(stream).text();
    const errorLine = text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((ev) => ev.type === 'error');
    expect(errorLine).toBeDefined();
    expect(errorLine).toMatchObject({ ok: false, code: 'KEY_DECRYPT_FAILED' });
    expect(errorLine.message).toContain('重新填写');
  });
});
