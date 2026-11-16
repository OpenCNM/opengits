import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { MissingApiKeyError } from '@/lib/ai';
import { BudgetExceededError } from '@/lib/llm-budget';
import { internalAuthGuard } from '@/lib/internal-auth';
import {
  runLlmGatewayGenerate,
  runLlmGatewayStream,
  llmGenerateRequestSchema,
  LLM_GATEWAY_ERROR_CODES,
} from '@/lib/llm-gateway/service';
import { normalizeStreamPart } from '@/lib/llm-gateway/stream-normalizer';
import { POST as llmGenerateRoute } from '@/app/api/internal/llm/generate/route';
import { lookupLlmPurpose, registeredLlmPurposes } from '@/lib/llm-gateway/registry';

// 需真实 PostgreSQL：缺库时网关 PromptRegistry 兜底读取抛 PrismaClientInitializationError，
// 其 console.warn 异步落在「未知类型告警」用例窗口，污染 warnSpy 精确计数（expected 1 got 2）。
// 门控沿用 go-sidecar job 同款惯例：仅认显式注入的 WORKER_TEST_DATABASE_URL
// （未注入时仅该用例自动 skip）——不直接认 DATABASE_URL，因其会被 ai.ts 顶部的
// dotenv.config(override) 从本地 .env 静默注入（本机凭据未必可用，门形同虚设）。
const HAS_TEST_DB = Boolean(process.env.WORKER_TEST_DATABASE_URL);

/** fake 漏斗：离线跑网关服务层（与 ai.ts 的 model 注入同先例，零 API 成本） */
function makeDeps(overrides: { object?: unknown; text?: string; error?: Error } = {}) {
  const generateCalls: unknown[] = [];
  const completeCalls: unknown[] = [];
  const object = overrides.object ?? { edges: [] };
  const text = overrides.text ?? '===CONTENT_BEGIN===ok===CONTENT_END===';
  return {
    generateCalls,
    completeCalls,
    deps: {
      generateFn: (async (opts: unknown) => {
        generateCalls.push(opts);
        if (overrides.error) throw overrides.error;
        return { object, usage: { totalTokens: 10 }, mode: 'json_schema' as const, finishReason: 'stop' };
      }) as never,
      completeFn: (async (opts: unknown) => {
        completeCalls.push(opts);
        if (overrides.error) throw overrides.error;
        return { text, usage: { totalTokens: 20 }, finishReason: 'stop' };
      }) as never,
    },
  };
}

describe('LLM 网关（M1 purpose 注册表 + M2 text 形态）', () => {
  it('purpose 注册表：试点 purpose 已注册且 schema 可校验', () => {
    expect(registeredLlmPurposes()).toContain('mcp_concept_edges');
    expect(registeredLlmPurposes()).toContain('doc_transcribe_enhance_localize');
    expect(registeredLlmPurposes()).toContain('mdx_repair');
    expect(registeredLlmPurposes()).toContain('chapter_map');
    expect(registeredLlmPurposes()).toContain('webdoc_outline_synthesizer');
    expect(registeredLlmPurposes()).toContain('outline_map_v1');
    expect(registeredLlmPurposes()).toContain('outline_sampler_v1');
    expect(registeredLlmPurposes()).toContain('code_chapter_lesson');
    const purpose = lookupLlmPurpose('mcp_concept_edges')!;
    expect(purpose.kind).toBe('structured');
    expect(purpose.keyOrigin).toBe('user');
    const ok = purpose.schema!.safeParse({
      edges: [{ fromConcept: 'a', toConcept: 'b', type: 'related', weight: 0.5, evidence: 'x' }],
    });
    expect(ok.success).toBe(true);
    const bad = purpose.schema!.safeParse({
      edges: [{ fromConcept: 'a', toConcept: 'b', type: 'related', weight: 1.5, evidence: 'x' }],
    });
    expect(bad.success).toBe(false);
  });

  it('code_chapter_lesson purpose：text 形态 + tutor_explanation + compile 变量归一化', async () => {
    const p = lookupLlmPurpose('code_chapter_lesson')!;
    expect(p.kind).toBe('text');
    expect(p.source).toBe('tutor_explanation');
    expect(p.keyOrigin).toBe('user');
    expect(p.temperature).toBe(0.2);
    expect(p.maxTokens).toBe(16000);

    const { deps, completeCalls } = makeDeps({ text: 'lesson output' });
    const result = await runLlmGatewayGenerate(
      {
        purpose: 'code_chapter_lesson',
        variables: {
          chapterIndex: '3',
          chapterTitle: 'Core Engine',
          chapterDescription: 'Deep dive into core',
          targetLanguage: '',
          teachingDepth: 'DEEP',
          moduleDirectories: ['src/core'],
          cognitiveScaffold: 'Scaffold gradient info',
          upstreamTerminologySection: '[UPSTREAM PRECEDENT CONCEPTS & TERMINOLOGY — MANDATORY CONTINUITY]\n- Store, MemTable',
          architectureSkeletonSection: '```mermaid\nflowchart TD\n  fn1["Engine()"] --> fn2["Run()"]\n```',
          filesSummary: '[File 1] src/core/index.ts (10 lines)\n```\nexport const x = 1;\n```',
          skipMetaCompiler: true,
        },
        userId: 'u1',
      },
      deps,
    );
    expect(result).toMatchObject({ ok: true, text: 'lesson output', finishReason: 'stop' });
    const call = completeCalls[0] as Record<string, unknown>;
    expect(call.source).toBe('tutor_explanation');
    expect(call.temperature).toBe(0.2);
    expect(call.maxTokens).toBe(16000);
    const prompt = String(call.prompt);
    expect(prompt).toContain('Chapter 3: "Core Engine"');
    expect(prompt).toContain('All narrative explanations, summaries, diagram captions, and markdown headings MUST be written in zh');
    expect(prompt).toContain('[TEACHING DEPTH: DEEP]');
    expect(prompt).toContain('Exhaustive function-by-function analysis');
    expect(prompt).toContain('src/core');
    expect(prompt).toContain('Scaffold gradient info');
    expect(prompt).toContain('[UPSTREAM PRECEDENT CONCEPTS & TERMINOLOGY — MANDATORY CONTINUITY]');
    expect(prompt).toContain('- Store, MemTable');
    expect(prompt).toContain('[ARCHITECTURE TOPOLOGY SKELETON (Ground Truth Call Flow & Dependencies)]');
    expect(prompt).toContain('fn1["Engine()"] --> fn2["Run()"]');
    expect(prompt).toContain('export const x = 1;');
  });

  it('chapter_map purpose：structured 形态共享 chapterMapSchema（单一事实源）', async () => {
    const p = lookupLlmPurpose('chapter_map')!;
    expect(p.kind).toBe('structured');
    expect(p.source).toBe('indexer');
    // schema 生效：合法章节映射通过
    const ok = p.schema!.safeParse({
      isTutorial: true,
      chapters: [{ order: 1, title: '入门', mainPath: 'docs/a.md', assetPaths: [] }],
    });
    expect(ok.success).toBe(true);
    // 编译消费变量（模板 key chapter_map_builder）
    const { deps, generateCalls } = makeDeps({ object: { chapters: [] } });
    const result = await runLlmGatewayGenerate(
      { purpose: 'chapter_map', variables: { owner: 'o', repo: 'r', docFiles: ['a.md'], codeFiles: [] }, userId: 'u1' },
      deps,
    );
    expect(result).toMatchObject({ ok: true, mode: 'json_schema' });
    const call = generateCalls[0] as Record<string, unknown>;
    expect(call.source).toBe('indexer');
    expect(String(call.prompt)).toContain('o');
  });

  it('outline_map_v1：structured 形态 + 容错 schema 单一事实源', () => {
    const om = lookupLlmPurpose('outline_map_v1')!;
    expect(om.kind).toBe('structured');
    expect(om.schema!.safeParse({ chapters: [{ name: '第 1 章', summary: 's', files: ['a.go'], phase: '入门' }] }).success).toBe(true);
  });

  it('outline_sampler_v1：AI 采样器 structured 形态、25 上限约束与 Prompt 渲染', async () => {
    const os = lookupLlmPurpose('outline_sampler_v1')!;
    expect(os).toBeDefined();
    expect(os.kind).toBe('structured');
    expect(os.source).toBe('outline-sampler');
    expect(os.disableThinking).toBe(true);
    expect(os.timeoutMs).toBe(5000);

    // Schema 校验：合规采样结果
    const valid = os.schema!.safeParse({
      architectureArchetype: 'game_engine',
      subsystemCount: 4,
      needFiles: ['src/main.cpp', 'src/render/gl.cpp'],
    });
    expect(valid.success).toBe(true);

    // Schema 校验：空 needFiles 失败 (min 1)
    const emptyFiles = os.schema!.safeParse({
      architectureArchetype: 'compiler',
      subsystemCount: 2,
      needFiles: [],
    });
    expect(emptyFiles.success).toBe(false);

    // Schema 校验：超过 25 个文件失败 (max 25)
    const tooManyFiles = os.schema!.safeParse({
      architectureArchetype: 'web_framework',
      subsystemCount: 8,
      needFiles: Array.from({ length: 26 }, (_, i) => `file_${i}.ts`),
    });
    expect(tooManyFiles.success).toBe(false);

    // Prompt 编译测试
    const prompt = await os.compile({
      skeleton: 'root/\n  src/\n    main.go',
      readme: '# Demo Engine\nFast 3D engine.',
      prefix: 'services/core',
    });
    expect(prompt).toContain('=== 项目 README 摘要 ===');
    expect(prompt).toContain('# Demo Engine');
    expect(prompt).toContain('=== 仓库目录骨架 ===');
    expect(prompt).toContain('root/\n  src/\n    main.go');
    expect(prompt).toContain('services/core');
    expect(prompt).toContain('硬性上限 25 个');
  });

  it('outline_map_v1 / outline_plan_v1：非 Thinking 直出与 AST 拓扑分层 Prompt 验证', async () => {
    const om = lookupLlmPurpose('outline_map_v1')!;
    expect(om.disableThinking).toBe(true);
    const prompt = await om.compile({ map: '=== [Layer 0] ===\na.go\n=== [Layer 1] ===\nb.go' });
    // R1 重写后契约：子系统多尺度地图指令取代旧五维架构维度投影
    expect(prompt).toContain('子系统多尺度地图（Subsystem Topology Map）');
    expect(prompt).toContain('任务：依据子系统全景（Subsystem Topology）、跨模块调用依赖与各模块核心文件/导出符号');
    expect(prompt).toContain('=== 仓库架构全景（子系统多尺度地图） ===');
    expect(prompt).toContain('=== [Layer 0] ===\na.go'); // 地图原文逐字嵌入 prompt
    expect(prompt).not.toContain('基础底座与数据契约'); // 五维悬空指令已清除
    expect(prompt).toContain('直接输出 JSON');

    const op = lookupLlmPurpose('outline_plan_v1')!;
    expect(op.disableThinking).toBe(true);
    const planPrompt = await op.compile({ skeleton: 'root/\n  core/' });
    expect(planPrompt).toContain('全书必须划分为 2~4 个认知模块（moduleTitle）');
    expect(planPrompt).toContain('严格单调递增');
    expect(planPrompt).toContain('moduleTitle');

    const validPlan = op.schema!.safeParse({
      chapters: [
        {
          moduleTitle: '模块 1: 架构全景与环境准备',
          name: '第 1 章: 项目总览',
          summary: '项目总览与快速上手',
          targetPaths: ['README.md'],
          phase: '入门',
        },
      ],
    });
    expect(validPlan.success).toBe(true);

    const invalidPlan = op.schema!.safeParse({
      chapters: [
        {
          name: '第 1 章: 项目总览',
          summary: '缺少 moduleTitle',
          targetPaths: ['README.md'],
          phase: '入门',
        },
      ],
    });
    expect(invalidPlan.success).toBe(false);

    // needRollup 容忍带：巨仓规划自然超额(>3)不再整锅拒绝——模型不知道
    // 的隐藏上限杀掉整条管线是校验闸越权；闸门只拦真畸形(>10)，超额由
    // Go 消费方确定性截前 3 收敛
    const chapter = {
      moduleTitle: '模块 1: 架构全景与环境准备',
      name: '第 1 章: 项目总览',
      summary: '项目总览与快速上手',
      targetPaths: ['README.md'],
      phase: '入门',
    };
    expect(
      op.schema!.safeParse({ chapters: [chapter], needRollup: ['src/', 'packages/', 'extensions/', 'apps/'] }).success,
    ).toBe(true);
    expect(
      op.schema!.safeParse({
        chapters: [chapter],
        needRollup: Array.from({ length: 11 }, (_, i) => `p${i}/`),
      }).success,
    ).toBe(false);
    expect(planPrompt).toContain('≤3 个路径');

    const { deps, generateCalls } = makeDeps();
    await runLlmGatewayGenerate({ purpose: 'outline_map_v1', variables: {} }, deps);
    const call = generateCalls[0] as Record<string, unknown>;
    expect(call.disableThinking).toBe(true);
  });

  it('text purpose 配置：maxTokens=16000 / temperature 逐字对齐模板 modelConfig', () => {
    const t1 = lookupLlmPurpose('doc_transcribe_enhance_localize')!;
    expect(t1.kind).toBe('text');
    expect(t1.maxTokens).toBe(16000);
    expect(t1.temperature).toBe(0.1);
    const t2 = lookupLlmPurpose('mdx_repair')!;
    expect(t2.kind).toBe('text');
    expect(t2.maxTokens).toBe(16000);
    expect(t2.temperature).toBe(0.0);
  });

  it('🧪 [11.7.2.2] 未注册 purpose → UNKNOWN_PURPOSE（400），不触达 LLM', async () => {
    const { deps, generateCalls, completeCalls } = makeDeps();
    const result = await runLlmGatewayGenerate({ purpose: 'nope', variables: {} }, deps);
    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_PURPOSE' });
    expect(generateCalls.length + completeCalls.length).toBe(0);
  });

  it('🧪 [11.7.2.1] structured 成功路径：透传 keyOrigin/source/userId，wire 无 prompt 原文回显', async () => {
    const { deps, generateCalls } = makeDeps();
    const result = await runLlmGatewayGenerate(
      {
        purpose: 'mcp_concept_edges',
        variables: { conceptList: '- a', contextText: 'ctx' },
        userId: 'u1',
      },
      deps,
    );
    expect(result).toMatchObject({ ok: true, mode: 'json_schema' });
    const call = generateCalls[0] as Record<string, unknown>;
    expect(call.keyOrigin).toBe('user');
    expect(call.source).toBe('llm-edges');
    expect(call.userId).toBe('u1');
    expect(typeof call.prompt).toBe('string');
    expect((call.prompt as string).length).toBeGreaterThan(0);
  });

  it('text 成功路径：透传 maxTokens/temperature，返回原文 + finishReason', async () => {
    const { deps, completeCalls } = makeDeps({ text: 'raw output' });
    const result = await runLlmGatewayGenerate(
      {
        purpose: 'doc_transcribe_enhance_localize',
        variables: { targetLanguage: '中文', content: '# doc', condensationMode: 'balanced' },
        userId: 'u1',
      },
      deps,
    );
    expect(result).toMatchObject({ ok: true, text: 'raw output', finishReason: 'stop' });
    const call = completeCalls[0] as Record<string, unknown>;
    expect(call.maxTokens).toBe(16000);
    expect(call.temperature).toBe(0.1);
    expect(call.source).toBe('transcription');
  });

  it('🧪 [11.7.3.1] MissingApiKeyError → MISSING_API_KEY（409）', async () => {
    const { deps } = makeDeps({ error: new MissingApiKeyError('no key') });
    const result = await runLlmGatewayGenerate({ purpose: 'mcp_concept_edges', variables: {} }, deps);
    expect(result).toMatchObject({ ok: false, code: 'MISSING_API_KEY' });
    expect(LLM_GATEWAY_ERROR_CODES.MISSING_API_KEY).toBe(409);
  });

  it('🧪 [11.7.3.1] BudgetExceededError → BUDGET_EXCEEDED（429，延后重试语义）', async () => {
    const { deps } = makeDeps({ error: new BudgetExceededError('user') });
    const result = await runLlmGatewayGenerate({ purpose: 'doc_transcribe_enhance_localize', variables: {} }, deps);
    expect(result).toMatchObject({ ok: false, code: 'BUDGET_EXCEEDED' });
    expect(LLM_GATEWAY_ERROR_CODES.BUDGET_EXCEEDED).toBe(429);
  });

  it('🧪 [11.7.3.2] 其余异常 → GENERATION_FAILED（502），消息截断 500 字符', async () => {
    const { deps } = makeDeps({ error: new Error('x'.repeat(1000)) });
    const result = await runLlmGatewayGenerate({ purpose: 'mdx_repair', variables: {} }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('GENERATION_FAILED');
      expect(result.message.length).toBeLessThanOrEqual(500);
    }
  });

  it('🧪 [11.7.4.1] 请求 schema：variables 缺省空对象、userId 可空（worker 侧零密钥字段）', () => {
    expect(llmGenerateRequestSchema.parse({ purpose: 'p' })).toMatchObject({ variables: {} });
    expect(llmGenerateRequestSchema.parse({ purpose: 'p', userId: null }).userId).toBeNull();
    expect(llmGenerateRequestSchema.safeParse({}).success).toBe(false);
  });

  it('🧪 [11.7.2.3] LLM 网关 NDJSON 心跳流式直通防御静默长连接中断', async () => {
    async function* fakeStream() {
      yield { type: 'text-delta', text: 'chunk 1; ' };
      await new Promise((r) => setTimeout(r, 20));
      yield { type: 'text-delta', text: 'chunk 2; ' };
    }
    const deps = {
      streamFn: async () => ({
        fullStream: fakeStream(),
        finishReason: 'stop',
        usage: { totalTokens: 42 },
      }),
      pingIntervalMs: 5,
    };

    const stream = runLlmGatewayStream(
      {
        purpose: 'doc_transcribe_enhance_localize',
        variables: { targetLanguage: 'zh', content: '# test', condensationMode: 'balanced' },
      },
      deps,
    );

    const events = await readNdjsonEvents(stream);
    const pings = events.filter((e) => e.type === 'ping');
    const chunks = events.filter((e) => e.type === 'chunk');
    const done = events.find((e) => e.type === 'done');

    expect(pings.length).toBeGreaterThanOrEqual(1);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].delta).toBe('chunk 1; ');
    expect(chunks[1].delta).toBe('chunk 2; ');
    expect(done).toMatchObject({
      type: 'done',
      ok: true,
      text: 'chunk 1; chunk 2; ',
      finishReason: 'stop',
    });
  });

  it('stream 错误下发：UNKNOWN_PURPOSE / MISSING_API_KEY / BUDGET_EXCEEDED / GENERATION_FAILED', async () => {
    // 1. 未注册 purpose
    const s1 = runLlmGatewayStream({ purpose: 'invalid_purpose', variables: {} });
    const ev1 = await readNdjsonEvents(s1);
    expect(ev1).toHaveLength(1);
    expect(ev1[0]).toMatchObject({ type: 'error', ok: false, code: 'UNKNOWN_PURPOSE' });

    // 2. MISSING_API_KEY
    const s2 = runLlmGatewayStream(
      { purpose: 'doc_transcribe_enhance_localize', variables: {} },
      { completeFn: async () => { throw new MissingApiKeyError('no key'); } }
    );
    const ev2 = await readNdjsonEvents(s2);
    expect(ev2[0]).toMatchObject({ type: 'error', ok: false, code: 'MISSING_API_KEY' });

    // 3. BUDGET_EXCEEDED
    const s3 = runLlmGatewayStream(
      { purpose: 'doc_transcribe_enhance_localize', variables: {} },
      { completeFn: async () => { throw new BudgetExceededError('user'); } }
    );
    const ev3 = await readNdjsonEvents(s3);
    expect(ev3[0]).toMatchObject({ type: 'error', ok: false, code: 'BUDGET_EXCEEDED' });

    // 4. GENERATION_FAILED
    const s4 = runLlmGatewayStream(
      { purpose: 'doc_transcribe_enhance_localize', variables: {} },
      { completeFn: async () => { throw new Error('downstream crash'); } }
    );
    const ev4 = await readNdjsonEvents(s4);
    expect(ev4[0]).toMatchObject({ type: 'error', ok: false, code: 'GENERATION_FAILED' });
  });

  it('stream structured 模式：支持心跳并推送 done 事件带 object', async () => {
    const { deps } = makeDeps({ object: { edges: [{ fromConcept: 'x' }] } });
    const stream = runLlmGatewayStream(
      { purpose: 'mcp_concept_edges', variables: {} },
      deps
    );
    const events = await readNdjsonEvents(stream);
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({
      type: 'done',
      ok: true,
      mode: 'json_schema',
      object: { edges: [{ fromConcept: 'x' }] },
    });
  });

  it('POST /api/internal/llm/generate 端点：根据 x-stream-mode 头区分流式与一元响应', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    process.env.NODE_ENV = 'test';

    // 1. x-stream-mode: 1 ➔ 返回 application/x-ndjson
    const streamReq = new NextRequest('http://localhost/api/internal/llm/generate', {
      method: 'POST',
      headers: {
        'x-internal-token': 'test-token',
        'x-stream-mode': '1',
      },
      body: JSON.stringify({
        purpose: 'doc_transcribe_enhance_localize',
        variables: {},
      }),
    });
    const streamResp = await llmGenerateRoute(streamReq);
    expect(streamResp.headers.get('Content-Type')).toContain('application/x-ndjson');
    if (streamResp.body) {
      await readNdjsonEvents(streamResp.body as ReadableStream<Uint8Array>);
    }

    // 2. Accept: application/x-ndjson ➔ 同返回 application/x-ndjson
    const acceptReq = new NextRequest('http://localhost/api/internal/llm/generate', {
      method: 'POST',
      headers: {
        'x-internal-token': 'test-token',
        accept: 'application/x-ndjson',
      },
      body: JSON.stringify({
        purpose: 'doc_transcribe_enhance_localize',
        variables: {},
      }),
    });
    const acceptResp = await llmGenerateRoute(acceptReq);
    expect(acceptResp.headers.get('Content-Type')).toContain('application/x-ndjson');
    if (acceptResp.body) {
      await readNdjsonEvents(acceptResp.body as ReadableStream<Uint8Array>);
    }
  });

  it('stream 思考类模型适配:reasoning 增量以 kind 前送且不混入正文', async () => {
    async function* thinkingStream() {
      yield { type: 'reasoning-delta', delta: '思考片段…' };
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'text-delta', text: '正文A' };
      yield { type: 'text-delta', text: '正文B' };
    }
    const chunks: Array<{ delta: string; kind?: string }> = [];
    const { ReadableStream } = globalThis as unknown as { ReadableStream: any };
    const deps = {
      streamFn: async () => ({
        fullStream: thinkingStream(),
        finishReason: 'stop',
        usage: { totalTokens: 7 },
      }),
      pingIntervalMs: 0,
    };
    // 借运行时网关流:直接调用 runLlmGatewayStream 并消费 NDJSON 文本
    const stream = runLlmGatewayStream(
      { purpose: 'doc_enhance', variables: {} },
      deps as never
    ) as unknown as { getReader: () => any };
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let ndjson = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      ndjson += dec.decode(value as Uint8Array);
    }
    for (const line of ndjson.split('\n').filter(Boolean)) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'chunk') chunks.push({ delta: ev.delta, kind: ev.kind });
      } catch {}
    }
    const content = chunks.filter((c) => c.kind !== 'reasoning').map((c) => c.delta).join('');
    const reasoning = chunks.filter((c) => c.kind === 'reasoning').map((c) => c.delta).join('');
    expect(content).toBe('正文A正文B');
    expect(reasoning).toBe('思考片段…');
  });

  it('stream 提前取消/中断：触发 cancel 并立即回收心跳定时器', async () => {
    async function* infiniteStream() {
      while (true) {
        yield { type: 'text-delta', text: 'token ' };
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    const deps = {
      streamFn: async () => ({
        fullStream: infiniteStream(),
        finishReason: 'stop',
      }),
      pingIntervalMs: 10,
    };

    const stream = runLlmGatewayStream(
      {
        purpose: 'doc_transcribe_enhance_localize',
        variables: { targetLanguage: 'zh', content: '# test' },
      },
      deps,
    );

    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    // 模拟调用方提前取消连接
    await reader.cancel();
    const next = await reader.read();
    expect(next.done).toBe(true);
  });

  it('stream 客户端断开连接（AbortSignal 触发）：立即终止循环并回收资源', async () => {
    let yieldCount = 0;
    async function* slowStream() {
      while (true) {
        yieldCount++;
        yield { type: 'text-delta', text: `token-${yieldCount} ` };
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    const ac = new AbortController();
    const deps = {
      streamFn: async () => ({
        fullStream: slowStream(),
        finishReason: 'stop',
      }),
      pingIntervalMs: 10,
      signal: ac.signal,
    };

    const stream = runLlmGatewayStream(
      {
        purpose: 'doc_transcribe_enhance_localize',
        variables: { targetLanguage: 'zh', content: '# test' },
      },
      deps,
    );

    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    // 触发 HTTP 连接断开信号
    ac.abort();

    // 等待下一次读取，应立即 done 并不再持续产出
    await new Promise((r) => setTimeout(r, 50));
    const next = await reader.read();
    expect(next.done).toBe(true);
    const countAtAbort = yieldCount;
    await new Promise((r) => setTimeout(r, 50));
    // 验证后台生成器循环已彻底中断，没有继续无节制空转
    expect(yieldCount).toBeLessThanOrEqual(countAtAbort + 1);
  });
});

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
      if (line.trim()) {
        events.push(JSON.parse(line));
      }
    }
  }
  if (buffer.trim()) {
    events.push(JSON.parse(buffer));
  }
  return events;
}

describe('internalAuthGuard（内部端点鉴权单一事实源）', () => {
  const orig = process.env.INTERNAL_API_TOKEN;
  const origNodeEnv = process.env.NODE_ENV;

  function reqWith(token: string | null): NextRequest {
    return new NextRequest('http://localhost/api/internal/llm/generate', {
      method: 'POST',
      headers: token === null ? {} : { 'x-internal-token': token },
    });
  }

  afterEach(() => {
    process.env.INTERNAL_API_TOKEN = orig;
    process.env.NODE_ENV = origNodeEnv;
  });

  it('🧪 [11.7.1.1] 未配置 INTERNAL_API_TOKEN → 恒 403', () => {
    delete process.env.INTERNAL_API_TOKEN;
    expect(internalAuthGuard(reqWith('anything'))?.status).toBe(403);
  });

  it('🧪 [11.7.1.1] token 不匹配 → 403；匹配 → 放行（null）', () => {
    process.env.INTERNAL_API_TOKEN = 'secret-token';
    process.env.NODE_ENV = 'test';
    expect(internalAuthGuard(reqWith('wrong'))?.status).toBe(403);
    expect(internalAuthGuard(reqWith(null))?.status).toBe(403);
    expect(internalAuthGuard(reqWith('secret-token'))).toBeNull();
  });

  it('🧪 [11.7.1.1] 生产环境拒绝 compose 默认令牌', () => {
    process.env.INTERNAL_API_TOKEN = 'dev-internal-token-change-me';
    process.env.NODE_ENV = 'production';
    expect(internalAuthGuard(reqWith('dev-internal-token-change-me'))?.status).toBe(403);
  });
});

describe('LLM 流式防腐层与规整器（Stream Normalizer）', () => {
  it('smart extractor 优先级：delta > text > content > reasoning', () => {
    // 1. delta 存在时优先
    const res1 = normalizeStreamPart({
      type: 'text-delta',
      delta: 'from_delta',
      text: 'from_text',
      content: 'from_content',
    });
    expect(res1).toMatchObject({
      kind: 'content',
      text: 'from_delta',
      rawType: 'text-delta',
    });

    // 2. text 次优先
    const res2 = normalizeStreamPart({
      type: 'text-delta',
      text: 'from_text',
      content: 'from_content',
    });
    expect(res2).toMatchObject({
      kind: 'content',
      text: 'from_text',
    });

    // 3. content 再次优先
    const res3 = normalizeStreamPart({
      type: 'text',
      content: 'from_content',
    });
    expect(res3).toMatchObject({
      kind: 'content',
      text: 'from_content',
    });

    // 4. reasoning 属性
    const res4 = normalizeStreamPart({
      type: 'reasoning-delta',
      reasoning: 'from_reasoning',
    });
    expect(res4).toMatchObject({
      kind: 'reasoning',
      text: 'from_reasoning',
    });
  });

  it('启发式自愈：reasoning 类型遇到非标准 key 自动提取唯一非空 string 并发告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = normalizeStreamPart({
        type: 'reasoning-delta',
        id: 'msg-1',
        thought_process: 'pondering something deep',
      });
      expect(res).toMatchObject({
        kind: 'reasoning',
        text: 'pondering something deep',
        rawType: 'reasoning-delta',
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[llm-stream] Shape drift self-healed: type=reasoning-delta recovered_from_key=thought_process')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('未知类型与缺少文本：正确分类并保留 keys 元数据', () => {
    // 缺少文本 payload
    const emptyReasoning = normalizeStreamPart({ type: 'reasoning-delta', id: '123' });
    expect(emptyReasoning.kind).toBe('reasoning');
    expect(emptyReasoning.text).toBeUndefined();
    expect(emptyReasoning.keys).toEqual(['type', 'id']);

    // 未知 part 类型
    const unknownPart = normalizeStreamPart({ type: 'some_exotic_part', val: 42 });
    expect(unknownPart.kind).toBe('unknown');
    expect(unknownPart.rawType).toBe('some_exotic_part');
    expect(unknownPart.keys).toEqual(['type', 'val']);

    // 非 object 或 null 输入
    expect(normalizeStreamPart(null)).toMatchObject({ kind: 'unknown', rawType: '', keys: [] });
    expect(normalizeStreamPart('str')).toMatchObject({ kind: 'unknown', rawType: '', keys: [] });
    expect(normalizeStreamPart([1, 2])).toMatchObject({ kind: 'unknown', rawType: '', keys: [] });
  });

  it('生命周期边界事件防误判：text-start/end 与 reasoning-start/end 归类为 other，不误判为 delta', () => {
    // text-start / text-end
    const textStart = normalizeStreamPart({ type: 'text-start', id: 'txt-1' });
    expect(textStart.kind).toBe('other');
    expect(textStart.text).toBeUndefined();

    const textEnd = normalizeStreamPart({ type: 'text-end', id: 'txt-1' });
    expect(textEnd.kind).toBe('other');
    expect(textEnd.text).toBeUndefined();

    // reasoning-start / reasoning-end / reasoning-file
    const reasoningStart = normalizeStreamPart({ type: 'reasoning-start', id: 'r-1' });
    expect(reasoningStart.kind).toBe('other');
    expect(reasoningStart.text).toBeUndefined();

    const reasoningEnd = normalizeStreamPart({ type: 'reasoning-end', id: 'r-1' });
    expect(reasoningEnd.kind).toBe('other');
    expect(reasoningEnd.text).toBeUndefined();

    const reasoningFile = normalizeStreamPart({ type: 'reasoning-file', id: 'f-1' });
    expect(reasoningFile.kind).toBe('other');
  });

  it('启发式自愈排除元数据字段：忽略 role/model/status 等协议头，准确提取思维链内容', () => {
    const res = normalizeStreamPart({
      type: 'reasoning-delta',
      id: 'msg-99',
      role: 'assistant',
      model: 'deepseek-reasoner',
      thought_process: 'precise logic steps',
    });
    expect(res.kind).toBe('reasoning');
    expect(res.text).toBe('precise logic steps');
  });
});

describe('LLM 网关流式账本、首帧自爆与调用追踪', () => {
  it('首帧自爆：reasoning 或 content 缺失文本载荷时在第 1 帧报错并指认 actual_keys，且不刷屏', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    async function* emptyPayloadStream() {
      yield { type: 'reasoning-delta', id: 'frame-1' }; // 缺文本
      yield { type: 'reasoning-delta', id: 'frame-2' }; // 依然缺文本，不应二次报警刷屏
      yield { type: 'text-delta', text: 'normal text' };
    }

    const deps = {
      streamFn: async () => ({
        fullStream: emptyPayloadStream(),
        finishReason: 'stop',
      }),
      pingIntervalMs: 0,
    };

    try {
      const stream = runLlmGatewayStream(
        { purpose: 'doc_transcribe_enhance_localize', variables: {} },
        deps
      );
      await readNdjsonEvents(stream);

      // 验证第 1 帧报错命中且仅报 1 次（不刷屏）
      const driftCalls = errSpy.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('STREAM_SHAPE_DRIFT')
      );
      expect(driftCalls).toHaveLength(1);
      expect(driftCalls[0][0]).toContain('STREAM_SHAPE_DRIFT: reasoning-delta missing text payload on frame 1! actual_keys=');
      expect(driftCalls[0][0]).toContain('id');
    } finally {
      errSpy.mockRestore();
    }
  });

  // warnSpy 精确计数（toHaveBeenCalledTimes(1)）：无可用测试库时上游异步
  // PromptRegistry 兜底 warn 会串入本用例窗口，故仅在显式注入测试库时执行
  it.skipIf(!HAS_TEST_DB)('未知类型告警：第 1 次出现未知 part.type 时输出 warning 与 keys', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    async function* unknownTypeStream() {
      yield { type: 'alien_event', foo: 'bar' };
      yield { type: 'alien_event', foo: 'baz' }; // 第二次不应重复刷屏
      yield { type: 'text-delta', text: 'ok' };
    }

    const deps = {
      streamFn: async () => ({
        fullStream: unknownTypeStream(),
        finishReason: 'stop',
      }),
      pingIntervalMs: 0,
    };

    try {
      const stream = runLlmGatewayStream(
        { purpose: 'doc_transcribe_enhance_localize', variables: {} },
        deps
      );
      await readNdjsonEvents(stream);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("STREAM_UNKNOWN_PART: unknown part.type='alien_event'")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('流结束不变量警报：收到 reasoning parts 但 events.chunk_reasoning === 0 触发 STREAM_SHAPE_MISMATCH', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    async function* droppedReasoningStream() {
      // reasoning-delta 没有有效文本（被丢弃，未发出 chunk kind: reasoning）
      yield { type: 'reasoning-delta' };
      yield { type: 'text-delta', text: 'content only' };
    }

    const deps = {
      streamFn: async () => ({
        fullStream: droppedReasoningStream(),
        finishReason: 'stop',
      }),
      pingIntervalMs: 0,
    };

    try {
      const stream = runLlmGatewayStream(
        { purpose: 'doc_transcribe_enhance_localize', variables: {} },
        deps
      );
      await readNdjsonEvents(stream);

      // STREAM_SHAPE_DRIFT 报一次 + STREAM_SHAPE_MISMATCH 报一次
      const mismatchCalls = errSpy.mock.calls.filter((c) =>
        c[0].includes('STREAM_SHAPE_MISMATCH')
      );
      expect(mismatchCalls.length).toBe(1);
      expect(mismatchCalls[0][0]).toContain('reasoning parts received (1) but 0 chunk_reasoning events emitted!');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('账本 Summary 输出与 callId 透传：流收尾时打印单行 ledger', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    async function* simpleStream() {
      yield { type: 'reasoning-delta', delta: 'think' };
      yield { type: 'text-delta', text: 'res' };
    }

    const deps = {
      streamFn: async () => ({
        fullStream: simpleStream(),
        finishReason: 'stop',
      }),
      pingIntervalMs: 0,
      callId: 'call-ledger-999',
    };

    try {
      const stream = runLlmGatewayStream(
        { purpose: 'doc_transcribe_enhance_localize', variables: {} },
        deps
      );
      await readNdjsonEvents(stream);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[llm-stream\] call=call-ledger-999 purpose=doc_transcribe_enhance_localize outcome=success parts=\{text:1,reasoning:1,other:0,unknown:0\} events=\{chunk_content:1,chunk_reasoning:1,ping:0\} ttfb_ms=\d+ total_ms=\d+/
        )
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('按需深潜追踪：环境变量 LLM_STREAM_TRACE 开启时输出 [llm-stream-trace]', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const origTrace = process.env.LLM_STREAM_TRACE;
    process.env.LLM_STREAM_TRACE = '*';

    async function* traceStream() {
      yield { type: 'text-delta', text: 'trace-chunk' };
    }

    const deps = {
      streamFn: async () => ({
        fullStream: traceStream(),
        finishReason: 'stop',
      }),
      pingIntervalMs: 0,
      callId: 'trace-call-1',
    };

    try {
      const stream = runLlmGatewayStream(
        { purpose: 'doc_transcribe_enhance_localize', variables: {} },
        deps
      );
      await readNdjsonEvents(stream);

      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('[llm-stream-trace] call=trace-call-1 purpose=doc_transcribe_enhance_localize event=chunk kind=content')
      );
    } finally {
      process.env.LLM_STREAM_TRACE = origTrace;
      debugSpy.mockRestore();
    }
  });

  it('HTTP 端点 Header 透传：POST /api/internal/llm/generate 保持并回写 x-llm-call-id', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    process.env.NODE_ENV = 'test';

    // 1. 指定 x-llm-call-id
    const customIdReq = new NextRequest('http://localhost/api/internal/llm/generate', {
      method: 'POST',
      headers: {
        'x-internal-token': 'test-token',
        'x-stream-mode': '1',
        'x-llm-call-id': 'custom-wire-id-123',
      },
      body: JSON.stringify({
        purpose: 'doc_transcribe_enhance_localize',
        variables: {},
      }),
    });
    const resp1 = await llmGenerateRoute(customIdReq);
    expect(resp1.headers.get('x-llm-call-id')).toBe('custom-wire-id-123');
    if (resp1.body) {
      await readNdjsonEvents(resp1.body as ReadableStream<Uint8Array>);
    }

    // 2. 未指定 x-llm-call-id 时自动生成 8 字符短 ID
    const autoIdReq = new NextRequest('http://localhost/api/internal/llm/generate', {
      method: 'POST',
      headers: {
        'x-internal-token': 'test-token',
        'x-stream-mode': '1',
      },
      body: JSON.stringify({
        purpose: 'doc_transcribe_enhance_localize',
        variables: {},
      }),
    });
    const resp2 = await llmGenerateRoute(autoIdReq);
    const generatedId = resp2.headers.get('x-llm-call-id');
    expect(generatedId).toBeTruthy();
    expect(generatedId?.length).toBe(8);
    if (resp2.body) {
      await readNdjsonEvents(resp2.body as ReadableStream<Uint8Array>);
    }
  });

  it('真实 Vercel AI SDK 流式标准：text-start/end 不触发 STREAM_SHAPE_DRIFT 且正确记入 other', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    async function* sdkStream() {
      yield { type: 'text-start', id: 'txt-0' };
      yield { type: 'text-delta', text: 'SDK generated content' };
      yield { type: 'text-end', id: 'txt-0' };
    }

    const deps = {
      streamFn: async () => ({
        fullStream: sdkStream(),
        finishReason: 'stop',
      }),
      pingIntervalMs: 0,
      callId: 'sdk-stream-test',
    };

    try {
      const stream = runLlmGatewayStream(
        { purpose: 'doc_transcribe_enhance_localize', variables: {} },
        deps
      );
      await readNdjsonEvents(stream);

      // 验证没有误报首帧自爆
      const driftCalls = errSpy.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('STREAM_SHAPE_DRIFT')
      );
      expect(driftCalls).toHaveLength(0);

      // 验证 ledger 中 parts 计数：text:1, other:2
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[llm-stream\] call=sdk-stream-test purpose=doc_transcribe_enhance_localize outcome=success parts=\{text:1,reasoning:0,other:2,unknown:0\} events=\{chunk_content:1,chunk_reasoning:0,ping:0\}/
        )
      );
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('空思考生命周期：reasoning-start/end 不包含增量时，不误报 STREAM_SHAPE_MISMATCH', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    async function* emptyReasoningLifecycleStream() {
      yield { type: 'reasoning-start', id: 'r-0' };
      yield { type: 'reasoning-end', id: 'r-0' };
      yield { type: 'text-delta', text: 'straight to answer' };
    }

    const deps = {
      streamFn: async () => ({
        fullStream: emptyReasoningLifecycleStream(),
        finishReason: 'stop',
      }),
      pingIntervalMs: 0,
    };

    try {
      const stream = runLlmGatewayStream(
        { purpose: 'doc_transcribe_enhance_localize', variables: {} },
        deps
      );
      await readNdjsonEvents(stream);

      // 不应误报流结束不变量异常
      const mismatchCalls = errSpy.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('STREAM_SHAPE_MISMATCH')
      );
      expect(mismatchCalls).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('LLM 网关用户级并发协调器与前台保留槽 (Phase 2 & Phase 3)', () => {
  it('🧪 [TC-GATEWAY-RESERVATION] 2 个后台转录任务持续占用批处理池时，高优大纲任务能立即获取保留槽执行', async () => {
    const { ConcurrencyCoordinator } = await import('@/lib/llm-gateway/concurrency-coordinator');
    const coordinator = new ConcurrencyCoordinator({ maxConcurrency: 3, interactiveHeadroom: 1 });

    let batch1Running = false;
    let batch2Running = false;
    let outlineExecuted = false;

    let resolveBatch1: () => void;
    let resolveBatch2: () => void;

    const pBatch1 = new Promise<void>((r) => { resolveBatch1 = r; });
    const pBatch2 = new Promise<void>((r) => { resolveBatch2 = r; });

    const depsBatch1 = {
      ...makeDeps({ text: 'batch 1' }).deps,
      coordinator,
      completeFn: async () => {
        batch1Running = true;
        await pBatch1;
        batch1Running = false;
        return { text: 'batch 1 done' };
      },
    };

    const depsBatch2 = {
      ...makeDeps({ text: 'batch 2' }).deps,
      coordinator,
      completeFn: async () => {
        batch2Running = true;
        await pBatch2;
        batch2Running = false;
        return { text: 'batch 2 done' };
      },
    };

    // 启动两个后台转录任务（doc_transcribe_enhance_localize -> priority: 'batch'）
    const t1 = runLlmGatewayGenerate(
      { purpose: 'doc_transcribe_enhance_localize', variables: {}, userId: 'user-reserve-test' },
      depsBatch1 as never,
    );
    const t2 = runLlmGatewayGenerate(
      { purpose: 'doc_transcribe_enhance_localize', variables: {}, userId: 'user-reserve-test' },
      depsBatch2 as never,
    );

    // 等待两个 batch 任务均已进入执行态（占用 2 个 batch 槽位）
    while (!batch1Running || !batch2Running) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const pool = coordinator.getPool('user-reserve-test');
    expect(pool.stats.activeBatch).toBe(2);
    expect(pool.stats.activeTotal).toBe(2);

    // 此时第 3 个 batch 任务到达，必须被阻塞进入排队
    let batch3Started = false;
    const depsBatch3 = {
      ...makeDeps({ text: 'batch 3' }).deps,
      coordinator,
      completeFn: async () => {
        batch3Started = true;
        return { text: 'batch 3 done' };
      },
    };
    const t3 = runLlmGatewayGenerate(
      { purpose: 'doc_transcribe_enhance_localize', variables: {}, userId: 'user-reserve-test' },
      depsBatch3 as never,
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(batch3Started).toBe(false);
    expect(pool.stats.batchQueueLength).toBe(1);

    // 此时前台大纲任务到达（outline_map_v1 -> priority: 'interactive'）
    // 验证其能立即获取保留槽执行，无需等待转录结束！
    const depsOutline = {
      ...makeDeps({ object: { chapters: [] } }).deps,
      coordinator,
      generateFn: async () => {
        outlineExecuted = true;
        return { object: { chapters: [] } };
      },
    };

    const outlineResult = await runLlmGatewayGenerate(
      { purpose: 'outline_map_v1', variables: { map: 'root' }, userId: 'user-reserve-test' },
      depsOutline as never,
    );

    expect(outlineExecuted).toBe(true);
    expect(outlineResult.ok).toBe(true);

    // 释放 batch 任务
    resolveBatch1!();
    resolveBatch2!();
    await Promise.all([t1, t2, t3]);
    expect(batch3Started).toBe(true);
  });

  it('🧪 [TC-GATEWAY-CHINESE-429] 捕获模型服务商中文速率限制文案，输出 code: RATE_LIMITED 与 429', async () => {
    const chineseError = new Error('您的账户已达到速率限制: Requests rate limit exceeded (并发超限)');
    const { deps } = makeDeps({ error: chineseError });

    const result = await runLlmGatewayGenerate(
      { purpose: 'code_chapter_lesson', variables: {}, userId: 'u1' },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RATE_LIMITED');
      expect(result.message).toContain('速率限制');
    }
  });

  it('🧪 [TC-GATEWAY-CHINESE-429-STREAM] 流式调用捕获中文速率限制，发出 RATE_LIMITED 错误事件', async () => {
    const chineseError = new Error('429 Too Many Requests: 请求频率超限');
    const deps = {
      streamFn: async () => {
        throw chineseError;
      },
      pingIntervalMs: 0,
    };

    const stream = runLlmGatewayStream(
      { purpose: 'doc_transcribe_enhance_localize', variables: {}, userId: 'u1' },
      deps,
    );

    const events = await readNdjsonEvents(stream);
    const errEvent = events.find((e) => e.type === 'error') as { type: 'error'; code: string; message: string };
    expect(errEvent).toBeDefined();
    expect(errEvent.code).toBe('RATE_LIMITED');
    expect(errEvent.message).toContain('429');
  });

  it('AbortSignal 在等待槽位队列中被中止时，能优雅退队并清理资源', async () => {
    const { ConcurrencyCoordinator } = await import('@/lib/llm-gateway/concurrency-coordinator');
    const coordinator = new ConcurrencyCoordinator({ maxConcurrency: 1, interactiveHeadroom: 0 });

    // 先占满唯一的槽位
    const releaseFirst = await coordinator.acquire('u1', 'interactive');

    const controller = new AbortController();
    const acquirePromise = coordinator.acquire('u1', 'interactive', { signal: controller.signal });

    controller.abort();
    await expect(acquirePromise).rejects.toThrow();

    const pool = coordinator.getPool('u1');
    expect(pool.stats.interactiveQueueLength).toBe(0);

    // 释放后池应自动清理
    releaseFirst();
    expect(coordinator.getActivePoolCount()).toBe(0);
  });

  it('AbortSignal 在申请前已中止时，不泄漏空闲 pool', async () => {
    const { ConcurrencyCoordinator } = await import('@/lib/llm-gateway/concurrency-coordinator');
    const coordinator = new ConcurrencyCoordinator();
    const controller = new AbortController();
    controller.abort();

    await expect(coordinator.acquire('user-pre-abort', 'interactive', { signal: controller.signal })).rejects.toThrow();
    expect(coordinator.getActivePoolCount()).toBe(0);
  });

  it('evictIdle 能根据空闲时长正确剔除陈旧 pool', async () => {
    const { ConcurrencyCoordinator } = await import('@/lib/llm-gateway/concurrency-coordinator');
    const coordinator = new ConcurrencyCoordinator();
    const pool = coordinator.getPool('idle-test');
    pool.lastActiveAt = Date.now() - 15 * 60 * 1000; // 15 分钟前

    expect(coordinator.getActivePoolCount()).toBe(1);
    const evicted = coordinator.evictIdle(10 * 60 * 1000);
    expect(evicted).toBe(1);
    expect(coordinator.getActivePoolCount()).toBe(0);
  });

  it('环境变量含非法值时安全回退至默认值防死锁', async () => {
    const originalEnv = process.env.LLM_USER_CONCURRENCY;
    try {
      process.env.LLM_USER_CONCURRENCY = 'invalid_number';
      const { ConcurrencyCoordinator } = await import('@/lib/llm-gateway/concurrency-coordinator');
      const coordinator = new ConcurrencyCoordinator();
      const pool = coordinator.getPool('test-fallback');
      expect(pool.maxConcurrency).toBe(3);
      expect(pool.interactiveHeadroom).toBe(1);
      expect(pool.batchLimit).toBe(2);
    } finally {
      if (originalEnv !== undefined) {
        process.env.LLM_USER_CONCURRENCY = originalEnv;
      } else {
        delete process.env.LLM_USER_CONCURRENCY;
      }
    }
  });
});




describe('purpose 级 deadline（registry.timeoutMs 网关单点强制）', () => {
  it('到期 abort 级联进 generateFn 并 fail-fast 返回超时，不再级联备选', async () => {
    vi.useFakeTimers();
    try {
      const seenSignals: Array<AbortSignal | undefined> = [];
      const deps = {
        generateFn: (async (opts: { abortSignal?: AbortSignal }) => {
          seenSignals.push(opts.abortSignal);
          // 模拟 provider 流挂死：连接活着但零增量，仅 abort 能终止
          return new Promise((_, reject) => {
            opts.abortSignal?.addEventListener('abort', () => {
              const err = new Error('This operation was aborted');
              err.name = 'AbortError';
              reject(err);
            }, { once: true });
          });
        }) as never,
      };
      const resultPromise = runLlmGatewayGenerate(
        { purpose: 'diagram_architecture_macro_v1', variables: { nodes: [], edges: [], rawMermaid: 'graph TD; a-->b' } },
        deps,
      );
      const result = await vi.advanceTimersByTimeAsync(3000).then(() => resultPromise);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('GENERATION_FAILED');
      expect(result.message).toContain('timed out after 3000ms');
      // abort 级联契约：到期信号必须传导进 AI SDK 漏斗（弃赛且掐线）
      expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
      expect(seenSignals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('无 timeoutMs 的 purpose 不注入额外 abortSignal（既有行为不变）', async () => {
    const { deps, generateCalls } = makeDeps({ object: { edges: [] } });
    const result = await runLlmGatewayGenerate({ purpose: 'mcp_concept_edges', variables: {} }, deps);
    expect(result.ok).toBe(true);
    expect((generateCalls[0] as { abortSignal?: AbortSignal }).abortSignal).toBeUndefined();
  });
});

describe('structured purpose 流式直出（outline 交互路径：活性透传 + 终局 zod 闸门）', () => {
  it('🧪 [TC-GATEWAY-STREAM-STRUCTURED] chunk 增量透传 + done 携带 validated object 与 text 双承载', async () => {
    const deps = {
      streamFn: async () => ({
        fullStream: (async function* () {
          yield { type: 'text-delta', textDelta: '{"chapters":[' };
          yield { type: 'text-delta', textDelta: '{"name":"第 1 章：LoRA 核心","summary":"低秩适配","files":["src/peft/tuners/lora.py"],"phase":"入门"}' };
          yield { type: 'text-delta', textDelta: ']}' };
        })(),
        finishReason: Promise.resolve('stop'),
        usage: Promise.resolve({ totalTokens: 42 }),
      }),
      pingIntervalMs: 0,
    };

    const stream = runLlmGatewayStream(
      { purpose: 'outline_map_v1', variables: { map: 'repo: t | files: 3', targetLanguage: 'zh-CN', skipMetaCompiler: true }, userId: 'u1' },
      deps,
    );

    const events = await readNdjsonEvents(stream);
    // 增量透传：消费方可据此做活性判定与截止抢救
    const contentChunks = events.filter((e) => e.type === 'chunk' && e.kind !== 'reasoning');
    expect(contentChunks.length).toBeGreaterThanOrEqual(3);
    // 终局闸门：done 携带 zod 校验后的 object；text 同步承载序列化产物（Go 侧消费契约）
    const done = events.find((e) => e.type === 'done') as unknown as {
      object?: { chapters?: Array<{ name?: string; files?: string[] }> };
      text?: string;
    };
    expect(done).toBeDefined();
    expect(done.object?.chapters).toHaveLength(1);
    expect(done.object?.chapters?.[0]?.name).toBe('第 1 章：LoRA 核心');
    expect(JSON.parse(done.text ?? '').chapters[0].files[0]).toBe('src/peft/tuners/lora.py');
  });

  it('🧪 [TC-GATEWAY-STREAM-STRUCTURED-INVALID] 流式产物无合法 JSON：error 事件 fail-fast，绝不发 done', async () => {
    const deps = {
      streamFn: async () => ({
        fullStream: (async function* () {
          yield { type: 'text-delta', textDelta: '思考结束，直接输出了散文，没有 JSON 对象' };
        })(),
        finishReason: Promise.resolve('stop'),
        usage: Promise.resolve({ totalTokens: 5 }),
      }),
      pingIntervalMs: 0,
    };

    const stream = runLlmGatewayStream(
      { purpose: 'outline_map_v1', variables: { map: 'repo: t', targetLanguage: 'zh-CN', skipMetaCompiler: true }, userId: 'u1' },
      deps,
    );

    const events = await readNdjsonEvents(stream);
    expect(events.find((e) => e.type === 'done')).toBeUndefined();
    const errEvent = events.find((e) => e.type === 'error') as unknown as { code?: string; message?: string };
    expect(errEvent).toBeDefined();
    expect(errEvent.code).toBe('GENERATION_FAILED');
    expect(errEvent.message).toContain('no complete JSON object');
  });

  it('🧪 [TC-GATEWAY-STREAM-OUTLINE-PLAN-MODULE-HEALING] outline_plan_v1 流式输出中同模块后续章节省略 moduleTitle 时自动自愈前向继承并通过闸门校验', async () => {
    const deps = {
      streamFn: async () => ({
        fullStream: (async function* () {
          yield {
            type: 'text-delta',
            textDelta: JSON.stringify({
              curriculumMode: 'matrix',
              chapters: [
                {
                  moduleTitle: '模块 1: 架构全景与环境准备',
                  name: '第 1 章: 仓库全景与起步',
                  summary: '环境准备',
                  targetPaths: ['README.md'],
                  phase: '入门',
                },
                {
                  // 模型在此省略了 moduleTitle！
                  name: '第 2 章: 核心源码分层与运行入口',
                  summary: '核心源码分层',
                  targetPaths: ['src'],
                  phase: '入门',
                },
                {
                  moduleTitle: '模块 2: 核心引擎与扩展开发',
                  name: '第 3 章: 智能体引擎核心剖析',
                  summary: '核心引擎状态调度',
                  targetPaths: ['packages/core'],
                  phase: '进阶',
                },
                {
                  // 模型在此再次省略了 moduleTitle！
                  name: '第 4 章: 通道集成与消息路由',
                  summary: '通道与路由',
                  targetPaths: ['packages/channels'],
                  phase: '进阶',
                },
              ],
            }),
          };
        })(),
        finishReason: Promise.resolve('stop'),
        usage: Promise.resolve({ totalTokens: 80 }),
      }),
      pingIntervalMs: 0,
    };

    const stream = runLlmGatewayStream(
      {
        purpose: 'outline_plan_v1',
        variables: { skeleton: 'root/\n  core/', targetLanguage: 'zh-CN', skipMetaCompiler: true },
        userId: 'u1',
      },
      deps,
    );

    const events = await readNdjsonEvents(stream);
    const done = events.find((e) => e.type === 'done') as unknown as {
      object?: { chapters?: Array<{ name?: string; moduleTitle?: string }> };
      text?: string;
    };

    expect(done).toBeDefined();
    expect(done.object?.chapters).toHaveLength(4);
    // 验证 Chapter 1 自动继承 Module 1
    expect(done.object?.chapters?.[1]?.moduleTitle).toBe('模块 1: 架构全景与环境准备');
    // 验证 Chapter 3 自动继承 Module 2
    expect(done.object?.chapters?.[3]?.moduleTitle).toBe('模块 2: 核心引擎与扩展开发');
  });

  it('🧪 [TC-GATEWAY-STREAM-TRUNCATED-JSON-SELF-HEALING] 流式输出遭遇 Token 截断（未闭合 JSON）时，0ms 快速自愈并通过闸门', async () => {
    const deps = {
      streamFn: async () => ({
        fullStream: (async function* () {
          // 模拟因 token 上限未闭合的 JSON（缺少 ] 和 }）
          yield {
            type: 'text-delta',
            textDelta: '```json\n{"chapters":[{"name":"第 1 章：自愈测试","files":["src/index.ts"]',
          };
        })(),
        finishReason: Promise.resolve('length'),
        usage: Promise.resolve({ totalTokens: 100 }),
      }),
      pingIntervalMs: 0,
    };

    const stream = runLlmGatewayStream(
      {
        purpose: 'outline_map_v1',
        variables: { map: 'repo: t', targetLanguage: 'zh-CN', skipMetaCompiler: true },
        userId: 'u1',
      },
      deps,
    );

    const events = await readNdjsonEvents(stream);
    const done = events.find((e) => e.type === 'done') as unknown as {
      ok?: boolean;
      object?: { chapters?: Array<{ name?: string; files?: string[] }> };
    };
    expect(done).toBeDefined();
    expect(done?.ok).toBe(true);
    expect(done?.object?.chapters?.[0]?.name).toBe('第 1 章：自愈测试');
  });

  it('🧪 [TC-GATEWAY-STREAM-CASCADE-RESET] Candidate 1 流式吐出残缺内容失败后，发送 reset 事件并级联至 Candidate 2 成功完成', async () => {
    let callCount = 0;
    const candidates = [
      { provider: 'zhipu' as const, modelId: 'glm-5.3-flash' },
      { provider: 'qwen' as const, modelId: 'qwen3.8-max' },
    ];

    const deps = {
      cascadeCandidates: candidates,
      streamFn: async (options: { provider?: string; modelId?: string }) => {
        callCount++;
        if (options.provider === 'zhipu') {
          return {
            fullStream: (async function* () {
              yield { type: 'text-delta', textDelta: '思考中... 突然截断的非合法散文文本' };
            })(),
            finishReason: Promise.resolve('stop'),
            usage: Promise.resolve({ totalTokens: 20 }),
          };
        }
        return {
          fullStream: (async function* () {
            yield {
              type: 'text-delta',
              textDelta: JSON.stringify({
                chapters: [
                  { name: '第 1 章：级联成功', files: ['src/core.ts'] }
                ],
              }),
            };
          })(),
          finishReason: Promise.resolve('stop'),
          usage: Promise.resolve({ totalTokens: 50 }),
        };
      },
      pingIntervalMs: 0,
    };

    const stream = runLlmGatewayStream(
      {
        purpose: 'outline_map_v1',
        variables: { map: 'repo: t', targetLanguage: 'zh-CN', skipMetaCompiler: true },
        userId: 'u1',
      },
      deps,
    );

    const events = await readNdjsonEvents(stream);

    // 验证调用了两次（候选 1 失败后级联到候选 2）
    expect(callCount).toBe(2);

    // 验证发出了一次 reset 事件
    const resetEvent = events.find((e) => e.type === 'reset');
    expect(resetEvent).toBeDefined();
    expect((resetEvent as { reason?: string }).reason).toBe('cascade');

    // 验证事件发生顺序：chunk (候选1) -> reset -> chunk (候选2) -> done
    const eventTypes = events.map((e) => e.type);
    const firstChunkIdx = eventTypes.indexOf('chunk');
    const resetIdx = eventTypes.indexOf('reset');
    const doneIdx = eventTypes.indexOf('done');

    expect(firstChunkIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(firstChunkIdx);
    expect(doneIdx).toBeGreaterThan(resetIdx);

    // 验证终局 done 带有合法校验后的数据
    const done = events.find((e) => e.type === 'done') as unknown as {
      ok?: boolean;
      object?: { chapters?: Array<{ name?: string }> };
    };
    expect(done?.ok).toBe(true);
    expect(done?.object?.chapters?.[0]?.name).toBe('第 1 章：级联成功');
  });
});
