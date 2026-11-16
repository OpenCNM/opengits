import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CircuitBreaker,
  buildBreakerKey,
  isTripEligibleError,
  isRateLimitError,
} from '@/lib/llm-gateway/circuit-breaker';
import { MissingApiKeyError } from '@/lib/ai';
import { BudgetExceededError } from '@/lib/llm-budget';

describe('LLM 网关轻量级三态断路器 (CircuitBreaker)', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 5,
      failureRateThreshold: 0.5,
      windowSize: 10,
      cooldownMs: 100, // 短冷却时间供单测快速验证
      probeCount: 1,
    });
  });

  it('初始状态为 CLOSED，canExecute 返回 true', () => {
    const key = 'platform:deepseek:deepseek-chat';
    expect(breaker.getState(key)).toBe('CLOSED');
    expect(breaker.canExecute(key)).toBe(true);
  });

  it('连续失败达 5 次自动跃迁至 OPEN 态，且后续 canExecute 返回 false', () => {
    const key = 'platform:deepseek:deepseek-chat';
    const serverErr = { status: 503, message: 'Service Unavailable' };

    for (let i = 0; i < 4; i++) {
      expect(breaker.canExecute(key)).toBe(true);
      breaker.recordFailure(key, serverErr);
      expect(breaker.getState(key)).toBe('CLOSED');
    }

    // 第 5 次失败，触发熔断
    breaker.recordFailure(key, serverErr);
    expect(breaker.getState(key)).toBe('OPEN');
    expect(breaker.canExecute(key)).toBe(false);
  });

  it('处于 OPEN 态时，在冷却期内毫秒级短路返回 false (零网络开销)', () => {
    const key = 'platform:deepseek:deepseek-chat';
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure(key, { status: 500, message: 'Internal Server Error' });
    }
    expect(breaker.getState(key)).toBe('OPEN');

    // 连续多次调用，全部直接短路
    for (let i = 0; i < 10; i++) {
      expect(breaker.canExecute(key)).toBe(false);
    }
  });

  it('冷却时间结束后自动进入 HALF_OPEN，单探针成功后自愈恢复为 CLOSED', async () => {
    const key = 'platform:deepseek:deepseek-chat';
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure(key, { status: 502, message: 'Bad Gateway' });
    }
    expect(breaker.getState(key)).toBe('OPEN');

    // 等待冷却期超时 (100ms)
    await new Promise((resolve) => setTimeout(resolve, 110));

    expect(breaker.getState(key)).toBe('HALF_OPEN');

    // 探针放行：第 1 个请求允许通过
    expect(breaker.canExecute(key)).toBe(true);
    // 超出 probeCount(1) 的并发请求在半开态被拦截
    expect(breaker.canExecute(key)).toBe(false);

    // 探针返回成功
    breaker.recordSuccess(key);
    expect(breaker.getState(key)).toBe('CLOSED');
    expect(breaker.canExecute(key)).toBe(true);
  });

  it('HALF_OPEN 探针调用失败时，立即重新打回 OPEN 态并重置冷却计时', async () => {
    const key = 'platform:deepseek:deepseek-chat';
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure(key, { status: 503, message: 'Service Unavailable' });
    }
    expect(breaker.getState(key)).toBe('OPEN');

    // 等待冷却期超时
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(breaker.getState(key)).toBe('HALF_OPEN');

    // 放行探针
    expect(breaker.canExecute(key)).toBe(true);

    // 探针调用遇到 503 失败
    breaker.recordFailure(key, { status: 503, message: 'Service Unavailable' });
    expect(breaker.getState(key)).toBe('OPEN');
    expect(breaker.canExecute(key)).toBe(false);
  });

  it('滑动窗口失败率达到 50% 触发熔断', () => {
    const rateBreaker = new CircuitBreaker({
      failureThreshold: 999, // 禁用连续阈值
      failureRateThreshold: 0.5,
      windowSize: 10,
      cooldownMs: 100,
      probeCount: 1,
    });
    const key = 'platform:dashscope:qwen-plus';

    // 5 次成功，4 次失败 (共 9 次，窗口未满，不触发)
    for (let i = 0; i < 5; i++) rateBreaker.recordSuccess(key);
    for (let i = 0; i < 4; i++) rateBreaker.recordFailure(key, new Error('ECONNREFUSED'));
    expect(rateBreaker.getState(key)).toBe('CLOSED');

    // 第 10 次调用失败：窗口满 10 次，失败 5 次 (50%) -> 触发 OPEN
    rateBreaker.recordFailure(key, new Error('ECONNREFUSED'));
    expect(rateBreaker.getState(key)).toBe('OPEN');
  });

  describe('错误智能分类与熔断资格判定 (isTripEligibleError)', () => {
    it('排除 401 与 403 认证错误 (不触发熔断)', () => {
      expect(isTripEligibleError({ status: 401, message: 'Unauthorized' })).toBe(false);
      expect(isTripEligibleError({ statusCode: 403, message: 'Forbidden' })).toBe(false);
      expect(isTripEligibleError(new MissingApiKeyError())).toBe(false);
    });

    it('排除 429 速率限制错误 (不触发熔断)', () => {
      expect(isTripEligibleError({ status: 429, message: 'Too Many Requests' })).toBe(false);
      expect(isTripEligibleError({ statusCode: 429, message: 'Rate limit exceeded' })).toBe(false);
      expect(isTripEligibleError(new Error('请求频率过高，触发速率限制'))).toBe(false);
      expect(isRateLimitError({ status: 429 })).toBe(true);
    });

    it('排除 BudgetExceededError 与 用户主动中断 (AbortError)', () => {
      expect(isTripEligibleError(new BudgetExceededError('budget exceeded'))).toBe(false);
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      expect(isTripEligibleError(abortErr)).toBe(false);
    });

    it('排除 400 / 404 / 422 客户端入参错误', () => {
      expect(isTripEligibleError({ status: 400, message: 'Bad Request' })).toBe(false);
      expect(isTripEligibleError({ status: 404, message: 'Model Not Found' })).toBe(false);
      expect(isTripEligibleError({ status: 422, message: 'Unprocessable Entity' })).toBe(false);
    });

    it('包含 500 / 502 / 503 / 504 服务端崩溃错误', () => {
      expect(isTripEligibleError({ status: 500, message: 'Internal Server Error' })).toBe(true);
      expect(isTripEligibleError({ status: 502, message: 'Bad Gateway' })).toBe(true);
      expect(isTripEligibleError({ status: 503, message: 'Service Unavailable' })).toBe(true);
      expect(isTripEligibleError({ status: 504, message: 'Gateway Timeout' })).toBe(true);
    });

    it('包含网络异常与超时错误', () => {
      expect(isTripEligibleError(new Error('fetch failed'))).toBe(true);
      expect(isTripEligibleError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
      expect(isTripEligibleError(new Error('socket hang up'))).toBe(true);
      expect(isTripEligibleError(new Error('UND_ERR_CONNECT_TIMEOUT'))).toBe(true);
      expect(isTripEligibleError(new Error('Request timed out after 30000ms'))).toBe(true);
      expect(isTripEligibleError(new Error('read ECONNRESET'))).toBe(true);
      expect(isTripEligibleError(new Error('Socket reset by peer'))).toBe(true);
    });

    it('非熔断错误即使传入 recordFailure 也绝不累加失败计数', () => {
      const key = 'platform:deepseek:deepseek-chat';
      for (let i = 0; i < 10; i++) {
        breaker.recordFailure(key, { status: 429, message: 'rate limit' });
        breaker.recordFailure(key, new MissingApiKeyError());
        breaker.recordFailure(key, { status: 401, message: 'unauthorized' });
      }
      expect(breaker.getState(key)).toBe('CLOSED');
      expect(breaker.getStats(key).consecutiveFailures).toBe(0);
    });
  });

  describe('两级隔离机制 (buildBreakerKey)', () => {
    it('正确生成平台级与用户级 Key 区分隔离域', () => {
      expect(buildBreakerKey('deepseek', 'deepseek-chat')).toBe('platform:deepseek:deepseek-chat');
      expect(buildBreakerKey('deepseek', 'deepseek-chat', null)).toBe('platform:deepseek:deepseek-chat');
      expect(buildBreakerKey('deepseek', 'deepseek-chat', 'user-123')).toBe('user:user-123:deepseek:deepseek-chat');
    });

    it('单租户 Key 熔断不会污染其他租户与平台公共通道', () => {
      const userAKey = buildBreakerKey('deepseek', 'deepseek-chat', 'user-A');
      const userBKey = buildBreakerKey('deepseek', 'deepseek-chat', 'user-B');
      const platformKey = buildBreakerKey('deepseek', 'deepseek-chat');

      // 连续 5 次 503 搞垮 user A 的通道
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure(userAKey, { status: 503, message: 'Service Unavailable' });
      }

      // user A 处于 OPEN
      expect(breaker.getState(userAKey)).toBe('OPEN');
      expect(breaker.canExecute(userAKey)).toBe(false);

      // user B 和平台公共通道保持 CLOSED 状态，健康放行
      expect(breaker.getState(userBKey)).toBe('CLOSED');
      expect(breaker.canExecute(userBKey)).toBe(true);

      expect(breaker.getState(platformKey)).toBe('CLOSED');
      expect(breaker.canExecute(platformKey)).toBe(true);
    });
  });

  describe('多服务商级联降级 (Multi-Provider Cascade Integration)', () => {
    it('主用模型遭遇 503 时，网关自动级联至备选模型并成功返回', async () => {
      const { runLlmGatewayGenerate } = await import('@/lib/llm-gateway/service');
      const testBreaker = new CircuitBreaker();
      const calls: string[] = [];

      const candidates = [
        { provider: 'deepseek', modelId: 'deepseek-chat', label: 'Primary' },
        { provider: 'dashscope', modelId: 'qwen-plus', label: 'Backup 1' },
      ];

      const completeFn = vi.fn(async (opts: any) => {
        calls.push(`${opts.provider}/${opts.modelId}`);
        if (opts.provider === 'deepseek') {
          const err = new Error('Service Unavailable') as any;
          err.status = 503;
          throw err;
        }
        return { text: 'success from backup', usage: { totalTokens: 15 }, finishReason: 'stop' };
      });

      const res = await runLlmGatewayGenerate(
        {
          purpose: 'code_chapter_lesson',
          variables: {
            chapterIndex: '1',
            chapterTitle: 'Intro',
            chapterDescription: 'desc',
            moduleDirectories: ['src'],
            skipMetaCompiler: true,
          },
          userId: null,
        },
        {
          completeFn: completeFn as any,
          circuitBreaker: testBreaker,
          cascadeCandidates: candidates,
        }
      );

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.text).toBe('success from backup');
      }
      expect(calls).toEqual(['deepseek/deepseek-chat', 'dashscope/qwen-plus']);
      // 主用通道记录了失败，备用通道记录了成功
      expect(testBreaker.getStats(buildBreakerKey('deepseek', 'deepseek-chat', null)).consecutiveFailures).toBe(1);
      expect(testBreaker.getState(buildBreakerKey('dashscope', 'qwen-plus', null))).toBe('CLOSED');
    });

    it('主用模型处于 OPEN 熔断态时，直接短路跳过主用并由备选模型承接 (0 网络开销)', async () => {
      const { runLlmGatewayGenerate } = await import('@/lib/llm-gateway/service');
      const testBreaker = new CircuitBreaker();
      const calls: string[] = [];

      const candidates = [
        { provider: 'deepseek', modelId: 'deepseek-chat', label: 'Primary' },
        { provider: 'dashscope', modelId: 'qwen-plus', label: 'Backup 1' },
      ];

      // 预先将主选通道打崩进入 OPEN 态
      const primaryKey = buildBreakerKey('deepseek', 'deepseek-chat', null);
      for (let i = 0; i < 5; i++) {
        testBreaker.recordFailure(primaryKey, { status: 503, message: 'Service Unavailable' });
      }
      expect(testBreaker.getState(primaryKey)).toBe('OPEN');

      const completeFn = vi.fn(async (opts: any) => {
        calls.push(`${opts.provider}/${opts.modelId}`);
        return { text: 'instant backup response', usage: { totalTokens: 10 }, finishReason: 'stop' };
      });

      const res = await runLlmGatewayGenerate(
        {
          purpose: 'code_chapter_lesson',
          variables: {
            chapterIndex: '1',
            chapterTitle: 'Intro',
            chapterDescription: 'desc',
            moduleDirectories: ['src'],
            skipMetaCompiler: true,
          },
          userId: null,
        },
        {
          completeFn: completeFn as any,
          circuitBreaker: testBreaker,
          cascadeCandidates: candidates,
        }
      );

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.text).toBe('instant backup response');
      }
      // deepseek 由于处于 OPEN 态被直接跳过，未发生调用
      expect(calls).toEqual(['dashscope/qwen-plus']);
    });

    it('所有候选通道全军覆没时，抛出 GENERATION_FAILED (502)', async () => {
      const { runLlmGatewayGenerate } = await import('@/lib/llm-gateway/service');
      const testBreaker = new CircuitBreaker();

      const candidates = [
        { provider: 'deepseek', modelId: 'deepseek-chat' },
        { provider: 'dashscope', modelId: 'qwen-plus' },
      ];

      const completeFn = vi.fn(async () => {
        const err = new Error('Gateway Timeout') as any;
        err.status = 504;
        throw err;
      });

      const res = await runLlmGatewayGenerate(
        {
          purpose: 'code_chapter_lesson',
          variables: {
            chapterIndex: '1',
            chapterTitle: 'Intro',
            chapterDescription: 'desc',
            moduleDirectories: ['src'],
            skipMetaCompiler: true,
          },
          userId: null,
        },
        {
          completeFn: completeFn as any,
          circuitBreaker: testBreaker,
          cascadeCandidates: candidates,
        }
      );

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('GENERATION_FAILED');
      }
      expect(completeFn).toHaveBeenCalledTimes(2);
    });

    it('遇到 401 密钥失效错误时，立即 Fail-closed 终止，绝不污染并浪费备用模型配额', async () => {
      const { runLlmGatewayGenerate } = await import('@/lib/llm-gateway/service');
      const testBreaker = new CircuitBreaker();
      const calls: string[] = [];

      const candidates = [
        { provider: 'deepseek', modelId: 'deepseek-chat' },
        { provider: 'dashscope', modelId: 'qwen-plus' },
      ];

      const completeFn = vi.fn(async (opts: any) => {
        calls.push(`${opts.provider}/${opts.modelId}`);
        throw new MissingApiKeyError('Invalid API Key');
      });

      const res = await runLlmGatewayGenerate(
        {
          purpose: 'code_chapter_lesson',
          variables: {
            chapterIndex: '1',
            chapterTitle: 'Intro',
            chapterDescription: 'desc',
            moduleDirectories: ['src'],
            skipMetaCompiler: true,
          },
          userId: null,
        },
        {
          completeFn: completeFn as any,
          circuitBreaker: testBreaker,
          cascadeCandidates: candidates,
        }
      );

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('MISSING_API_KEY');
      }
      // 立即终止，未调用备用模型
      expect(calls).toEqual(['deepseek/deepseek-chat']);
      // 断路器未受 401 污染
      expect(testBreaker.getState(buildBreakerKey('deepseek', 'deepseek-chat', null))).toBe('CLOSED');
    });

    it('NDJSON 流式直通网关在主用模型首帧启动失败时支持平滑级联至备用通道', async () => {
      const { runLlmGatewayStream } = await import('@/lib/llm-gateway/service');
      const testBreaker = new CircuitBreaker();
      const calls: string[] = [];

      const candidates = [
        { provider: 'deepseek', modelId: 'deepseek-chat' },
        { provider: 'dashscope', modelId: 'qwen-plus' },
      ];

      const completeFn = vi.fn(async (opts: any) => {
        calls.push(`${opts.provider}/${opts.modelId}`);
        if (opts.provider === 'deepseek') {
          const err = new Error('503 Service Unavailable') as any;
          err.status = 503;
          throw err;
        }
        return { text: 'streamed fallback text', usage: { totalTokens: 8 }, finishReason: 'stop' };
      });

      const stream = runLlmGatewayStream(
        {
          purpose: 'code_chapter_lesson',
          variables: {
            chapterIndex: '1',
            chapterTitle: 'Intro',
            chapterDescription: 'desc',
            moduleDirectories: ['src'],
            skipMetaCompiler: true,
          },
          userId: null,
        },
        {
          completeFn: completeFn as any,
          circuitBreaker: testBreaker,
          cascadeCandidates: candidates,
          pingIntervalMs: 0,
        }
      );

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let allEventsText = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        allEventsText += decoder.decode(value);
      }

      expect(calls).toEqual(['deepseek/deepseek-chat', 'dashscope/qwen-plus']);
      expect(allEventsText).toContain('streamed fallback text');
      expect(allEventsText).toContain('"type":"done"');
    });

    it('HALF_OPEN 探针遭遇 429 限流时，必须切回 OPEN 态重置冷却，绝不能死锁在 HALF_OPEN', async () => {
      const key = 'platform:dashscope:qwen-plus';
      // 先打崩进入 OPEN 态
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure(key, { status: 503, message: 'Service Unavailable' });
      }
      expect(breaker.getState(key)).toBe('OPEN');

      // 等待冷却结束进入 HALF_OPEN
      await new Promise((resolve) => setTimeout(resolve, 110));
      expect(breaker.getState(key)).toBe('HALF_OPEN');

      // 放行探针
      expect(breaker.canExecute(key)).toBe(true);

      // 探针遭遇 429 限流
      breaker.recordFailure(key, { status: 429, message: 'Too Many Requests' });

      // 必须切回 OPEN，探针计数清零，而不是死锁在 HALF_OPEN
      expect(breaker.getState(key)).toBe('OPEN');
      expect(breaker.canExecute(key)).toBe(false);

      // 再次等待冷却期过后，能够重新进入 HALF_OPEN 放行新探针自愈
      await new Promise((resolve) => setTimeout(resolve, 110));
      expect(breaker.getState(key)).toBe('HALF_OPEN');
      expect(breaker.canExecute(key)).toBe(true);

      // 新探针成功，自愈切回 CLOSED
      breaker.recordSuccess(key);
      expect(breaker.getState(key)).toBe('CLOSED');
      expect(breaker.canExecute(key)).toBe(true);
    });

    it('HALF_OPEN 探针遭遇客户端主动中止 (AbortError) 时，安全释放探针配额以供后续请求探测', async () => {
      const key = 'platform:deepseek:deepseek-chat';
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure(key, { status: 503, message: 'Service Unavailable' });
      }
      await new Promise((resolve) => setTimeout(resolve, 110));
      expect(breaker.getState(key)).toBe('HALF_OPEN');

      // 放行探针
      expect(breaker.canExecute(key)).toBe(true);
      expect(breaker.canExecute(key)).toBe(false); // 探针配额已满

      // 客户端主动取消
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      breaker.recordFailure(key, abortErr);

      // 槽位已释放，下一个真实请求可继续探测
      expect(breaker.getState(key)).toBe('HALF_OPEN');
      expect(breaker.canExecute(key)).toBe(true);
    });

    it('HALF_OPEN 探针挂死或泄漏时，超过 cooldownMs 自动自愈重置探针配额', async () => {
      const key = 'platform:zhipu:glm-4-flash';
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure(key, { status: 503, message: 'Service Unavailable' });
      }
      await new Promise((resolve) => setTimeout(resolve, 110));
      expect(breaker.getState(key)).toBe('HALF_OPEN');

      // 放行探针但调用方遗失回调（既未调 recordSuccess 也未调 recordFailure）
      expect(breaker.canExecute(key)).toBe(true);
      expect(breaker.canExecute(key)).toBe(false);

      // 等待超过 cooldownMs (100ms)
      await new Promise((resolve) => setTimeout(resolve, 110));

      // canExecute 自动检测到过期的泄漏探针并自我修复放行
      expect(breaker.canExecute(key)).toBe(true);
    });

    it('NDJSON 流式在生成器抛出异常且未发出任何 chunk 时，绝不提前记录成功并能平滑级联', async () => {
      const { runLlmGatewayStream } = await import('@/lib/llm-gateway/service');
      const testBreaker = new CircuitBreaker();
      const calls: string[] = [];

      const candidates = [
        { provider: 'deepseek', modelId: 'deepseek-chat' },
        { provider: 'dashscope', modelId: 'qwen-plus' },
      ];

      const streamFn = vi.fn(async (opts: any) => {
        calls.push(`${opts.provider}/${opts.modelId}`);
        if (opts.provider === 'deepseek') {
          return {
            fullStream: (async function* () {
              // 首帧前直接崩溃
              throw new Error('Socket reset by peer before first chunk');
            })(),
            finishReason: Promise.resolve('stop'),
            usage: Promise.resolve({ totalTokens: 0 }),
          };
        }
        return {
          fullStream: (async function* () {
            yield { type: 'text-delta', text: 'recovered chunk' };
          })(),
          finishReason: Promise.resolve('stop'),
          usage: Promise.resolve({ totalTokens: 12 }),
        };
      });

      const stream = runLlmGatewayStream(
        {
          purpose: 'code_chapter_lesson',
          variables: {
            chapterIndex: '1',
            chapterTitle: 'Intro',
            chapterDescription: 'desc',
            moduleDirectories: ['src'],
            skipMetaCompiler: true,
          },
          userId: null,
        },
        {
          streamFn: streamFn as any,
          circuitBreaker: testBreaker,
          cascadeCandidates: candidates,
          pingIntervalMs: 0,
        }
      );

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let allEventsText = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        allEventsText += decoder.decode(value);
      }

      // deepseek 失败记录了 failure，未被提前判定为 success
      const deepseekKey = buildBreakerKey('deepseek', 'deepseek-chat', null);
      expect(testBreaker.getStats(deepseekKey).consecutiveFailures).toBe(1);

      // dashscope 承接并成功
      expect(calls).toEqual(['deepseek/deepseek-chat', 'dashscope/qwen-plus']);
      expect(allEventsText).toContain('recovered chunk');
      expect(allEventsText).toContain('"type":"done"');
    });
  });
});
