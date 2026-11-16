import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LLM 流式管道横截面守恒与收尾时序单测（llm-gateway/service.ts）。
 *
 * 与既有 llm-gateway.test.ts 的分工：既有文件已锚定首帧告警（STREAM_SHAPE_DRIFT
 * reasoning 场景）、未知类型告警、reasoning 守恒告警与 summary 单行格式；
 * 本文件锁定**时间维度与守恒数值**：
 * - parts_in == events_out 精确守恒（N 个 delta → 恰 N 个 chunk 事件）；
 * - 中途异常 / 消费方 cancel 的收尾：summary 恰 1 次、outcome 真实、
 *   计数停在事实值（不虚报、不悬挂）——summaryLogged 防重入；
 * - 零逐事件持久化（宪章 II.5：流式观测 O(1) 写放大，聚合账本单行收口）。
 */

vi.mock('@/lib/db', () => ({
  // 零持久化 tripwire：流式路径若引入任何 DB 写（逐事件落库），本文件立即失败。
  // prompt.findUnique 是 PromptRegistry 的合法读路径（供给兜底），不算写放大。
  prisma: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    tokenUsageLog: { create: vi.fn(), createMany: vi.fn(), update: vi.fn() },
    llmCallLog: { create: vi.fn(), createMany: vi.fn(), update: vi.fn() },
    prompt: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

import { runLlmGatewayStream } from '@/lib/llm-gateway/service';

const PURPOSE = 'doc_transcribe_enhance_localize';

async function readNdjsonEvents(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Record<string, unknown>[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  if (buffer.trim()) events.push(JSON.parse(buffer));
  return events;
}

/** 每个用例注入唯一 provider 名——隔离模块级熔断器的跨用例状态污染 */
function depsFor(
  streamFn: () => Promise<{ fullStream: AsyncGenerator<unknown>; finishReason: string }>,
  extra: Record<string, unknown> = {},
) {
  return {
    streamFn,
    pingIntervalMs: 0,
    cascadeCandidates: [{ provider: `p3-conservation-${Math.random().toString(36).slice(2, 8)}`, modelId: 'm' }],
    ...extra,
  };
}

async function* textDeltaStream(count: number): AsyncGenerator<unknown> {
  for (let i = 0; i < count; i++) {
    yield { type: 'text-delta', text: `chunk-${i}` };
  }
}

function summaryLines(calls: unknown[][]): string[] {
  return calls
    .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
    .filter((s) => s.startsWith('[llm-stream] call='));
}

describe('流式横截面守恒律（parts_in == events_out）', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('42 个 content delta → 恰 42 个 chunk_content 事件，summary 计数双侧 42（ping 关闭）', async () => {
    const stream = runLlmGatewayStream(
      { purpose: PURPOSE, variables: {} },
      depsFor(async () => ({ fullStream: textDeltaStream(42), finishReason: 'stop' })),
    );
    const events = await readNdjsonEvents(stream);

    const chunkEvents = events.filter((e) => e.type === 'chunk' && e.kind === 'content');
    expect(chunkEvents).toHaveLength(42);
    expect(events.filter((e) => e.type === 'ping')).toHaveLength(0);
    // 事件序保持输入序（无乱序/丢帧）
    expect(chunkEvents[0].delta).toBe('chunk-0');
    expect(chunkEvents[41].delta).toBe('chunk-41');

    const lines = summaryLines(logSpy.mock.calls);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /outcome=success parts=\{text:42,reasoning:0,other:0,unknown:0\} events=\{chunk_content:42,chunk_reasoning:0,ping:0\}/,
    );
  });

  it('丢帧不丢计数：7 个 content parts 中 2 个空载荷 → parts=7 / events=5，横截面计数器暴露差值', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      async function* driftingStream() {
        yield { type: 'text-delta', id: 'f1' }; // 空载荷（漂移帧 1）
        yield { type: 'text-delta', text: 'a' };
        yield { type: 'text-delta', id: 'f3' }; // 空载荷（漂移帧 2——warn-once 不刷屏）
        yield { type: 'text-delta', text: 'b' };
        yield { type: 'text-delta', text: 'c' };
        yield { type: 'text-delta', text: 'd' };
        yield { type: 'text-delta', text: 'e' };
      }
      const stream = runLlmGatewayStream(
        { purpose: PURPOSE, variables: {} },
        depsFor(async () => ({ fullStream: driftingStream(), finishReason: 'stop' })),
      );
      const events = await readNdjsonEvents(stream);

      expect(events.filter((e) => e.type === 'chunk' && e.kind === 'content')).toHaveLength(5);
      // Frame-1 fail-fast：content 场景同样首帧告警且只告警一次（actual_keys 指认）
      const driftCalls = errSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('STREAM_SHAPE_DRIFT'),
      );
      expect(driftCalls).toHaveLength(1);
      expect(driftCalls[0][0]).toContain('text-delta missing text payload on frame 1! actual_keys=');
      // 横截面守恒计数器忠实暴露 7 in / 5 out（差值=丢帧数）
      const lines = summaryLines(logSpy.mock.calls);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/parts=\{text:7,reasoning:0,other:0,unknown:0\} events=\{chunk_content:5,/);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('收尾时序：中途异常与消费方 cancel', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('第 17 帧后上游爆炸：error 事件透出，summary 恰 1 次 outcome=error，计数停在 17 不虚报', async () => {
    async function* explodingStream() {
      for (let i = 0; i < 17; i++) {
        yield { type: 'text-delta', text: `chunk-${i}` };
      }
      throw new Error('upstream exploded mid-stream');
    }
    const stream = runLlmGatewayStream(
      { purpose: PURPOSE, variables: {} },
      depsFor(async () => ({ fullStream: explodingStream(), finishReason: 'stop' })),
    );
    const events = await readNdjsonEvents(stream);

    // 已产出的 17 个 chunk 事件完整送达（不因异常回撤）
    expect(events.filter((e) => e.type === 'chunk' && e.kind === 'content')).toHaveLength(17);
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ ok: false, code: 'GENERATION_FAILED' });
    expect(String(errorEvents[0].message)).toContain('upstream exploded mid-stream');

    // summary 恰 1 次：outcome=error、计数=17（事实值）
    const lines = summaryLines(logSpy.mock.calls);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/outcome=error parts=\{text:17,reasoning:0,other:0,unknown:0\} events=\{chunk_content:17,/);
  });

  it('消费方 cancel()：summary 恰 1 次 outcome=cancelled（与 finally 不双发），流即刻收口', async () => {
    async function* infiniteStream() {
      while (true) {
        yield { type: 'text-delta', text: 'tick' };
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    const stream = runLlmGatewayStream(
      { purpose: PURPOSE, variables: {} },
      depsFor(async () => ({ fullStream: infiniteStream(), finishReason: 'stop' })),
    );

    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    await reader.cancel();
    await new Promise((r) => setTimeout(r, 50)); // 给后台泵与 finally 留出竞态窗口

    const lines = summaryLines(logSpy.mock.calls);
    expect(lines).toHaveLength(1); // cancel() 与 finally 双路径下仍只落一条账
    expect(lines[0]).toMatch(/outcome=cancelled /);
  });

  it('零逐事件持久化（O(1) 写放大）：100 帧长流全程零 DB 写调用，仅收尾 1 条聚合账本行', async () => {
    const { prisma } = await import('@/lib/db');
    const stream = runLlmGatewayStream(
      { purpose: PURPOSE, variables: {} },
      depsFor(async () => ({ fullStream: textDeltaStream(100), finishReason: 'stop' })),
    );
    const events = await readNdjsonEvents(stream);
    expect(events.filter((e) => e.type === 'chunk')).toHaveLength(100);

    // 宪章 II.5：观测数据不落库——写能力入口（raw/事务/写入方法）全程 0 次调用
    const writeEntries: Array<[string, { mock?: { calls: unknown[] } }]> = [
      ['$queryRaw', prisma.$queryRaw],
      ['$executeRaw', prisma.$executeRaw],
      ['$transaction', prisma.$transaction],
      ...(['tokenUsageLog', 'llmCallLog'] as const).flatMap((model) =>
        (['create', 'createMany', 'update'] as const).map(
          (method) => [`${model}.${method}`, prisma[model][method]] as [string, { mock?: { calls: unknown[] } }],
        ),
      ),
    ];
    for (const [key, fn] of writeEntries) {
      const calls = fn.mock?.calls ?? [];
      expect(calls, `流式期间 prisma.${key} 不得被调用`).toHaveLength(0);
    }
    // 唯一的聚合账本：console 单行（callId 关联）
    expect(summaryLines(logSpy.mock.calls)).toHaveLength(1);
  });
});
