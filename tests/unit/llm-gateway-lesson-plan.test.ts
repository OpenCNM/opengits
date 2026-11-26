import { describe, it, expect, vi, afterEach } from 'vitest';
import { asSchema } from 'ai';
import { z } from 'zod';
import { PromptRegistry } from '@/lib/prompt-registry';
import { runLlmGatewayGenerate, runLlmGatewayStream, type LlmGatewayDeps } from '@/lib/llm-gateway/service';
import {
  lookupLlmPurpose,
  parseSlotMenu,
  renderLessonPlan,
  teachingBriefSchema,
  type TeachingBrief,
} from '@/lib/llm-gateway/registry';

// ─────────────────────────────────────────────────────────────
// 带槽位教案（Lesson Plan）：规划器只给槽位 ID，句柄由 Go 侧预校验菜单确定性渲染。
// 覆盖：渲染与截断、越界/重复 ID 丢弃、schema 宽容、出席状态日志、旧模板护栏。
// ─────────────────────────────────────────────────────────────

const baseBrief: TeachingBrief = {
  persona: '会话网关与投影一致性架构师',
  mentalModel: '把事件日志当权威来源，订阅时按需重建内存投影',
  pedagogicalArc: ['痛点：重启后内存投影丢失', '机制：冷恢复按需水合', '边界：宽限期与竞态'],
  mermaidStrategy: { diagramType: 'flowchart', focus: '订阅 → 判定冷热 → 水合 → 推送' },
  learnerTrap: '把宽限期当成超时时间',
  narrativeGuidelines: '先讲读者能感知的现象，再落到代码',
};

// Go 侧 chapter.SlotMenuItem 的 JSON 形态（与 chapter.FormatSlotMenu 的文本一一对应）
const slotMenu = [
  { id: 1, fileIndex: 1, anchor: 'ensureColdReadyPublisher', aspect: 'core', startLine: 3411, endLine: 3436 },
  { id: 2, fileIndex: 2, anchor: 'State', aspect: 'contract', startLine: 10, endLine: 12 },
  { id: 3, fileIndex: 1, anchor: 'hydratePublisher', aspect: 'core', startLine: 3442, endLine: 3475 },
];
const slotMenuText = [
  '1 = [File 1#ensureColdReadyPublisher:core] (L3411-L3436)',
  '2 = [File 2#State:contract] (L10-L12)',
  '3 = [File 1#hydratePublisher:core] (L3442-L3475)',
].join('\n');

const LESSON_PLAN_HEADER = '- Lesson Plan (pre-validated evidence slots — copy these handles verbatim):';

/** 强制走代码预设基线：断言与本地库 Prompt 版本状态无关（同 llm-gateway.test.ts 先例） */
function useCodeBaseline() {
  return vi.spyOn(PromptRegistry, 'getCompiledPrompt').mockImplementation(
    async (key, vars = {}) => ({
      key,
      version: 1,
      compiledPrompt: PromptRegistry.compilePresetSync(key, vars),
      language: 'en',
    }),
  );
}

function makeDeps(object: unknown, completeCalls: Array<Record<string, unknown>>): LlmGatewayDeps {
  return {
    cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
    generateFn: (async () => ({
      object,
      usage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
      mode: 'json_schema' as const,
      finishReason: 'stop',
    })) as never,
    completeFn: (async (opts: unknown) => {
      completeCalls.push(opts as Record<string, unknown>);
      return {
        text: '## 1. 痛点\n\n正文…',
        usage: { promptTokens: 300, completionTokens: 150, totalTokens: 450 },
        finishReason: 'stop',
      };
    }) as never,
  };
}

async function runLesson(object: unknown) {
  const completeCalls: Array<Record<string, unknown>> = [];
  const result = await runLlmGatewayGenerate(
    {
      purpose: 'code_chapter_lesson',
      variables: {
        chapterIndex: 1,
        chapterTitle: '冷恢复',
        chapterDescription: '订阅时的投影重建',
        targetLanguage: 'zh',
        slotMenu,
        slotMenuText,
      },
      userId: 'user-lesson-plan-test',
    },
    makeDeps(object, completeCalls),
  );
  return { result, prompt: String((completeCalls[0] as Record<string, unknown> | undefined)?.prompt ?? '') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('带槽位教案（Lesson Plan）', () => {
  it('renderLessonPlan：按预校验菜单确定性渲染句柄，越界与重复 ID 丢弃，层标签正确', () => {
    const plan = renderLessonPlan(
      {
        ...baseBrief,
        steps: [
          { goal: '建立冷恢复的心智模型', layer: 'core', slotIds: [1, 2, 1, 99] },
          { goal: '内部状态与宽限期', layer: 'deep', slotIds: [3] },
          { goal: '没有证据的收束步骤', layer: 'core', slotIds: [] },
        ],
      },
      { slotMenu },
    );
    expect(plan).not.toBeNull();
    expect(plan?.lines).toEqual([
      LESSON_PLAN_HEADER,
      '  1. [mainline] 建立冷恢复的心智模型 — evidence: [File 1#ensureColdReadyPublisher:core], [File 2#State:contract]',
      '  2. [deep-dive] 内部状态与宽限期 — evidence: [File 1#hydratePublisher:core]',
      '  3. [mainline] 没有证据的收束步骤',
    ]);
    expect(plan?.slotCount).toBe(3);
  });

  it('renderLessonPlan：超过 5 步 / 每步 6 槽截断；无 steps 返回 null；菜单形状不合法视为空菜单', () => {
    const steps = Array.from({ length: 7 }, (_, i) => ({
      goal: `步骤 ${i + 1}`,
      layer: 'core' as const,
      slotIds: [1, 2, 3, 1, 2, 3, 1, 2],
    }));
    const plan = renderLessonPlan({ ...baseBrief, steps }, { slotMenu });
    expect(plan?.lines).toHaveLength(1 + 5);
    // 重复 ID 在单步内去重：每步只渲染菜单里实际存在的 3 个不同槽位
    expect(plan?.lines[1]).toBe('  1. [mainline] 步骤 1 — evidence: [File 1#ensureColdReadyPublisher:core], [File 2#State:contract], [File 1#hydratePublisher:core]');

    expect(renderLessonPlan({ ...baseBrief, steps: [] }, { slotMenu })).toBeNull();
    expect(renderLessonPlan(baseBrief, { slotMenu })).toBeNull();
    // 菜单缺失 / 形状不合法：教案退化为无证据，不抛错
    const noMenu = renderLessonPlan(
      { ...baseBrief, steps: [{ goal: 'g', layer: 'core', slotIds: [1] }] },
      { slotMenu: [{ id: '1', fileIndex: 1, anchor: 'x' }] },
    );
    expect(noMenu?.lines[1]).toBe('  1. [mainline] g');
  });

  it('schema：steps 略有瑕疵时整体回落为 undefined，不拖垮人设/心智模型/弧线', () => {
    for (const steps of ['oops', [{ goal: 'x', layer: 'bogus', slotIds: [] }], [{ goal: 'x', layer: 'core', slotIds: ['1'] }], null]) {
      const parsed = teachingBriefSchema.safeParse({ ...baseBrief, steps });
      expect(parsed.success, JSON.stringify(steps)).toBe(true);
      expect(parsed.success && parsed.data.steps, JSON.stringify(steps)).toBeUndefined();
    }
    const ok = teachingBriefSchema.safeParse({
      ...baseBrief,
      steps: [{ goal: '建立心智模型', layer: 'core', slotIds: [1, 4] }],
    });
    expect(ok.success).toBe(true);
    // 单步隔离：3 个合法步（含超长 goal）+ 1 个畸形步 → 保留合法步而非整锅清零
    const partial = teachingBriefSchema.safeParse({
      ...baseBrief,
      steps: [
        { goal: '步'.repeat(200), layer: 'core', slotIds: [1] },
        { goal: 'bad', layer: 'bogus', slotIds: [] },
        { goal: '深潜机制', layer: 'deep', slotIds: [2] },
      ],
    });
    expect(partial.success).toBe(true);
    const renderedPartial = partial.success ? renderLessonPlan(partial.data, { slotMenu }) : null;
    expect(renderedPartial?.slotCount).toBe(2);
    expect(renderedPartial?.lines).toHaveLength(3);
    expect(renderedPartial?.lines[1]).toContain('1. [mainline] ' + '步'.repeat(160) + ' — evidence: [File 1#ensureColdReadyPublisher:core]');
    // 旧模板输出不含 steps：同样通过（向后兼容）
    expect(teachingBriefSchema.safeParse(baseBrief).success).toBe(true);
  });

  it('🧪 [TC-LESSON-PLAN-INJECT] 规划器带 steps → 写课 Prompt 注入预校验句柄并记录 state=plan', async () => {
    const baselineSpy = useCodeBaseline();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const { result, prompt } = await runLesson({
        ...baseBrief,
        steps: [
          { goal: '建立冷恢复的心智模型', layer: 'core', slotIds: [1, 2] },
          { goal: '内部状态与宽限期', layer: 'deep', slotIds: [3, 42] },
        ],
      });
      expect(result.ok).toBe(true);
      // 既有简报区块原样保留，教案追加在其后
      expect(prompt).toContain('[AI TEACHING BRIEF & PEDAGOGICAL STRATEGY — SPECIFIC TO THIS CHAPTER]');
      expect(prompt).toContain('- Pedagogical Arc:');
      expect(prompt.indexOf(LESSON_PLAN_HEADER)).toBeGreaterThan(prompt.indexOf('- Narrative & Tone Guidelines:'));
      expect(prompt).toContain('  1. [mainline] 建立冷恢复的心智模型 — evidence: [File 1#ensureColdReadyPublisher:core], [File 2#State:contract]');
      expect(prompt).toContain('  2. [deep-dive] 内部状态与宽限期 — evidence: [File 1#hydratePublisher:core]');
      expect(prompt).not.toContain('42'); // 越界 ID 不得渲染成句柄
      // 分层契约（替换「逐个点名」类指令）进入写课 Prompt
      expect(prompt).toContain('MAINLINE NARRATIVE CONTRACT (MANDATORY)');
      expect(prompt).toContain('DEEP-DIVE BLOCK CONTRACT (MANDATORY)');
      expect(prompt).toContain('<details data-layer="deep">');
      expect(prompt).toContain('[CHAPTER SOURCE EVIDENCE');
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('[llm-gateway] Meta-compiler brief state=plan purpose=code_chapter_lesson meta=chapter_pedagogy_compiler'),
      );
    } finally {
      baselineSpy.mockRestore();
    }
  });

  it('🧪 [TC-LESSON-PLAN-ARC] 规划器未给 steps → 无教案段，退化为仅弧线并记录 state=arc', async () => {
    const baselineSpy = useCodeBaseline();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const { result, prompt } = await runLesson(baseBrief);
      expect(result.ok).toBe(true);
      expect(prompt).toContain('- Pedagogical Arc:');
      expect(prompt).not.toContain(LESSON_PLAN_HEADER);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('brief state=arc'));
    } finally {
      baselineSpy.mockRestore();
    }
  });

  it('🧪 [TC-SLOT-MENU-GUARD] 库内旧模板缺占位符时：规划器补挂槽位菜单，写课补挂整段简报（教案不静默丢失）', async () => {
    // 模拟滞后的库内模板：两个 key 都不含 {{slotMenuSection}} / {{teachingBriefSection}} 占位
    const staleSpy = vi.spyOn(PromptRegistry, 'getCompiledPrompt').mockImplementation(
      async (key, vars = {}) => ({
        key,
        version: 1,
        compiledPrompt: `STALE DB TEMPLATE (${key})\n${String(vars.filesSummary ?? '')}`,
        language: 'en',
      }),
    );
    const generateCalls: Array<Record<string, unknown>> = [];
    const completeCalls: Array<Record<string, unknown>> = [];
    const result = await runLlmGatewayGenerate(
      {
        purpose: 'code_chapter_lesson',
        variables: {
          chapterIndex: 1,
          chapterTitle: '冷恢复',
          chapterDescription: '订阅时的投影重建',
          targetLanguage: 'zh',
          filesSummary: '[File 1] src/gateway.ts (10 lines)',
          slotMenu,
          slotMenuText,
        },
        userId: 'user-stale-template-test',
      },
      {
        cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
        generateFn: (async (opts: unknown) => {
          generateCalls.push(opts as Record<string, unknown>);
          return {
            object: { ...baseBrief, steps: [{ goal: '建立冷恢复的心智模型', layer: 'core', slotIds: [1] }] },
            usage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
            mode: 'json_schema' as const,
            finishReason: 'stop',
          };
        }) as never,
        completeFn: (async (opts: unknown) => {
          completeCalls.push(opts as Record<string, unknown>);
          return {
            text: '## 1. 痛点\n\n正文…',
            usage: { promptTokens: 300, completionTokens: 150, totalTokens: 450 },
            finishReason: 'stop',
          };
        }) as never,
      },
    );
    expect(result.ok).toBe(true);
    // 规划器：菜单带标题补挂在旧模板之后
    const plannerPrompt = String(generateCalls[0].prompt);
    expect(plannerPrompt).toContain('STALE DB TEMPLATE (chapter_pedagogy_compiler)');
    expect(plannerPrompt.endsWith(
      `\n\n[PRE-VALIDATED SLOT MENU — every id below is a real, already-verified code slot]\n${slotMenuText}\n`,
    )).toBe(true);
    // 写课：整段简报（含教案）与主线/深潜分层契约均补挂在旧模板之后，且简报只出现一次
    const lessonPrompt = String(completeCalls[0].prompt);
    expect(lessonPrompt).toContain('STALE DB TEMPLATE (pedagogy_rewrite)');
    expect(lessonPrompt.match(/\[AI TEACHING BRIEF & PEDAGOGICAL STRATEGY/g)).toHaveLength(1);
    expect(lessonPrompt).toContain('  1. [mainline] 建立冷恢复的心智模型 — evidence: [File 1#ensureColdReadyPublisher:core]');
    expect(lessonPrompt).toContain('<details data-layer="deep">');
    expect(lessonPrompt).toContain('MAINLINE NARRATIVE CONTRACT (MANDATORY)');
    staleSpy.mockRestore();
  });

  it('规划器 Prompt 含槽位菜单段与教案规则；deep 风格预设不再要求逐个函数点名', async () => {
    const baselineSpy = useCodeBaseline();
    try {
      const compiled = await lookupLlmPurpose('chapter_pedagogy_compiler')!.compile({
        chapterTitle: '冷恢复',
        chapterDescription: '订阅时的投影重建',
        targetLanguage: 'zh',
        filesSummary: '[File 1] src/gateway.ts (10 lines)',
        slotMenuSection: slotMenuText,
      });
      expect(compiled).toContain('[PRE-VALIDATED SLOT MENU — every id below is a real, already-verified code slot]');
      expect(compiled).toContain(slotMenuText);
      expect(compiled).toContain('LESSON PLAN (pre-validated evidence)');
      expect(compiled).toContain('NEVER invent slot ids');
      // 菜单文本只出现一次（占位符已消费时不重复补挂）
      expect(compiled.split(slotMenuText)).toHaveLength(2);
    } finally {
      baselineSpy.mockRestore();
    }
  });

  it('renderLessonPlan：单步超过 6 个合法且不重复的 slotId 时截断为前 6 个', () => {
    const eightSlotMenu = Array.from({ length: 8 }, (_, idx) => ({
      id: idx + 1,
      fileIndex: 1,
      anchor: `fn${idx + 1}`,
      aspect: 'core',
    }));
    const plan = renderLessonPlan(
      {
        ...baseBrief,
        steps: [{ goal: '全量槽位截断验证', layer: 'core', slotIds: [1, 2, 3, 4, 5, 6, 7, 8] }],
      },
      { slotMenu: eightSlotMenu },
    );
    expect(plan).not.toBeNull();
    expect(plan?.slotCount).toBe(6);
    expect(plan?.lines[1]).toContain('[File 1#fn6:core]');
    expect(plan?.lines[1]).not.toContain('[File 1#fn7:core]');
    expect(plan?.lines[1]).not.toContain('[File 1#fn8:core]');
  });

  it('parseSlotMenu：校验 anchor 格式、fileIndex 上界与 aspect 白名单', () => {
    const parsed = parseSlotMenu(
      [
        { id: 1, fileIndex: 1, anchor: 'validSymbol_1', aspect: 'CORE' },
        { id: 2, fileIndex: 2, anchor: 'L10-L45', aspect: 'contract' },
        { id: 3, fileIndex: 2, anchor: 'L8', aspect: 'full' },
        { id: 4, fileIndex: 1, anchor: 'bad symbol with space', aspect: 'core' },
        { id: 5, fileIndex: 1, anchor: 'inject]break', aspect: 'core' },
        { id: 6, fileIndex: 1, anchor: 'src/path.ts', aspect: 'core' },
        { id: 7, fileIndex: 1, anchor: 'L45-L10', aspect: 'core' },
        { id: 8, fileIndex: 1, anchor: 'L0', aspect: 'core' },
        { id: 9, fileIndex: 3, anchor: 'outOfBoundFile', aspect: 'core' },
        { id: 10, fileIndex: 1, anchor: 'badAspectSym', aspect: 'deep' },
        { id: 0, fileIndex: 1, anchor: 'badId', aspect: 'core' },
        { id: 11, fileIndex: 1, anchor: 'a'.repeat(121), aspect: 'core' },
      ],
      2,
    );
    expect(parsed).toEqual([
      { id: 1, fileIndex: 1, anchor: 'validSymbol_1', aspect: 'core' },
      { id: 2, fileIndex: 2, anchor: 'L10-L45', aspect: 'contract' },
      { id: 3, fileIndex: 2, anchor: 'L8', aspect: 'full' },
    ]);

    // filesSummary 推断 fileIndex 上界；同时受 64 硬上限保护
    const inferredPlan = renderLessonPlan(
      {
        ...baseBrief,
        steps: [{ goal: '边界约束', layer: 'core', slotIds: [1, 2] }],
      },
      {
        filesSummary: '[File 1] src/a.ts (10 lines)',
        slotMenu: [
          { id: 1, fileIndex: 1, anchor: 'okFn', aspect: 'core' },
          { id: 2, fileIndex: 2, anchor: 'staleFileFn', aspect: 'core' },
        ],
      },
    );
    expect(inferredPlan?.slotCount).toBe(1);
    expect(inferredPlan?.lines[1]).toContain('[File 1#okFn:core]');
    expect(inferredPlan?.lines[1]).not.toContain('staleFileFn');

    expect(parseSlotMenu([{ id: 1, fileIndex: 65, anchor: 'tooHigh' }])).toEqual([]);
  });

  it('briefState：slotCount>0 时返回 plan，steps 无有效槽位时退化为 arc（一元与流式 done 事件均透出），失败降级不透出', async () => {
    const baselineSpy = useCodeBaseline();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 1. steps 存在但 slotIds 全部无效 -> slotCount=0 -> briefState='arc'
      const zeroSlotRes = await runLesson({
        ...baseBrief,
        steps: [{ goal: '无效槽位仅作弧线', layer: 'core', slotIds: [999] }],
      });
      expect(zeroSlotRes.result.ok).toBe(true);
      if (zeroSlotRes.result.ok) {
        expect(zeroSlotRes.result.briefState).toBe('arc');
      }
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('brief state=arc'));

      // 2. 有效 slotCount > 0 -> briefState='plan'
      const validPlanRes = await runLesson({
        ...baseBrief,
        steps: [{ goal: '命中合法槽位', layer: 'core', slotIds: [1] }],
      });
      expect(validPlanRes.result.ok).toBe(true);
      if (validPlanRes.result.ok) {
        expect(validPlanRes.result.briefState).toBe('plan');
      }

      // 3. 流式 done 事件透出 briefState
      async function readDoneEvent(stream: ReadableStream<Uint8Array>) {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
        }
        const events = buf
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        return events.find((e) => e.type === 'done');
      }

      async function* emptyTextStream() {
        yield { type: 'text-delta', text: '正文' };
      }

      const planDone = await readDoneEvent(
        runLlmGatewayStream(
          {
            purpose: 'code_chapter_lesson',
            variables: { chapterTitle: 't', slotMenu, slotMenuText },
          },
          {
            cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
            generateFn: (async () => ({
              object: { ...baseBrief, steps: [{ goal: 's', layer: 'core', slotIds: [1] }] },
              usage: { totalTokens: 10 },
            })) as never,
            streamFn: (async () => ({ fullStream: emptyTextStream(), finishReason: 'stop', usage: { totalTokens: 20 } })) as never,
            pingIntervalMs: 0,
          },
        ),
      );
      expect(planDone?.briefState).toBe('plan');

      const arcDone = await readDoneEvent(
        runLlmGatewayStream(
          {
            purpose: 'code_chapter_lesson',
            variables: { chapterTitle: 't', slotMenu, slotMenuText },
          },
          {
            cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
            generateFn: (async () => ({
              object: { ...baseBrief, steps: [{ goal: 's', layer: 'core', slotIds: [888] }] },
              usage: { totalTokens: 10 },
            })) as never,
            streamFn: (async () => ({ fullStream: emptyTextStream(), finishReason: 'stop', usage: { totalTokens: 20 } })) as never,
            pingIntervalMs: 0,
          },
        ),
      );
      expect(arcDone?.briefState).toBe('arc');

      // 4. 元编译器异常降级时，briefState 应省略（undefined）
      const fallbackRes = await runLlmGatewayGenerate(
        {
          purpose: 'code_chapter_lesson',
          variables: { chapterTitle: 't' },
        },
        {
          cascadeCandidates: [{ provider: 'test-provider', modelId: 'test-model', apiKey: 'test-key' }],
          generateFn: (async () => {
            throw new Error('meta failed');
          }) as never,
          completeFn: (async () => ({ text: 'ok', finishReason: 'stop', usage: { totalTokens: 10 } })) as never,
        },
      );
      expect(fallbackRes.ok).toBe(true);
      if (fallbackRes.ok) {
        expect(fallbackRes.briefState).toBeUndefined();
      }
    } finally {
      baselineSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('teachingBriefSchema 兼容 OpenAI strict JSON Schema 且可用 z.toJSONSchema 导出', async () => {
    const bareJsonSchema = z.toJSONSchema(teachingBriefSchema) as Record<string, unknown>;
    expect(bareJsonSchema.required).toContain('steps');
    expect(bareJsonSchema.additionalProperties).toBe(false);

    const sdkJsonSchema = (await asSchema(teachingBriefSchema).jsonSchema) as Record<string, any>;
    expect(sdkJsonSchema.required).toContain('steps');
    expect(sdkJsonSchema.additionalProperties).toBe(false);
    expect(Array.isArray(sdkJsonSchema.properties?.steps?.anyOf)).toBe(true);
    expect(sdkJsonSchema.properties.steps.anyOf.some((branch: { type?: string }) => branch.type === 'null')).toBe(true);
    expect(sdkJsonSchema.properties.steps.anyOf.some((branch: { type?: string }) => branch.type === 'array')).toBe(true);
    expect(sdkJsonSchema.properties.steps.anyOf[0].items.default).toBeUndefined();
  });
});
