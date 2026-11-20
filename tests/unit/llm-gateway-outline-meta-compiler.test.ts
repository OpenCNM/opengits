vi.mock('@/lib/analytics/token-usage', () => ({
  TokenUsageService: {
    logSDKResult: vi.fn().mockResolvedValue(undefined),
    logUsage: vi.fn().mockResolvedValue(undefined),
  },
  tokenUsageService: {
    logSDKResult: vi.fn().mockResolvedValue(undefined),
    logUsage: vi.fn().mockResolvedValue(undefined),
  },
}));

import { describe, it, expect, vi } from 'vitest';
import {
  runLlmGatewayGenerate,
  type LlmGatewayDeps,
} from '@/lib/llm-gateway/service';
import {
  lookupLlmPurpose,
  curriculumBlueprintSchema,
  formatCurriculumBlueprint,
  type CurriculumBlueprint,
} from '@/lib/llm-gateway/registry';

const validCurriculumBlueprint: CurriculumBlueprint = {
  curriculumThesis: '从计算图构建到拓扑反向传播，第一性原理贯穿微内核自动微分引擎实现',
  repoArchetype: 'micro_kernel',
  contentScopeDirective: {
    canonicalScope: 'micrograd',
    ignoredScopes: ['setup.py', 'test'],
  },
  pedagogicalPattern: 'dual_kernel_app',
  learnerProfile: {
    archetype: 'deep_dive_internals',
    targetOutcome: '彻底掌握 Value 标量拓扑图、梯度累加机制与链式求导的闭包设计',
  },
  cognitivePhases: [
    { phaseName: '概念起源与极简标量图', coreFocus: '剖析纯标量计算瓶颈与有向无环计算图拓扑建模', targetChaptersEstimate: 1 },
    { phaseName: '核心微内核与运算重载', coreFocus: 'Value 数据结构、加乘重载与局部求导梯度闭包', targetChaptersEstimate: 2 },
    { phaseName: '拓扑排序与反向驱动', coreFocus: '逆拓扑排序与梯度防覆盖累加机制', targetChaptersEstimate: 1 },
    { phaseName: '神经网络抽象与实战', coreFocus: 'Neuron、Layer 与 MLP 的面向对象封装与模型拟合', targetChaptersEstimate: 2 },
  ],
  pruningDirectives: {
    spotlightModules: ['micrograd/engine.py', 'micrograd/nn.py'],
    prunedModules: ['setup.py', 'test/test_engine.py'],
  },
  anchorDirectives: [
    { symbolPath: 'micrograd/engine.py#Value', pedagogicalRole: '核心计算图节点数据结构' },
    { symbolPath: 'micrograd/engine.py#Value.backward', pedagogicalRole: '逆拓扑排序与自动反向传播引擎' },
  ],
  compilerInstruction: '严格遵循 4 阶段认知进阶，每章必须结合指定符号锚点展开，禁止将引擎代码粗暴折叠为单章。',
};

const sampleOutlineMapResult = {
  chapters: [
    {
      name: '第 1 章：标量运算的局限与微分图心智模型',
      summary: '揭示为什么传统标量无法自动推导反向传播，构建有向无环图的基本构想',
      files: ['micrograd/engine.py#Value'],
      phase: '入门',
    },
    {
      name: '第 2 章：Value 数据结构与双向图连接',
      summary: '实现 Value 基础节点及其 _prev 拓扑依赖',
      files: ['micrograd/engine.py#Value'],
      phase: '进阶',
    },
    {
      name: '第 3 章：加乘重载与反向闭包求导',
      summary: '深入实现加法和乘法的局部梯度求导闭包',
      files: ['micrograd/engine.py#Value.backward'],
      phase: '进阶',
    },
    {
      name: '第 4 章：逆拓扑排序与全图梯度传播',
      summary: '通过逆拓扑排序驱动全图梯度反向传播',
      files: ['micrograd/engine.py#Value.backward'],
      phase: '进阶',
    },
    {
      name: '第 5 章：神经元与多层感知机抽象',
      summary: '在微内核之上封装 Neuron 与 MLP 并实战拟合',
      files: ['micrograd/nn.py'],
      phase: '实战',
    },
  ],
};

const sampleOutlinePlanResult = {
  curriculumMode: 'single' as const,
  chapters: [
    {
      moduleTitle: '模块 1: 架构全景与环境准备',
      name: '第 1 章：微内核自动微分拓扑全貌',
      summary: '全景解析计算图拓扑设计理念',
      targetPaths: ['micrograd'],
      phase: '入门',
      drillDown: false,
    },
    {
      moduleTitle: '模块 2: 核心计算图与反向传播',
      name: '第 2 章：Value 节点与局部链式求导',
      summary: '剖析核心引擎与梯度累加',
      targetPaths: ['micrograd/engine.py'],
      phase: '进阶',
      drillDown: true,
    },
  ],
};

describe('大纲导师级重编排元编译器网关管线 (Outline Curriculum Meta-Compiler Pipeline)', () => {
  it('purpose 注册验证：outline_curriculum_compiler、outline_map_v1 与 outline_plan_v1 契约完备', () => {
    const compilerPurpose = lookupLlmPurpose('outline_curriculum_compiler');
    expect(compilerPurpose).toBeDefined();
    expect(compilerPurpose?.kind).toBe('structured');
    expect(compilerPurpose?.source).toBe('indexer');
    expect(compilerPurpose?.keyOrigin).toBe('user');
    expect(compilerPurpose?.priority).toBe('interactive');
    expect(compilerPurpose?.disableThinking).toBe(true);
    expect(compilerPurpose?.temperature).toBe(0.2);

    const outlinePurpose = lookupLlmPurpose('outline_map_v1');
    expect(outlinePurpose).toBeDefined();
    expect(outlinePurpose?.metaCompiler).toBeDefined();
    expect(outlinePurpose?.metaCompiler?.metaPurpose).toBe('outline_curriculum_compiler');
    expect(outlinePurpose?.metaCompiler?.timeoutMs).toBe(6000);

    const planPurpose = lookupLlmPurpose('outline_plan_v1');
    expect(planPurpose).toBeDefined();
    expect(planPurpose?.metaCompiler).toBeDefined();
    expect(planPurpose?.metaCompiler?.metaPurpose).toBe('outline_curriculum_compiler');
    expect(planPurpose?.metaCompiler?.timeoutMs).toBe(6000);

    const validParsed = curriculumBlueprintSchema.safeParse(validCurriculumBlueprint);
    expect(validParsed.success).toBe(true);

    // 缺少必填字段（如 curriculumThesis）
    const missingThesis = curriculumBlueprintSchema.safeParse({
      ...validCurriculumBlueprint,
      curriculumThesis: undefined,
    });
    expect(missingThesis.success).toBe(false);

    // 认知阶段少于 1 个（空数组非法）
    const emptyPhases = curriculumBlueprintSchema.safeParse({
      ...validCurriculumBlueprint,
      cognitivePhases: [],
    });
    expect(emptyPhases.success).toBe(false);

    // 单阶段合规（micro-repo / single_masterclass 场景放行）
    const singlePhase = curriculumBlueprintSchema.safeParse({
      ...validCurriculumBlueprint,
      pedagogicalPattern: 'single_masterclass',
      cognitivePhases: [{ phaseName: '单阶段大师课', coreFocus: '单重点', targetChaptersEstimate: 1 }],
    });
    expect(singlePhase.success).toBe(true);

    // 非法学习者画像
    const invalidLearner = curriculumBlueprintSchema.safeParse({
      ...validCurriculumBlueprint,
      learnerProfile: {
        archetype: 'invalid_archetype',
        targetOutcome: 'outcome',
      },
    });
    expect(invalidLearner.success).toBe(false);

    // 非法 repoArchetype
    const invalidArchetype = curriculumBlueprintSchema.safeParse({
      ...validCurriculumBlueprint,
      repoArchetype: 'unknown_archetype',
    });
    expect(invalidArchetype.success).toBe(false);

    // 非法 pedagogicalPattern
    const invalidPattern = curriculumBlueprintSchema.safeParse({
      ...validCurriculumBlueprint,
      pedagogicalPattern: 'invalid_pattern',
    });
    expect(invalidPattern.success).toBe(false);

    // 穷举测试 6 种合法的 repoArchetype 枚举
    const validArchetypes = [
      'micro_kernel',
      'i18n_tutorial_mirror',
      'embedded_challenge',
      'doc_driven_book',
      'monorepo_matrix',
      'standard_system',
    ] as const;
    for (const archetype of validArchetypes) {
      const res = curriculumBlueprintSchema.safeParse({
        ...validCurriculumBlueprint,
        repoArchetype: archetype,
      });
      expect(res.success).toBe(true);
    }

    // 穷举测试 5 种合法的 pedagogicalPattern 枚举
    const validPatterns = [
      'single_masterclass',
      'dual_kernel_app',
      'author_curated_mirror',
      'progressive_system',
      'matrix_course_tree',
    ] as const;
    for (const pattern of validPatterns) {
      const res = curriculumBlueprintSchema.safeParse({
        ...validCurriculumBlueprint,
        pedagogicalPattern: pattern,
      });
      expect(res.success).toBe(true);
    }

    // 认知阶段上限边界：5 个通过，6 个拦截
    const fivePhases = curriculumBlueprintSchema.safeParse({
      ...validCurriculumBlueprint,
      cognitivePhases: Array.from({ length: 5 }, (_, i) => ({
        phaseName: `阶段 ${i + 1}`,
        coreFocus: `焦点 ${i + 1}`,
        targetChaptersEstimate: 1,
      })),
    });
    expect(fivePhases.success).toBe(true);

    const sixPhases = curriculumBlueprintSchema.safeParse({
      ...validCurriculumBlueprint,
      cognitivePhases: Array.from({ length: 6 }, (_, i) => ({
        phaseName: `阶段 ${i + 1}`,
        coreFocus: `焦点 ${i + 1}`,
        targetChaptersEstimate: 1,
      })),
    });
    expect(sixPhases.success).toBe(false);
  });

  it('formatCurriculumBlueprint 纯函数序列化完备性与格式验证', () => {
    const formatted = formatCurriculumBlueprint(validCurriculumBlueprint);
    expect(formatted).toContain('[AI CURRICULUM ARCHITECTURE BLUEPRINT & PEDAGOGICAL DESIGN]');
    expect(formatted).toContain('- Curriculum Thesis: 从计算图构建到拓扑反向传播');
    expect(formatted).toContain('- Repository Archetype: micro_kernel');
    expect(formatted).toContain('- Pedagogical Pattern: dual_kernel_app');
    expect(formatted).toContain('- Learner Archetype: deep_dive_internals');
    expect(formatted).toContain('- Content Scope Directive:');
    expect(formatted).toContain('- 标准主干范围: micrograd');
    expect(formatted).toContain('- 忽略/剪枝范围: setup.py, test');
    expect(formatted).toContain('1. [概念起源与极简标量图] (预估 1 章): 剖析纯标量计算瓶颈');
    expect(formatted).toContain('- 重点精读/聚焦: micrograd/engine.py');
    expect(formatted).toContain('- 坚决剪枝/过滤: setup.py');
    expect(formatted).toContain('关键符号锚点: `micrograd/engine.py#Value`');

    // 无 anchorDirectives 与 prunedModules 场景
    const minimalFormatted = formatCurriculumBlueprint({
      ...validCurriculumBlueprint,
      anchorDirectives: undefined,
      contentScopeDirective: {
        canonicalScope: 'src',
        ignoredScopes: [],
      },
      pruningDirectives: {
        spotlightModules: ['src/core'],
        prunedModules: [],
      },
    });
    expect(minimalFormatted).toContain('- 忽略/剪枝范围: (无)');
    expect(minimalFormatted).toContain('- 无特定剪枝目录');
    expect(minimalFormatted).not.toContain('Micro-Repo / Fine-Grained Anchors');
  });

  it('outline_map_v1 compile 验证：提示词自适应放行 1~2 章，并注入 Phase 1 蓝图', async () => {
    const purpose = lookupLlmPurpose('outline_map_v1');
    expect(purpose).toBeDefined();

    const compiledPrompt = await purpose!.compile({
      map: 'Layer 0: index.ts\nLayer 1: engine.ts',
      targetLanguage: 'zh-CN',
      curriculumBlueprintSection: formatCurriculumBlueprint(validCurriculumBlueprint),
    });

    expect(compiledPrompt).toContain('5-10 章（简单模式 3-6 章，困难模式 10-14 章）');
    expect(compiledPrompt).toContain('single_masterclass 时，规划为 1 个高度凝聚的大师课深度专章');
    expect(compiledPrompt).toContain('dual_kernel_app 时规划为 2 章');
    expect(compiledPrompt).toContain('author_curated_mirror 时严格对齐原作者目录脉络');
    expect(compiledPrompt).toContain('三大物理定律');
    expect(compiledPrompt).toContain('强内聚原子闭包律 (Atomic Cohesion)');
    expect(compiledPrompt).toContain('认知物理密度守恒律 (Cognitive Density)');
    expect(compiledPrompt).toContain('前言体积等比律 (Proportional Preamble)');
    expect(compiledPrompt).toContain('严禁为 micro_kernel 输出 3 章及以上');
    expect(compiledPrompt).toContain('[AI CURRICULUM ARCHITECTURE BLUEPRINT & PEDAGOGICAL DESIGN]');
    expect(compiledPrompt).toContain('- Repository Archetype: micro_kernel');
    expect(compiledPrompt).toContain('- Pedagogical Pattern: dual_kernel_app');
    expect(compiledPrompt).not.toContain('严禁折叠为 1~2 章');
  });

  it('🧪 [TC-OUTLINE-META-SUCCESS] 标准两阶段执行：Stage 1 提炼大纲认知蓝图并成功注入 Stage 2 主 Prompt', async () => {
    const generateCalls: unknown[] = [];

    const deps: LlmGatewayDeps = {
      cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
      generateFn: (async (opts: unknown) => {
        generateCalls.push(opts);
        const callOpts = opts as { schema?: unknown };
        // 区分 Stage 1 与 Stage 2
        if (generateCalls.length === 1) {
          // Stage 1: outline_curriculum_compiler
          return {
            object: validCurriculumBlueprint,
            usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
            mode: 'json_schema' as const,
            finishReason: 'stop',
          };
        }
        // Stage 2: outline_map_v1
        return {
          object: sampleOutlineMapResult,
          usage: { promptTokens: 500, completionTokens: 250, totalTokens: 750 },
          mode: 'json_schema' as const,
          finishReason: 'stop',
        };
      }) as never,
    };

    const result = await runLlmGatewayGenerate(
      {
        purpose: 'outline_map_v1',
        variables: {
          map: 'Layer 0: micrograd/engine.py [hot=15]\nLayer 1: micrograd/nn.py [hot=8]',
          customPrompt: '希望重点理解自动求导',
          targetLanguage: 'zh-CN',
          pacing: 'normal',
          teachingDepth: 'deep',
          learnerArchetype: 'deep_dive_internals',
        },
        userId: 'user-outline-meta-test',
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.object).toEqual(sampleOutlineMapResult);
      // 两阶段 Token 账本合并: 300 + 750 = 1050
      expect(result.usage).toEqual({
        promptTokens: 700,
        completionTokens: 350,
        totalTokens: 1050,
      });
    }

    // 验证 Stage 1 调用参数
    expect(generateCalls).toHaveLength(2);
    const stage1Call = generateCalls[0] as Record<string, unknown>;
    expect(stage1Call.source).toBe('indexer');
    expect(stage1Call.disableThinking).toBe(true);
    expect(String(stage1Call.prompt)).toContain('deep_dive_internals');
    expect(String(stage1Call.prompt)).toContain('希望重点理解自动求导');

    // 验证 Stage 2 调用参数中包含 Stage 1 注入的导师级架构蓝图
    const stage2Call = generateCalls[1] as Record<string, unknown>;
    const finalPrompt = String(stage2Call.prompt);
    expect(finalPrompt).toContain('[AI CURRICULUM ARCHITECTURE BLUEPRINT & PEDAGOGICAL DESIGN]');
    expect(finalPrompt).toContain('从计算图构建到拓扑反向传播');
    expect(finalPrompt).toContain('Learner Archetype: deep_dive_internals');
    expect(finalPrompt).toContain('概念起源与极简标量图');
    expect(finalPrompt).toContain('重点精读/聚焦: micrograd/engine.py');
    expect(finalPrompt).toContain('坚决剪枝/过滤: setup.py');
    expect(finalPrompt).toContain('微型库符号锚点');
  });

  it('🧪 [TC-OUTLINE-META-TIMEOUT-SAFE] Fail-Safe 容灾回退：Stage 1 超时 6s 自动截断，平滑降级单阶段生成', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const generateCalls: unknown[] = [];

    const origPurpose = lookupLlmPurpose('outline_map_v1')!;
    const origTimeout = origPurpose.metaCompiler!.timeoutMs;
    origPurpose.metaCompiler!.timeoutMs = 50; // 50ms 快速超时

    const deps: LlmGatewayDeps = {
      cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
      generateFn: (async (opts: unknown) => {
        generateCalls.push(opts);
        if (generateCalls.length === 1) {
          // 模拟 Stage 1 挂起 200ms
          await new Promise((r) => setTimeout(r, 200));
          return { object: validCurriculumBlueprint, usage: { totalTokens: 10 } };
        }
        // Stage 2 降级执行
        return {
          object: sampleOutlineMapResult,
          usage: { promptTokens: 300, completionTokens: 150, totalTokens: 450 },
          mode: 'json_schema' as const,
          finishReason: 'stop',
        };
      }) as never,
    };

    try {
      const result = await runLlmGatewayGenerate(
        {
          purpose: 'outline_map_v1',
          variables: {
            map: 'Layer 0: engine.py\nLayer 1: nn.py',
            targetLanguage: 'zh-CN',
          },
          userId: 'user-outline-timeout-test',
        },
        deps,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.object).toEqual(sampleOutlineMapResult);
      }

      // Stage 2 正常被调用，提示词中不含蓝图块
      expect(generateCalls.length).toBeGreaterThanOrEqual(2);
      const stage2Call = generateCalls[1] as Record<string, unknown>;
      const prompt = String(stage2Call.prompt);
      expect(prompt).not.toContain('[AI CURRICULUM ARCHITECTURE BLUEPRINT & PEDAGOGICAL DESIGN]');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[llm-gateway] Meta-compiler exception/timeout, falling back to brief=null:'),
        expect.anything(),
      );
    } finally {
      origPurpose.metaCompiler!.timeoutMs = origTimeout;
      warnSpy.mockRestore();
    }
  });

  it('🧪 [TC-OUTLINE-META-SCHEMA-DRIFT] Fail-Safe 容灾回退：Stage 1 输出畸变 Schema 校验失败，平滑降级', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const generateCalls: unknown[] = [];

    const deps: LlmGatewayDeps = {
      cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
      generateFn: (async (opts: unknown) => {
        generateCalls.push(opts);
        if (generateCalls.length === 1) {
          // 畸变返回：缺少必填字段
          return {
            object: { malformedBlueprint: 'invalid structure' },
            usage: { totalTokens: 80 },
            mode: 'json_schema' as const,
            finishReason: 'stop',
          };
        }
        return {
          object: sampleOutlineMapResult,
          usage: { promptTokens: 300, completionTokens: 150, totalTokens: 450 },
          mode: 'json_schema' as const,
          finishReason: 'stop',
        };
      }) as never,
    };

    try {
      const result = await runLlmGatewayGenerate(
        {
          purpose: 'outline_map_v1',
          variables: {
            map: 'Layer 0: engine.py',
            targetLanguage: 'zh-CN',
          },
          userId: 'user-outline-schema-drift-test',
        },
        deps,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.object).toEqual(sampleOutlineMapResult);
      }

      // Stage 2 提示词中不含蓝图块
      expect(generateCalls).toHaveLength(2);
      const stage2Call = generateCalls[1] as Record<string, unknown>;
      const prompt = String(stage2Call.prompt);
      expect(prompt).not.toContain('[AI CURRICULUM ARCHITECTURE BLUEPRINT & PEDAGOGICAL DESIGN]');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[llm-gateway] Meta-compiler schema validation failed, falling back:'),
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('🧪 [TC-OUTLINE-MICRO-REPO-ANCHORS] 微型库细粒度符号锚点场景验证', async () => {
    const generateCalls: unknown[] = [];

    const microRepoBlueprint: CurriculumBlueprint = {
      ...validCurriculumBlueprint,
      anchorDirectives: [
        { symbolPath: 'micrograd/engine.py#Value', pedagogicalRole: '计算图核心节点数据结构' },
        { symbolPath: 'micrograd/engine.py#Value.backward', pedagogicalRole: '自动反向传播拓扑引擎' },
        { symbolPath: 'micrograd/nn.py#Neuron', pedagogicalRole: '神经元权重偏置仿射变换' },
      ],
    };

    const deps: LlmGatewayDeps = {
      cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
      generateFn: (async (opts: unknown) => {
        generateCalls.push(opts);
        if (generateCalls.length === 1) {
          return {
            object: microRepoBlueprint,
            usage: { totalTokens: 200 },
            mode: 'json_schema' as const,
            finishReason: 'stop',
          };
        }
        return {
          object: sampleOutlineMapResult,
          usage: { totalTokens: 500 },
          mode: 'json_schema' as const,
          finishReason: 'stop',
        };
      }) as never,
    };

    const result = await runLlmGatewayGenerate(
      {
        purpose: 'outline_map_v1',
        variables: {
          map: '(micro-repo mode: fine-grained anchors enabled)\nLayer 0: micrograd/engine.py#Value\nLayer 1: micrograd/engine.py#Value.backward',
          targetLanguage: 'zh-CN',
          teachingDepth: 'deep',
        },
        userId: 'user-micro-repo-test',
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(generateCalls).toHaveLength(2);
    const stage2Call = generateCalls[1] as Record<string, unknown>;
    const prompt = String(stage2Call.prompt);
    expect(prompt).toContain('micrograd/engine.py#Value');
    expect(prompt).toContain('micrograd/engine.py#Value.backward');
    expect(prompt).toContain('micrograd/nn.py#Neuron');
  });

  it('🧪 [TC-OUTLINE-META-ARCHETYPE] 4 种学习者认知画像参数透传验证', async () => {
    const archetypes: Array<CurriculumBlueprint['learnerProfile']['archetype']> = [
      'architecture_overview',
      'deep_dive_internals',
      'cross_language_migrant',
      'pedagogical_beginner',
    ];

    for (const archetype of archetypes) {
      const generateCalls: unknown[] = [];
      const deps: LlmGatewayDeps = {
        cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
        generateFn: (async (opts: unknown) => {
          generateCalls.push(opts);
          if (generateCalls.length === 1) {
            return {
              object: {
                ...validCurriculumBlueprint,
                learnerProfile: {
                  archetype,
                  targetOutcome: `Target outcome for ${archetype}`,
                },
              },
              usage: { totalTokens: 100 },
              mode: 'json_schema' as const,
              finishReason: 'stop',
            };
          }
          return {
            object: sampleOutlineMapResult,
            usage: { totalTokens: 200 },
            mode: 'json_schema' as const,
            finishReason: 'stop',
          };
        }) as never,
      };

      const result = await runLlmGatewayGenerate(
        {
          purpose: 'outline_map_v1',
          variables: {
            map: 'Layer 0: core.go',
            learnerArchetype: archetype,
            targetLanguage: 'zh-CN',
          },
          userId: 'user-archetype-test',
        },
        deps,
      );

      expect(result.ok).toBe(true);
      expect(generateCalls).toHaveLength(2);
      const stage1Call = generateCalls[0] as Record<string, unknown>;
      expect(String(stage1Call.prompt)).toContain(archetype);

      const stage2Call = generateCalls[1] as Record<string, unknown>;
      expect(String(stage2Call.prompt)).toContain(`Learner Archetype: ${archetype}`);
    }
  });

  it('🧪 [TC-OUTLINE-META-SHOULD-COMPILE] shouldCompile 条件跳过验证', async () => {
    const generateCalls: unknown[] = [];
    const deps: LlmGatewayDeps = {
      cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
      generateFn: (async (opts: unknown) => {
        generateCalls.push(opts);
        return {
          object: sampleOutlineMapResult,
          usage: { totalTokens: 300 },
          mode: 'json_schema' as const,
          finishReason: 'stop',
        };
      }) as never,
    };

    // 1. skipMetaCompiler 为 true 时直接跳过 Phase 1
    await runLlmGatewayGenerate(
      {
        purpose: 'outline_map_v1',
        variables: {
          map: 'Layer 0: main.go',
          skipMetaCompiler: true,
        },
        userId: 'user-skip-test',
      },
      deps,
    );
    expect(generateCalls).toHaveLength(1);

    // 2. curriculumBlueprintSection 已存在时直接跳过 Phase 1
    generateCalls.length = 0;
    await runLlmGatewayGenerate(
      {
        purpose: 'outline_map_v1',
        variables: {
          map: 'Layer 0: main.go',
          curriculumBlueprintSection: '[AI CURRICULUM ARCHITECTURE BLUEPRINT & PEDAGOGICAL DESIGN]\nCustom blueprint',
        },
        userId: 'user-already-compiled-test',
      },
      deps,
    );
    expect(generateCalls).toHaveLength(1);
    const call = generateCalls[0] as Record<string, unknown>;
    expect(String(call.prompt)).toContain('Custom blueprint');
  });

  it('🧪 [TC-OUTLINE-PLAN-META-SUCCESS] 巨仓分区大纲两阶段元编译：outline_plan_v1 从 skeleton 编译蓝图并注入 Stage 2', async () => {
    const generateCalls: unknown[] = [];

    const deps: LlmGatewayDeps = {
      cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
      generateFn: (async (opts: unknown) => {
        generateCalls.push(opts);
        if (generateCalls.length === 1) {
          // Stage 1: outline_curriculum_compiler
          return {
            object: validCurriculumBlueprint,
            usage: { promptTokens: 300, completionTokens: 120, totalTokens: 420 },
            mode: 'json_schema' as const,
            finishReason: 'stop',
          };
        }
        // Stage 2: outline_plan_v1
        return {
          object: sampleOutlinePlanResult,
          usage: { promptTokens: 600, completionTokens: 200, totalTokens: 800 },
          mode: 'json_schema' as const,
          finishReason: 'stop',
        };
      }) as never,
    };

    const result = await runLlmGatewayGenerate(
      {
        purpose: 'outline_plan_v1',
        variables: {
          skeleton: '├── micrograd (files: 2, loc: 250, hot: 10)\n└── test (files: 1, loc: 50, hot: 1)',
          customPrompt: '希望速通整体架构',
          targetLanguage: 'zh-CN',
          pacing: 'compact',
          teachingDepth: 'overview',
          learnerArchetype: 'architecture_overview',
        },
        userId: 'user-outline-plan-test',
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.object).toEqual(sampleOutlinePlanResult);
      // 两阶段 Token 账本合并: 420 + 800 = 1220
      expect(result.usage).toEqual({
        promptTokens: 900,
        completionTokens: 320,
        totalTokens: 1220,
      });
    }

    expect(generateCalls).toHaveLength(2);
    // Stage 1 调用验证
    const stage1Call = generateCalls[0] as Record<string, unknown>;
    expect(stage1Call.source).toBe('indexer');
    expect(stage1Call.disableThinking).toBe(true);
    expect(String(stage1Call.prompt)).toContain('├── micrograd (files: 2, loc: 250, hot: 10)');
    expect(String(stage1Call.prompt)).toContain('architecture_overview');
    expect(String(stage1Call.prompt)).toContain('希望速通整体架构');

    // Stage 2 调用验证：包含蓝图与硬性遵从规则
    const stage2Call = generateCalls[1] as Record<string, unknown>;
    const finalPrompt = String(stage2Call.prompt);
    expect(finalPrompt).toContain('=== 导师级课程架构蓝图 (Curriculum Blueprint) ===');
    expect(finalPrompt).toContain('[AI CURRICULUM ARCHITECTURE BLUEPRINT & PEDAGOGICAL DESIGN]');
    expect(finalPrompt).toContain('导师级蓝图遵从（CRITICAL）');
    expect(finalPrompt).toContain('从计算图构建到拓扑反向传播');
  });

  it('🧪 [TC-OUTLINE-PLAN-TIMEOUT-SAFE] outline_plan_v1 Fail-Safe 容灾回退：Stage 1 超时平滑降级单阶段执行', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const generateCalls: unknown[] = [];

    const origPurpose = lookupLlmPurpose('outline_plan_v1')!;
    const origTimeout = origPurpose.metaCompiler!.timeoutMs;
    origPurpose.metaCompiler!.timeoutMs = 50;

    const deps: LlmGatewayDeps = {
      cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
      generateFn: (async (opts: unknown) => {
        generateCalls.push(opts);
        if (generateCalls.length === 1) {
          await new Promise((r) => setTimeout(r, 200));
          return { object: validCurriculumBlueprint, usage: { totalTokens: 10 } };
        }
        return {
          object: sampleOutlinePlanResult,
          usage: { promptTokens: 300, completionTokens: 150, totalTokens: 450 },
          mode: 'json_schema' as const,
          finishReason: 'stop',
        };
      }) as never,
    };

    try {
      const result = await runLlmGatewayGenerate(
        {
          purpose: 'outline_plan_v1',
          variables: {
            skeleton: '├── main (files: 10)',
            targetLanguage: 'zh-CN',
          },
          userId: 'user-outline-plan-timeout',
        },
        deps,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.object).toEqual(sampleOutlinePlanResult);
      }
      expect(generateCalls.length).toBeGreaterThanOrEqual(2);
      const stage2Call = generateCalls[1] as Record<string, unknown>;
      const prompt = String(stage2Call.prompt);
      expect(prompt).not.toContain('=== 导师级课程架构蓝图 (Curriculum Blueprint) ===');
    } finally {
      origPurpose.metaCompiler!.timeoutMs = origTimeout;
      warnSpy.mockRestore();
    }
  });
});
