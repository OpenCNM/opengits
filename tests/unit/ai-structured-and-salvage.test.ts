import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { fastSalvageJson, salvageOrRepairStructured } from '@/lib/ai/salvage-structured';
import { generateStructured } from '@/lib/ai';
import { getModelThinkingCapability, buildThinkingProviderOptions, normalizeModelId } from '@/lib/llm-gateway/thinking-adapter';
import { AGENT_DEFAULTS, DEFAULT_EXPLAIN_DEPTH } from '@/lib/constants';
import { extractStreamableAssistantText } from '@/lib/ai/unwrap-chat-response';
import { buildExplainDepthDirective, normalizeExplainDepth, stripLegacyResponseJsonInstruction } from '@/lib/ai/response-depth';
import { assembleEnrichedMermaid, type MacroTopology, type DiagramLlmOutput } from '@/lib/mermaid/macro-topology-assembler';
import { lookupLlmPurpose } from '@/lib/llm-gateway/registry';

describe('salvage-structured & ai-structured', () => {
  const sampleQuizSchema = z.object({
    quizzes: z
      .array(
        z.object({
          question: z.string(),
          options: z.array(z.string()).length(4),
          correctIndex: z.number().min(0).max(3),
          explanation: z.string(),
        })
      )
      .min(1),
  });

  function makeFakeModel(script: Array<{ throwMsg?: string; text?: string }>) {
    let calls = 0;
    const prompts: string[] = [];
    const model: any = {
      specificationVersion: 'v4',
      provider: 'test-fake',
      modelId: 'fake',
      doGenerate: async (opts: any) => {
        const promptParts = Array.isArray(opts?.prompt)
          ? opts.prompt.map((msg: any) =>
              Array.isArray(msg?.content)
                ? msg.content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('')
                : typeof msg?.content === 'string'
                  ? msg.content
                  : ''
            )
          : [String(opts?.prompt ?? '')];
        prompts.push(promptParts.join('\n'));
        const step = script[Math.min(calls, script.length - 1)];
        calls++;
        if (step.throwMsg) throw new Error(step.throwMsg);
        return {
          content: [{ type: 'text', text: step.text }],
          text: step.text,
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, noCache: 1 },
            totalTokens: { total: 2 },
          },
          finishReason: { unified: 'stop' },
          response: { id: 'fake-response', modelId: 'fake', timestamp: new Date() },
          warnings: [],
          rawCallResponse: {},
        };
      },
    };
    return { model, calls: () => calls, prompts: () => prompts };
  }

  it('fastSalvageJson 覆盖标准 JSON / <think> / 围栏 / 尾逗号 / 截断闭合 / 顶层数组 / 1-based 校正', () => {
    const q = '"question": "什么是 AST？","options": ["抽象语法树", "自动测试脚本", "异步传输协议", "应用状态树"],"correctIndex": 0,"explanation": "AST 是抽象语法树。"';
    const cases: Array<[string, string, number]> = [
      ['标准 JSON', `{"quizzes":[{${q}}]}`, 0],
      ['<think> 包裹', `<think>\n思考...\n</think>\n{"quizzes":[{${q}}]}`, 0],
      ['```json 围栏', `\`\`\`json\n{"quizzes":[{${q}}]}\n\`\`\``, 0],
      ['尾随逗号', `{"quizzes":[{${q},},],}`, 0],
      ['截断补齐闭合', `{"quizzes":[{${q}`, 0],
      ['顶层数组', `[{${q}}]`, 0],
      ['1-based index 校正', `{"quizzes":[{"question":"Q","options":["A","B","C","D"],"correctIndex":4,"explanation":"D"}]}`, 3],
    ];
    for (const [label, raw, expectedIdx] of cases) {
      const res = fastSalvageJson(raw, sampleQuizSchema);
      expect(res, label).not.toBeNull();
      expect(res!.quizzes[0].correctIndex, label).toBe(expectedIdx);
    }
  });

  it('salvageOrRepairStructured 快路径 / LLM 慢修复 / 垃圾输入 Fail-Closed', async () => {
    const fast = await salvageOrRepairStructured(
      '```json\n{"quizzes":[{"question":"Q","options":["1","2","3","4"],"correctIndex":0,"explanation":"E"}]}\n```',
      sampleQuizSchema
    );
    expect(fast?.tier).toBe('fast_salvage');

    const broken = '{"quizzes": [{"question": "Q"with broken quote, "options": ["1","2","3","4"], "correctIndex": 0, "explanation": "E"}]}';
    const repaired = await salvageOrRepairStructured(broken, sampleQuizSchema, {
      model: makeFakeModel([{ text: '{"quizzes":[{"question":"Q with repaired quote","options":["1","2","3","4"],"correctIndex":0,"explanation":"E"}]}' }]).model,
    });
    expect(repaired?.tier).toBe('llm_repair');
    expect(repaired?.data.quizzes[0].question).toBe('Q with repaired quote');

    const failed = await salvageOrRepairStructured('彻底无法解析的胡言乱语', sampleQuizSchema, {
      model: makeFakeModel([{ text: '仍然是胡言乱语' }]).model,
    });
    expect(failed).toBeNull();
  });

  it('generateStructured 降级 json_mode + 探测缓存 + ZodError 重试 + 非格式错误上抛', async () => {
    const t1 = makeFakeModel([{ throwMsg: 'This response_format type is unavailable now' }, { text: '{"ok": true}' }]);
    const r1 = await generateStructured({ provider: 'fake-provider-a', modelId: 'fake-model', model: t1.model, schema: z.object({ ok: z.boolean() }), prompt: '测试' });
    expect([r1.mode, r1.object.ok, t1.calls()]).toEqual(['json_mode', true, 2]);

    const t2 = makeFakeModel([{ text: '{"ok": true}' }]);
    const r2 = await generateStructured({ provider: 'fake-provider-a', model: t2.model, schema: z.object({ ok: z.boolean() }), prompt: '测试' });
    expect([r2.mode, t2.calls()]).toEqual(['json_mode', 1]);

    const t3 = makeFakeModel([{ throwMsg: 'This response_format type is unavailable now' }, { text: '{}' }, { text: '{"ok": true}' }]);
    const r3 = await generateStructured({ provider: 'fake-provider-b', model: t3.model, schema: z.object({ ok: z.boolean() }), prompt: '测试' });
    expect([r3.mode, r3.object.ok, t3.calls()]).toEqual(['json_mode', true, 3]);

    const t4 = makeFakeModel([{ throwMsg: 'Timeout after 30s' }]);
    await expect(
      generateStructured({ provider: 'fake-provider-c', model: t4.model, schema: z.object({ ok: z.boolean() }), prompt: '测试' })
    ).rejects.toThrow(/Timeout/);

    const t5 = makeFakeModel([{ text: '{"ok": true}' }]);
    const r5 = await generateStructured({ provider: 'fake-provider-d', model: t5.model, schema: z.object({ ok: z.boolean() }), prompt: '测试' });
    expect(r5.mode).toBe('json_schema');
  });

  it('generateStructured json_mode 通过 Zod v4 z.toJSONSchema 与 io=input 注入结构提示', async () => {
    const t1 = makeFakeModel([{ throwMsg: 'This response_format type is unavailable now' }, { text: '{"summary": "core pipeline", "count": 2}' }]);
    const r1 = await generateStructured({
      provider: 'fake-provider-json-schema-hint',
      modelId: 'fake-model',
      model: t1.model,
      schema: z.object({ summary: z.string(), count: z.number() }),
      prompt: '概括章节结构',
    });
    expect(r1.mode).toBe('json_mode');
    expect(t1.prompts()[1]).toContain('输出 JSON 必须严格符合以下结构');
    expect(t1.prompts()[1]).toContain('"summary"');

    const t2 = makeFakeModel([{ text: '{"tag": "  scheduler  "}' }]);
    const r2 = await generateStructured({
      provider: 'fake-provider-json-schema-hint',
      modelId: 'fake-model',
      model: t2.model,
      schema: z.object({ tag: z.string().transform((s) => s.trim()) }),
      prompt: '提取标签',
    });
    expect(r2.object.tag).toBe('scheduler');
    expect(t2.calls()).toBe(1);
    expect(t2.prompts()[0]).toContain('"tag"');
  });
});

describe('thinking-adapter', () => {
  it('normalizeModelId & getModelThinkingCapability 分类与多厂商混合模型识别', () => {
    expect(normalizeModelId('deepseek-ai/deepseek-r1')).toBe('deepseek-r1');
    expect(normalizeModelId('OpenAI/O3-Mini')).toBe('o3-mini');
    expect(normalizeModelId('anthropic/claude-3.7-sonnet:thinking')).toBe('claude-3.7-sonnet');
    expect(normalizeModelId(undefined)).toBe('');

    for (const [m, p] of [
      ['glm-5.3-flash', 'zhipu'],
      ['deepseek-reasoner', 'deepseek'],
      ['deepseek-ai/deepseek-r1', 'siliconflow'],
      ['deepseek-r1-distill-qwen-32b', 'dashscope'],
      ['o1', 'openai'],
      ['o3-mini', 'openai'],
      ['qwq-32b', 'dashscope'],
      ['qwen3-235b-a22b-thinking-2507', 'dashscope'],
      ['qwen3-next-80b-a3b-thinking', 'dashscope'],
    ]) {
      const cap = getModelThinkingCapability(m, p);
      expect([cap.type, cap.supportsDisable, cap.supportsThinking], m).toEqual(['thinking-only', false, true]);
    }

    for (const [m, p] of [
      ['claude-3-7-sonnet', 'anthropic'],
      ['gemini-2.0-flash-thinking-exp', 'google'],
      ['qwen3-thinking', 'dashscope'],
      ['qwen3.6-flash', 'dashscope'],
      ['qwen3.8-flash', 'dashscope'],
      ['qwen3.8-max', 'dashscope'],
      ['qwen3-32b', 'dashscope'],
      ['qwen-plus', 'dashscope'],
      ['qwen-plus-latest', 'dashscope'],
      ['qwen-max-latest', 'dashscope'],
    ]) {
      const cap = getModelThinkingCapability(m, p);
      expect([cap.type, cap.supportsDisable], m).toEqual(['thinking-optional', true]);
    }

    for (const [m, p] of [
      ['gpt-4o', 'openai'],
      ['deepseek-chat', 'deepseek'],
      ['deepseek-v3', 'dashscope'],
      ['qwen-turbo', 'dashscope'],
      ['qwen-max', 'dashscope'],
      ['qwen3-coder-480b', 'dashscope'],
      ['qwen3-235b-a22b-instruct', 'dashscope'],
      ['my-custom-fine-tuned-model', 'custom'],
    ]) {
      const cap = getModelThinkingCapability(m, p);
      expect([cap.type, cap.supportsThinking], m).toEqual(['non-thinking', false]);
    }
  });

  it('buildThinkingProviderOptions fast/deep/default 策略渲染', () => {
    expect(buildThinkingProviderOptions({ modelId: 'glm-5.3-flash', disableThinking: true })).toEqual({
      openai: { reasoningEffort: 'low' },
      openaiCompatible: { reasoningEffort: 'low' },
      compatible: { reasoningEffort: 'low', reasoning_effort: 'low' },
    });
    expect(buildThinkingProviderOptions({ modelId: 'claude-3-7-sonnet', provider: 'anthropic', disableThinking: true })).toEqual({
      anthropic: { thinking: { type: 'disabled' } },
    });
    for (const m of ['qwen3-thinking', 'qwen3.6-flash', 'qwen3.8-flash', 'qwen3.8-max', 'qwen-plus', 'qwen-plus-latest']) {
      expect(buildThinkingProviderOptions({ modelId: m, provider: 'dashscope', disableThinking: true }), m).toMatchObject({
        openaiCompatible: { reasoningEffort: 'none' },
        compatible: { reasoningEffort: 'none', enable_thinking: false, reasoning_effort: 'none' },
      });
    }
    expect(buildThinkingProviderOptions({ modelId: 'qwen3-32b', provider: 'siliconflow', disableThinking: true })).toEqual({
      compatible: { enable_thinking: false },
    });
    expect(buildThinkingProviderOptions({ modelId: 'qwen3-235b-a22b-thinking-2507', provider: 'dashscope', disableThinking: true })).toEqual({
      openai: { reasoningEffort: 'low' },
      openaiCompatible: { reasoningEffort: 'low' },
      compatible: { reasoningEffort: 'low', reasoning_effort: 'low' },
    });
    expect(buildThinkingProviderOptions({ modelId: 'claude-3-7-sonnet', provider: 'openrouter', disableThinking: true })).toEqual({
      anthropic: { thinking: { type: 'disabled' } },
      openai: { reasoningEffort: 'low' },
      openaiCompatible: { reasoningEffort: 'low' },
      compatible: { reasoningEffort: 'low', reasoning_effort: 'low' },
    });
    expect(buildThinkingProviderOptions({ modelId: 'gpt-4o', disableThinking: true })).toBeUndefined();
    expect(buildThinkingProviderOptions({ modelId: 'deepseek-chat', disableThinking: true })).toBeUndefined();

    expect(buildThinkingProviderOptions({ modelId: 'glm-5.3-flash', enableThinking: true })).toEqual({
      openai: { reasoningEffort: 'high' },
      openaiCompatible: { reasoningEffort: 'high' },
      compatible: { reasoningEffort: 'high', reasoning_effort: 'high' },
    });
    expect(buildThinkingProviderOptions({ modelId: 'claude-3-7-sonnet', provider: 'anthropic', enableThinking: true })).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 4000 } },
    });
    expect(buildThinkingProviderOptions({ modelId: 'qwen3-thinking', enableThinking: true })).toMatchObject({
      compatible: { enable_thinking: true, reasoning_effort: 'medium' },
    });
    expect(buildThinkingProviderOptions({ modelId: 'gpt-4o', enableThinking: true })).toBeUndefined();
    expect(buildThinkingProviderOptions({ modelId: 'glm-5.3-flash' })).toBeUndefined();
  });
});

describe('chat-response-depth', () => {
  it('extractStreamableAssistantText 透传 Markdown、解包 JSON 并安全处理流式部分转义', () => {
    const md = '## 架构结论\n\n`Module` 只约束 `parameters()` 统一入口。';
    expect(extractStreamableAssistantText(md)).toBe(md);
    expect(
      extractStreamableAssistantText('```json\n{"response": "好问题，我们看 **设计**\\n\\n## 核心原因\\n\\t1. 鸭子类型 \\"安全\\""}\n```')
    ).toBe('好问题，我们看 **设计**\n\n## 核心原因\n\t1. 鸭子类型 "安全"');
    expect(extractStreamableAssistantText('{"response": "第一行\\')).toBe('第一行');
    expect(extractStreamableAssistantText('{"response": "第一行\\n第二行\\u4e2')).toBe('第一行\n第二行');
    expect(extractStreamableAssistantText('{"response": "第一行\\n第二行\\u4e2d')).toBe('第一行\n第二行中');
  });

  it('response-depth 默认值、归一化、指令构建与旧提示清理', () => {
    expect(DEFAULT_EXPLAIN_DEPTH).toBe('simple');
    expect(AGENT_DEFAULTS.explainDepth).toBe('simple');
    expect(normalizeExplainDepth(undefined)).toBe('simple');
    expect(normalizeExplainDepth('unknown_tier')).toBe('simple');
    expect(normalizeExplainDepth('normal')).toBe('normal');
    expect(normalizeExplainDepth('detailed')).toBe('detailed');

    for (const [tier, marker] of [
      ['simple', 'SIMPLE (简单模式 - DEFAULT)'],
      ['normal', 'NORMAL (正常模式)'],
      ['detailed', 'DETAILED (详细模式)'],
    ] as const) {
      const directive = buildExplainDepthDirective(tier);
      expect(directive).toContain('ZERO INFORMATION LOSS');
      expect(directive).toContain('never wrap in JSON');
      expect(directive).toContain(marker);
    }

    const legacy = 'You are an expert AI Assistant.\n\nRULES:\n- Reply clearly.\n\nRespond strictly with a JSON object matching this schema:\n```json\n{\n  "response": "example"\n}\n```';
    expect(stripLegacyResponseJsonInstruction(legacy)).toBe('You are an expert AI Assistant.\n\nRULES:\n- Reply clearly.');
  });
});

describe('diagram-macro-gateway', () => {
  const mockPhysicalTopology: MacroTopology = {
    scope: '',
    scale: 1,
    strategy: 'directory',
    nodes: [
      { id: 'entrypoint', path: '.', name: 'Core Entrypoint', role: 'interface', fileCount: 3, loc: 400, hotness: 90 },
      { id: 'sub_engine', path: 'engine', name: 'engine', role: 'core', fileCount: 15, loc: 3200, hotness: 80 },
      { id: 'sub_store', path: 'store', name: 'store', role: 'infra', fileCount: 8, loc: 1500, hotness: 60 },
    ],
    edges: [
      { from: 'entrypoint', to: 'sub_engine', weight: 12, symbols: ['RunEngine', 'Init'] },
      { from: 'sub_engine', to: 'sub_store', weight: 8, symbols: ['Save', 'Query'] },
    ],
    rawMermaid: '```mermaid\nflowchart TD\n  entrypoint["Core Entrypoint"]\n  sub_engine["engine"]\n  sub_store["store"]\n  entrypoint --> sub_engine\n  sub_engine --> sub_store\n```',
    mermaid: '',
  };

  it('assembleEnrichedMermaid 融合物理拓扑、剔除幻觉节点并 Fail-Closed 回落 rawMermaid', () => {
    const llmOutput: DiagramLlmOutput = {
      nodes: [
        { id: 'entrypoint', title: 'CLI 控制台入口', subtitle: '命令行参数解析', layer: 'interface' },
        { id: 'sub_engine', title: '核心执行引擎', subtitle: '任务调度', layer: 'core' },
        { id: 'sub_store', title: '持久化存储底座', subtitle: '数据落地', layer: 'infra' },
      ],
      edges: [
        { from: 'entrypoint', to: 'sub_engine', label: '分发参数' },
        { from: 'sub_engine', to: 'sub_store', label: '写入结果' },
      ],
      summary: '分层架构',
    };
    const enriched = assembleEnrichedMermaid(mockPhysicalTopology, llmOutput);
    expect(enriched).toContain('CLI 控制台入口');
    expect(enriched).toContain('subgraph Core');

    const hallucinated = assembleEnrichedMermaid(mockPhysicalTopology, {
      nodes: [
        { id: 'entrypoint', title: 'CLI 入口', subtitle: '解析', layer: 'interface' },
        { id: 'phantom_cloud_service', title: '云端协同服务', subtitle: '虚假', layer: 'infra' },
      ],
      edges: [{ from: 'entrypoint', to: 'phantom_cloud_service', label: '虚假连接' }],
    });
    expect(hallucinated).not.toContain('phantom_cloud_service');
    expect(hallucinated).toContain('sub_engine -->|"calls Save, Query"| sub_store');

    expect(assembleEnrichedMermaid(mockPhysicalTopology, null)).toBe(mockPhysicalTopology.rawMermaid);
    expect(assembleEnrichedMermaid(mockPhysicalTopology, { nodes: [] })).toBe(mockPhysicalTopology.rawMermaid);
  });

  it('diagram_architecture_macro_v1 purpose schema 与 compile 行为', async () => {
    const purpose = lookupLlmPurpose('diagram_architecture_macro_v1');
    expect(purpose?.kind).toBe('structured');
    expect(
      purpose?.schema?.safeParse({
        nodes: [{ id: 'sub_a', title: '模块 A', subtitle: '说明 A', layer: 'core' }],
        edges: [{ from: 'sub_a', to: 'sub_b', label: '调用' }],
        summary: '总结',
      }).success
    ).toBe(true);

    const compiled = await purpose!.compile({
      repoName: 'test-repo',
      nodes: [{ id: 'sub_a', name: 'a', path: 'a', fileCount: 1, loc: 10 }],
      edges: [{ from: 'sub_a', to: 'sub_b', weight: 5, symbols: ['Foo'] }],
      rawMermaid: '```mermaid\n```',
      targetLanguage: 'zh-CN',
    });
    expect(compiled).toContain('test-repo');
    expect(compiled).toContain('物理节点列表 (Nodes)');
    expect(compiled).toContain('zh-CN');
  });
});
