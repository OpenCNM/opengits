import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker, buildBreakerKey, isTripEligibleError, isRateLimitError } from '@/lib/llm-gateway/circuit-breaker';
import { MissingApiKeyError } from '@/lib/ai';
import { BudgetExceededError } from '@/lib/llm-budget';
import { readUIMessageStream, type UIMessageChunk } from 'ai';
import { transformDataStreamOrSseToUiChunks } from '@/lib/ai/sidecar-chat-transport';
import { readSseStream } from '@/lib/sse';

describe('LLM 网关轻量级三态断路器 (CircuitBreaker)', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 5,
      failureRateThreshold: 0.5,
      windowSize: 10,
      cooldownMs: 100,
      probeCount: 1,
    });
  });

  it('CLOSED -> OPEN（连续5次503或50%窗口失败率）-> HALF_OPEN -> CLOSED/OPEN 状态流转', async () => {
    const key = 'platform:deepseek:deepseek-chat';
    expect([breaker.getState(key), breaker.canExecute(key)]).toEqual(['CLOSED', true]);

    for (let i = 0; i < 4; i++) breaker.recordFailure(key, { status: 503, message: 'Service Unavailable' });
    expect(breaker.getState(key)).toBe('CLOSED');
    breaker.recordFailure(key, { status: 503, message: 'Service Unavailable' });
    expect([breaker.getState(key), breaker.canExecute(key)]).toEqual(['OPEN', false]);

    await new Promise((r) => setTimeout(r, 110));
    expect(breaker.getState(key)).toBe('HALF_OPEN');
    expect([breaker.canExecute(key), breaker.canExecute(key)]).toEqual([true, false]);
    breaker.recordSuccess(key);
    expect([breaker.getState(key), breaker.canExecute(key)]).toEqual(['CLOSED', true]);

    for (let i = 0; i < 5; i++) breaker.recordFailure(key, { status: 503, message: 'Service Unavailable' });
    await new Promise((r) => setTimeout(r, 110));
    expect(breaker.canExecute(key)).toBe(true);
    breaker.recordFailure(key, { status: 503, message: 'Service Unavailable' });
    expect([breaker.getState(key), breaker.canExecute(key)]).toEqual(['OPEN', false]);

    const rateBreaker = new CircuitBreaker({ failureThreshold: 999, failureRateThreshold: 0.5, windowSize: 10, cooldownMs: 100, probeCount: 1 });
    const rKey = 'platform:dashscope:qwen-plus';
    for (let i = 0; i < 5; i++) rateBreaker.recordSuccess(rKey);
    for (let i = 0; i < 4; i++) rateBreaker.recordFailure(rKey, new Error('ECONNREFUSED'));
    expect(rateBreaker.getState(rKey)).toBe('CLOSED');
    rateBreaker.recordFailure(rKey, new Error('ECONNREFUSED'));
    expect(rateBreaker.getState(rKey)).toBe('OPEN');
  });

  it('HALF_OPEN 探针 429 切回 OPEN、AbortError 释放配额、泄漏超时自动重置', async () => {
    const key429 = 'platform:dashscope:qwen-plus';
    for (let i = 0; i < 5; i++) breaker.recordFailure(key429, { status: 503, message: '503' });
    await new Promise((r) => setTimeout(r, 110));
    expect(breaker.canExecute(key429)).toBe(true);
    breaker.recordFailure(key429, { status: 429, message: 'Too Many Requests' });
    expect([breaker.getState(key429), breaker.canExecute(key429)]).toEqual(['OPEN', false]);
    await new Promise((r) => setTimeout(r, 110));
    expect([breaker.getState(key429), breaker.canExecute(key429)]).toEqual(['HALF_OPEN', true]);
    breaker.recordSuccess(key429);
    expect(breaker.getState(key429)).toBe('CLOSED');

    const keyAbort = 'platform:deepseek:deepseek-chat';
    for (let i = 0; i < 5; i++) breaker.recordFailure(keyAbort, { status: 503, message: '503' });
    await new Promise((r) => setTimeout(r, 110));
    expect([breaker.canExecute(keyAbort), breaker.canExecute(keyAbort)]).toEqual([true, false]);
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    breaker.recordFailure(keyAbort, abortErr);
    expect([breaker.getState(keyAbort), breaker.canExecute(keyAbort)]).toEqual(['HALF_OPEN', true]);

    const keyLeak = 'platform:zhipu:glm-4-flash';
    for (let i = 0; i < 5; i++) breaker.recordFailure(keyLeak, { status: 503, message: '503' });
    await new Promise((r) => setTimeout(r, 110));
    expect([breaker.canExecute(keyLeak), breaker.canExecute(keyLeak)]).toEqual([true, false]);
    await new Promise((r) => setTimeout(r, 110));
    expect(breaker.canExecute(keyLeak)).toBe(true);
  });

  it('isTripEligibleError 错误分类与 buildBreakerKey 租户/平台隔离', () => {
    for (const nonTrip of [
      { status: 401, message: 'Unauthorized' },
      { statusCode: 403, message: 'Forbidden' },
      new MissingApiKeyError(),
      { status: 429, message: 'Too Many Requests' },
      new Error('请求频率过高，触发速率限制'),
      new BudgetExceededError('budget exceeded'),
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
      { status: 400, message: 'Bad Request' },
      { status: 404, message: 'Not Found' },
      { status: 422, message: 'Unprocessable' },
    ]) {
      expect(isTripEligibleError(nonTrip)).toBe(false);
    }
    expect(isRateLimitError({ status: 429 })).toBe(true);

    for (const trip of [
      { status: 500, message: 'ISE' },
      { status: 502, message: 'Bad Gateway' },
      { status: 503, message: 'Unavailable' },
      { status: 504, message: 'Timeout' },
      new Error('fetch failed'),
      new Error('connect ECONNREFUSED 127.0.0.1:443'),
      new Error('socket hang up'),
      new Error('UND_ERR_CONNECT_TIMEOUT'),
      new Error('read ECONNRESET'),
    ]) {
      expect(isTripEligibleError(trip)).toBe(true);
    }

    const key = 'platform:deepseek:deepseek-chat';
    for (let i = 0; i < 6; i++) breaker.recordFailure(key, { status: 429, message: 'rate limit' });
    expect([breaker.getState(key), breaker.getStats(key).consecutiveFailures]).toEqual(['CLOSED', 0]);

    expect(buildBreakerKey('deepseek', 'deepseek-chat')).toBe('platform:deepseek:deepseek-chat');
    expect(buildBreakerKey('deepseek', 'deepseek-chat', 'user-123')).toBe('user:user-123:deepseek:deepseek-chat');

    const userA = buildBreakerKey('deepseek', 'deepseek-chat', 'user-A');
    const userB = buildBreakerKey('deepseek', 'deepseek-chat', 'user-B');
    for (let i = 0; i < 5; i++) breaker.recordFailure(userA, { status: 503, message: '503' });
    expect([breaker.getState(userA), breaker.getState(userB), breaker.getState(key)]).toEqual(['OPEN', 'CLOSED', 'CLOSED']);
  });

  it('多服务商级联降级：503 级联 / OPEN 短路 / 全失败 / 401 Fail-Closed', async () => {
    const { runLlmGatewayGenerate } = await import('@/lib/llm-gateway/service');
    const baseInput = {
      purpose: 'code_chapter_lesson' as const,
      variables: { chapterIndex: '1', chapterTitle: 'Intro', chapterDescription: 'desc', moduleDirectories: ['src'], skipMetaCompiler: true },
      userId: null,
    };
    const candidates = [
      { provider: 'deepseek', modelId: 'deepseek-chat', label: 'Primary' },
      { provider: 'dashscope', modelId: 'qwen-plus', label: 'Backup 1' },
    ];

    const b1 = new CircuitBreaker();
    const calls1: string[] = [];
    const res1 = await runLlmGatewayGenerate(baseInput, {
      circuitBreaker: b1,
      cascadeCandidates: candidates,
      completeFn: vi.fn(async (opts: any) => {
        calls1.push(`${opts.provider}/${opts.modelId}`);
        if (opts.provider === 'deepseek') throw Object.assign(new Error('503'), { status: 503 });
        return { text: 'success from backup', usage: { totalTokens: 15 }, finishReason: 'stop' };
      }) as any,
    });
    expect(res1.ok && res1.text).toBe('success from backup');
    expect(calls1).toEqual(['deepseek/deepseek-chat', 'dashscope/qwen-plus']);

    const b2 = new CircuitBreaker();
    for (let i = 0; i < 5; i++) b2.recordFailure(buildBreakerKey('deepseek', 'deepseek-chat', null), { status: 503, message: '503' });
    const calls2: string[] = [];
    const res2 = await runLlmGatewayGenerate(baseInput, {
      circuitBreaker: b2,
      cascadeCandidates: candidates,
      completeFn: vi.fn(async (opts: any) => {
        calls2.push(`${opts.provider}/${opts.modelId}`);
        return { text: 'instant backup', usage: { totalTokens: 10 }, finishReason: 'stop' };
      }) as any,
    });
    expect(res2.ok && res2.text).toBe('instant backup');
    expect(calls2).toEqual(['dashscope/qwen-plus']);

    const resFail = await runLlmGatewayGenerate(baseInput, {
      circuitBreaker: new CircuitBreaker(),
      cascadeCandidates: candidates,
      completeFn: vi.fn(async () => { throw Object.assign(new Error('504'), { status: 504 }); }) as any,
    });
    expect(!resFail.ok && resFail.code).toBe('UPSTREAM_SERVER_ERROR');

    const calls401: string[] = [];
    const res401 = await runLlmGatewayGenerate(baseInput, {
      circuitBreaker: new CircuitBreaker(),
      cascadeCandidates: candidates,
      completeFn: vi.fn(async (opts: any) => {
        calls401.push(`${opts.provider}/${opts.modelId}`);
        throw new MissingApiKeyError('Invalid API Key');
      }) as any,
    });
    expect(!res401.ok && res401.code).toBe('MISSING_API_KEY');
    expect(calls401).toEqual(['deepseek/deepseek-chat']);
  });

  it('NDJSON 流式直通网关：首帧启动失败或生成器首帧前异常均级联备用且不误记成功', async () => {
    const { runLlmGatewayStream } = await import('@/lib/llm-gateway/service');
    const baseInput = {
      purpose: 'code_chapter_lesson' as const,
      variables: { chapterIndex: '1', chapterTitle: 'Intro', chapterDescription: 'desc', moduleDirectories: ['src'], skipMetaCompiler: true },
      userId: null,
    };
    const candidates = [
      { provider: 'deepseek', modelId: 'deepseek-chat' },
      { provider: 'dashscope', modelId: 'qwen-plus' },
    ];
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      let out = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        out += dec.decode(value);
      }
      return out;
    };

    const calls1: string[] = [];
    const out1 = await drain(
      runLlmGatewayStream(baseInput, {
        circuitBreaker: new CircuitBreaker(),
        cascadeCandidates: candidates,
        pingIntervalMs: 0,
        completeFn: vi.fn(async (opts: any) => {
          calls1.push(`${opts.provider}/${opts.modelId}`);
          if (opts.provider === 'deepseek') throw Object.assign(new Error('503'), { status: 503 });
          return { text: 'streamed fallback text', usage: { totalTokens: 8 }, finishReason: 'stop' };
        }) as any,
      })
    );
    expect(calls1).toEqual(['deepseek/deepseek-chat', 'dashscope/qwen-plus']);
    expect(out1).toContain('streamed fallback text');

    const b2 = new CircuitBreaker();
    const calls2: string[] = [];
    const out2 = await drain(
      runLlmGatewayStream(baseInput, {
        circuitBreaker: b2,
        cascadeCandidates: candidates,
        pingIntervalMs: 0,
        streamFn: vi.fn(async (opts: any) => {
          calls2.push(`${opts.provider}/${opts.modelId}`);
          if (opts.provider === 'deepseek') {
            return {
              fullStream: (async function* () {
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
        }) as any,
      })
    );
    expect(b2.getStats(buildBreakerKey('deepseek', 'deepseek-chat', null)).consecutiveFailures).toBe(1);
    expect(calls2).toEqual(['deepseek/deepseek-chat', 'dashscope/qwen-plus']);
    expect(out2).toContain('recovered chunk');
  });
});

describe('sidecar-chat-transport & sse-stream', () => {
  const byteStream = (parts: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    });

  it('transformDataStreamOrSseToUiChunks: v4 data-stream / v7 SSE / 3: error 帧转换', async () => {
    const enc = new TextEncoder();
    const v4 = enc.encode(
      ': ping\n\nb:"分析 Neuron 类结构"\n0:"该类的核心作用是"\n0:"封装计算。"\nd:{"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":12}}\ne:{"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":12},"isContinued":false}\n'
    );
    let lastMsg: unknown = null;
    for await (const msg of readUIMessageStream({ stream: transformDataStreamOrSseToUiChunks(byteStream([v4.slice(0, 23), v4.slice(23, 55), v4.slice(55)])) })) {
      lastMsg = msg;
    }
    expect(lastMsg).toMatchObject({
      role: 'assistant',
      parts: expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', text: '分析 Neuron 类结构' }),
        expect.objectContaining({ type: 'text', text: '该类的核心作用是封装计算。' }),
      ]),
    });

    const collect = async (s: ReadableStream<UIMessageChunk>) => {
      const r = s.getReader();
      const out: UIMessageChunk[] = [];
      while (true) {
        const { done, value } = await r.read();
        if (done) break;
        out.push(value);
      }
      return out;
    };

    const sse = 'data: {"type":"start"}\n\ndata: {"type":"text-delta","id":"t1","delta":"Hi"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n\n';
    expect((await collect(transformDataStreamOrSseToUiChunks(byteStream([enc.encode(sse)])))).map((c) => c.type)).toEqual([
      'start',
      'text-delta',
      'finish',
    ]);

    const errChunks = await collect(transformDataStreamOrSseToUiChunks(byteStream([enc.encode('3:{"code":"PROVIDER_ERROR","message":"Upstream rate limit"}\n')])));
    expect(errChunks).toContainEqual({ type: 'error', errorText: 'Upstream rate limit' });
  });

  it('readSseStream: 标准分帧、跨 chunk 断帧、多行 data、残余帧、心跳忽略与串行异步回调', async () => {
    const enc = new TextEncoder();
    const streamOf = (chunks: string[]) => byteStream(chunks.map((c) => enc.encode(c)));

    const ev1: Array<{ event: string; data: string }> = [];
    await readSseStream(streamOf(['event: step\ndata: {"a":1}\n\nevent: complete\ndata: {"b":2}\n\n']), (e) => { ev1.push(e); });
    expect(ev1).toEqual([{ event: 'step', data: '{"a":1}' }, { event: 'complete', data: '{"b":2}' }]);

    const ev2: Array<{ event: string; data: string }> = [];
    await readSseStream(streamOf(['event: step\nda', 'ta: {"x":1}\n\n']), (e) => { ev2.push(e); });
    expect(ev2).toEqual([{ event: 'step', data: '{"x":1}' }]);

    const ev3: Array<{ event: string; data: string }> = [];
    await readSseStream(streamOf(['data: line1\ndata: line2\n\n']), (e) => { ev3.push(e); });
    expect(ev3).toEqual([{ event: 'message', data: 'line1\nline2' }]);

    const ev4: Array<{ event: string; data: string }> = [];
    await readSseStream(streamOf(['event: done\ndata: "last"']), (e) => { ev4.push(e); });
    expect(ev4).toEqual([{ event: 'done', data: '"last"' }]);

    const ev5: Array<{ event: string; data: string }> = [];
    await readSseStream(streamOf([': ping\n\n:event: keepalive\n\n']), (e) => { ev5.push(e); });
    expect(ev5).toEqual([]);

    const order: string[] = [];
    await readSseStream(streamOf(['data: 1\n\ndata: 2\n\ndata: 3\n\n']), async ({ data }) => {
      await Promise.resolve();
      order.push(data);
    });
    expect(order).toEqual(['1', '2', '3']);
  });
});
