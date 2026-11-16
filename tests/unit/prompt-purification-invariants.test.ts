import { describe, expect, it } from 'vitest';
import { ALL_PROMPT_PRESETS, PEDAGOGY_FRONTMATTER_ENVELOPE_INSTRUCTION } from '@/lib/prompt-presets';
import { PromptRegistry } from '@/lib/prompt-registry';
import { lookupLlmPurpose } from '@/lib/llm-gateway/registry';

// checkDrift 走真实 prisma.systemPrompt.findMany（连接串读 DATABASE_URL）。
// 门控沿用 go-sidecar job 同款惯例：仅认显式注入的 WORKER_TEST_DATABASE_URL
// （未注入时该用例自动 skip）——不直接认 DATABASE_URL，因其会被 ai.ts 顶部的
// dotenv.config(override) 从本地 .env 静默注入（本机凭据未必可用，门形同虚设）。
// 其余用例均为纯 preset/schema 断言，无条件执行。
const HAS_TEST_DB = Boolean(process.env.WORKER_TEST_DATABASE_URL);

describe('系统级提示词净化与死锁消除不变式门禁 (Prompt Purification & Constraint Liberation Invariants)', () => {
  // 1/2（scout_structurizer / curriculum_synthesizer 净化用例）已随两僵尸 preset
  // 退役删除（2026-11 死代码清算：运行时零调用方，Go 单写者承接）

  // 3. PEDAGOGY_FRONTMATTER_ENVELOPE_INSTRUCTION 放宽概念与要点区间
  it('PEDAGOGY_FRONTMATTER_ENVELOPE_INSTRUCTION: 放宽 concepts (1-6) 与 takeaways (1-4) 阶梯区间', () => {
    expect(PEDAGOGY_FRONTMATTER_ENVELOPE_INSTRUCTION).toContain(
      '- concepts: An array of 1 to 6 (focused micro-lessons: 1-2 core atomic concepts, comprehensive chapters: 3-6) core technical concepts.'
    );
    expect(PEDAGOGY_FRONTMATTER_ENVELOPE_INSTRUCTION).not.toContain(
      '- concepts: An array of 2 to 6'
    );
    expect(PEDAGOGY_FRONTMATTER_ENVELOPE_INSTRUCTION).toContain(
      '- takeaways: (Optional) Array of 1 to 4 (focused lessons: 1-2, comprehensive modules: 3-4) key takeaways.'
    );
    expect(PEDAGOGY_FRONTMATTER_ENVELOPE_INSTRUCTION).not.toContain(
      'Array of 2-4 key takeaways'
    );
  });

  // 4. chapter_pedagogy_compiler (Rule 200) 弹性认知弧线
  it('chapter_pedagogy_compiler: 认知弧线放宽至 2-5 阶梯（原子工具允许 2 步）', () => {
    const preset = ALL_PROMPT_PRESETS.find((p) => p.key === 'chapter_pedagogy_compiler');
    expect(preset).toBeDefined();
    const rules = (preset?.promptSchema as any)?.rules as string[];
    expect(rules).toBeDefined();

    const arcRule = rules.find((r) => r.includes('pedagogical arc'));
    expect(arcRule).toBeDefined();
    expect(arcRule).toContain('Design a focused pedagogical arc (typically 2 to 5 monotonic steps, tailored to chapter complexity: 2 steps for focused atomic utilities, 3 to 4 for core algorithms, up to 5 for multi-stage subsystems)');
    expect(arcRule).not.toContain('Design a 3 to 5 step pedagogical arc');

    // 验证 LLM 网关 Schema Triad 闭环对齐：网关契约同步放宽至 2~5 步
    const compilerPurpose = lookupLlmPurpose('chapter_pedagogy_compiler');
    expect(compilerPurpose).toBeDefined();
    expect(compilerPurpose?.schema).toBeDefined();
    const schema = compilerPurpose!.schema as any;
    const baseBrief = {
      persona: '应用数学与深度学习计算图架构师',
      mentalModel: '有向无环计算图与拓扑倒序链式求导累加',
      mermaidStrategy: { diagramType: 'flowchart', focus: '聚焦核心机制' },
      learnerTrap: '防踩坑点',
      narrativeGuidelines: '严谨深刻',
    };
    expect(schema.safeParse({ ...baseBrief, pedagogicalArc: ['第 1 步：直觉建立', '第 2 步：机制剖析'] }).success).toBe(true);
    expect(schema.safeParse({ ...baseBrief, pedagogicalArc: ['仅有 1 步'] }).success).toBe(false);
  });

  // 5. chapter_map_builder (Rule 631) 主锚点文件语义解耦
  it('chapter_map_builder: 主文件由刚性唯一 doc 调整为 designated primary study anchor', () => {
    const preset = ALL_PROMPT_PRESETS.find((p) => p.key === 'chapter_map_builder');
    expect(preset).toBeDefined();
    const rules = (preset?.promptSchema as any)?.rules as string[];
    expect(rules).toBeDefined();

    const mainPathRule = rules.find((r) => r.includes('mainPath'));
    expect(mainPathRule).toBeDefined();
    expect(mainPathRule).toContain('Each chapter has a designated mainPath: the primary study anchor for that chapter');
    expect(mainPathRule).toContain('attach companion files via assetPaths');
    expect(mainPathRule).not.toContain('Each chapter has exactly ONE mainPath: the file a reader studies for that chapter (a document file).');
  });

  // 6. pedagogy_rewrite (Rule 175) 图表直觉协议豁免 trivial/FAQ 章节
  it('pedagogy_rewrite: Diagram Intuition Protocol 增加纯配置/清单/FAQ 章节豁免条款', () => {
    const preset = ALL_PROMPT_PRESETS.find((p) => p.key === 'pedagogy_rewrite');
    expect(preset).toBeDefined();
    const rules = (preset?.promptSchema as any)?.rules as string[];
    expect(rules).toBeDefined();

    const diagramRule = rules.find((r) => r.includes('DIAGRAM INTUITION PROTOCOL'));
    expect(diagramRule).toBeDefined();
    expect(diagramRule).toContain('For architectural, dataflow, or mechanical chapters, include at least one Mermaid diagram');
    expect(diagramRule).toContain('HOWEVER, for pure configuration checklists, installation command lists, or brief FAQ/disclaimers where visual abstraction is trivial or counterproductive, DO NOT generate forced trivial diagrams');
    expect(diagramRule).toContain('Reserve visual diagrams for bridging mental models and complex dataflows.');
  });

  // 7. outline_plan_v1 (Line 724) 模块划分自然子系统边界
  it('outline_plan_v1: moduleTitle Schema 描述更新为根据顶层子系统自然边界划分模块', () => {
    const purpose = lookupLlmPurpose('outline_plan_v1');
    expect(purpose).toBeDefined();
    expect(purpose?.kind).toBe('structured');

    const schemaObj = purpose?.schema as any;
    expect(schemaObj).toBeDefined();

    const moduleTitleDesc = schemaObj.shape.chapters.element.shape.moduleTitle.description;
    expect(moduleTitleDesc).toContain('根据顶层子系统的自然边界进行模块划分（小型系统通常 2~3 个模块，大型/多包系统通常 3~6 个模块，同一模块可包含多个连续章节）');
    expect(moduleTitleDesc).not.toContain('全书规划 2~4 个模块');
  });

  // 9. outline_curriculum_compiler: 微内核硬核约束与三大物理定律
  it('outline_curriculum_compiler: 注入微内核硬核约束（锁死 1~2 章，三大物理定律，严禁拆分成 3 章及以上）', () => {
    const preset = ALL_PROMPT_PRESETS.find((p) => p.key === 'outline_curriculum_compiler');
    expect(preset).toBeDefined();
    const rules = (preset?.promptSchema as any)?.rules as string[];
    expect(rules).toBeDefined();

    const microRule = rules.find((r) => r.includes('MICRO-KERNEL & THREE PHYSICAL LAWS'));
    expect(microRule).toBeDefined();
    expect(microRule).toContain('pedagogicalPattern as either dual_kernel_app (strictly 2 chapters: kernel + application/training) or single_masterclass (strictly 1 chapter)');
    expect(microRule).toContain('sum of targetChaptersEstimate strictly <= 2. It is STRICTLY FORBIDDEN to assign 3 or more phases/chapters');
    expect(microRule).toContain('ATOMIC COHESION LAW');
    expect(microRule).toContain('PROPORTIONAL PREAMBLE LAW');

    // 验证 Few-shot Hint 不再将 engine.py 错误地拆成 2 个阶段，而是展示完整的 2 阶段微内核 + 应用实战
    const hint = preset?.promptSchema?.outputSchemaHint as any;
    expect(hint).toBeDefined();
    expect(hint.cognitivePhases).toHaveLength(2);
    expect(hint.cognitivePhases[0].phaseName).toBe('标量自动微分微内核');
    expect(hint.cognitivePhases[1].phaseName).toBe('极简神经网络分层封装与训练');
    expect(hint.compilerInstruction).toContain('严禁生成 3 章及以上');
  });

  // 10. PromptRegistry 预设漂移检测与门禁内化
  it.skipIf(!HAS_TEST_DB)('PromptRegistry: checkDrift 内化方法返回所有预设并区分状态', async () => {
    const report = await PromptRegistry.checkDrift();
    expect(report.rows).toHaveLength(ALL_PROMPT_PRESETS.length);
    expect(Array.isArray(report.orphanKeys)).toBe(true);
    for (const row of report.rows) {
      expect(['OK', 'DRIFTED', 'MISSING']).toContain(row.state);
      expect(typeof row.key).toBe('string');
    }
  });
});

