import { test, expect, describe, vi, beforeEach } from 'vitest';
import {
  conservativePlan,
  generateUpdatePlan,
  stripAndNormalizePlanPayload,
  parseUpdatePlanPayload,
  salvagePartialUpdatePlan,
} from '@/engine/update-planner';
import type { UpdateCandidateSet } from '@/engine/update-candidate-set';
import { generateStructured } from '@/lib/ai';
import { PromptRegistry } from '@/lib/prompt-registry';

vi.mock('@/lib/ai', () => ({
  generateStructured: vi.fn(),
}));

describe('update-planner 更新规划（Stage 1 LLM 决策与兜底）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 🧪 [5.2.1.1 · HIGH] LLM 规划的删除操作过于激进导致已有优质章节全部丢失
  test('5.2.1.1 update_planner_constitution：宪法包含关键硬约束词汇', () => {
    const constitution = PromptRegistry.compilePresetSync('update_planner_constitution');
    expect(constitution).toContain('结构稳定：绝不重排');
    expect(constitution).toContain('默认 update');
    expect(constitution).toContain('keep 豁免');
    expect(constitution).toContain('add 条件');
    expect(constitution).toContain('不越权');
    expect(constitution).toContain('正确性优先');
  });

  test('update_planner_constitution：声明系统已接管的业务（rename 迁移 / remove 事实核验）', () => {
    // v2 宪法：业务规则收归代码层，prompt 只声明接管边界，不承担防御性指令
    const constitution = PromptRegistry.compilePresetSync('update_planner_constitution');
    expect(constitution).toContain('系统已接管');
    expect(constitution).toContain('路径由系统自动迁移');
    expect(constitution).toContain('按 Git 删除事实核验');
  });

  // 🧪 [5.2.1.3 · HIGH] AI 规划失败或响应超时导致用户更新流水线彻底阻断
  test('5.2.1.3 conservativePlan：纯函数全量更新保守兜底', () => {
    const candidateSet: UpdateCandidateSet = {
      chapters: [
        {
          path: 'docs/01-intro.md',
          title: '起步',
          oldSummary: '旧摘要1',
          change: 'content',
          affectedFiles: [{ path: 'docs/01-intro.md', change: 'modified' }],
        },
        {
          path: 'chapters/02.mdx',
          title: '核心架构',
          oldSummary: '旧摘要2',
          change: 'structural',
          affectedFiles: [
            { path: 'src/core.ts', change: 'modified' },
            { path: 'src/new.ts', change: 'added' },
          ],
        },
      ],
      unmatchedFiles: [],
      structuralAdds: [],
      structuralRemoves: [],
      diffStats: { added: 1, modified: 2, removed: 0, renamed: 0 },
      hasOldArchive: true,
    };

    const existingChapterTitles = ['起步', '核心架构', '高级实战'];
    const plan = conservativePlan(candidateSet, existingChapterTitles);

    expect(plan.chapters).toHaveLength(2);
    expect(plan.chapters[0]).toEqual({
      path: 'docs/01-intro.md',
      action: 'update',
      reason: 'LLM 计划不可用，按保守策略全量重转录候选章节',
      evidence: 'docs/01-intro.md',
    });
    expect(plan.chapters[1]).toEqual({
      path: 'chapters/02.mdx',
      action: 'update',
      reason: 'LLM 计划不可用，按保守策略全量重转录候选章节',
      evidence: 'src/core.ts, src/new.ts',
    });
    expect(plan.summary).toContain('共 2 章');
    expect(plan.summary).toContain('现有章节结构 3 个保持不变');
  });

  test('generateUpdatePlan：成功调用并清洗去重重复章节路径', async () => {
    (generateStructured as any).mockResolvedValue({
      object: {
        chapters: [
          {
            path: 'docs/01-intro.md',
            action: 'update',
            reason: '内容改动较大',
            evidence: 'docs/01-intro.md',
          },
          {
            path: 'docs/01-intro.md', // 重复条目，应当被 sanitizePlan 剔除
            action: 'keep',
            reason: '重复条目',
            evidence: '',
          },
          {
            path: 'docs/02-guide.md',
            action: 'keep',
            reason: '仅修复了 typo',
            evidence: 'docs/02-guide.md',
          },
        ],
        summary: '这是测试计划概要',
      },
    });

    const candidateSet: UpdateCandidateSet = {
      chapters: [
        {
          path: 'docs/01-intro.md',
          title: 'Intro',
          oldSummary: null,
          change: 'content',
          affectedFiles: [{ path: 'docs/01-intro.md', change: 'modified' }],
        },
        {
          path: 'docs/02-guide.md',
          title: 'Guide',
          oldSummary: null,
          change: 'content',
          affectedFiles: [{ path: 'docs/02-guide.md', change: 'modified' }],
        },
      ],
      unmatchedFiles: [],
      structuralAdds: [],
      structuralRemoves: [],
      diffStats: { added: 0, modified: 2, removed: 0, renamed: 0 },
      hasOldArchive: false,
    };

    const plan = await generateUpdatePlan({
      owner: 'test-owner',
      repo: 'test-repo',
      branch: 'main',
      fromSha: '1111111111111111111111111111111111111111',
      toSha: '2222222222222222222222222222222222222222',
      candidateSet,
      existingChapterTitles: ['Intro', 'Guide'],
    });

    expect(plan).not.toBeNull();
    expect(plan?.chapters).toHaveLength(2); // 重复的 01-intro 已去重
    expect(plan?.chapters[0].path).toBe('docs/01-intro.md');
    expect(plan?.chapters[0].action).toBe('update');
    expect(plan?.chapters[1].path).toBe('docs/02-guide.md');
    expect(plan?.chapters[1].action).toBe('keep');
    expect(plan?.summary).toBe('这是测试计划概要');
  });

  test('generateUpdatePlan：LLM 产生空计划且重试耗尽时返回 null 降级', async () => {
    (generateStructured as any).mockResolvedValue({
      object: {
        chapters: [],
        summary: '',
      },
    });

    const candidateSet: UpdateCandidateSet = {
      chapters: [
        {
          path: 'docs/01.md',
          title: 'Doc',
          oldSummary: null,
          change: 'content',
          affectedFiles: [{ path: 'docs/01.md', change: 'modified' }],
        },
      ],
      unmatchedFiles: [],
      structuralAdds: [],
      structuralRemoves: [],
      diffStats: { added: 0, modified: 1, removed: 0, renamed: 0 },
      hasOldArchive: false,
    };

    const plan = await generateUpdatePlan({
      owner: 'test-owner',
      repo: 'test-repo',
      branch: 'main',
      fromSha: '3333333333333333333333333333333333333333',
      toSha: '4444444444444444444444444444444444444444',
      candidateSet,
      existingChapterTitles: ['Doc'],
    });

    expect(plan).toBeNull();
  });

  // ── Stage 0 确定性 keep 豁免分流（零 LLM 下沉）──

  const exemptChapter = {
    path: 'chapters/03.mdx',
    title: '解析器模块',
    oldSummary: null,
    change: 'content' as const,
    affectedFiles: [{ path: 'pnpm-lock.yaml', change: 'modified' as const }],
    keepExemption: {
      reason: '规则命中：受影响文件全部为基础设施角色（pnpm-lock.yaml），章节教学源未变，零 LLM 裁决',
      evidence: 'pnpm-lock.yaml',
    },
  };

  // 🧪 [5.2.2.2 · HIGH] 规则豁免误吞教学变更：章节的教学源文件被当作基础设施角色豁免 keep
  // AntiPattern: 仅按文件角色分类豁免，未校验章节内容核
  // DefenseAssertion: computeKeepExemption 要求受影响文件全部为非教学角色且源集中存在未受影响的内容角色文件（S\A 内容核限定）；全 infra 源章节（如「讲 CI」）永不豁免；结构性变更（added/removed）不参与豁免
  test('5.2.2.2 全候选豁免 → 整体短路：不调 LLM，直接返回预填 keep 计划', async () => {
    const candidateSet: UpdateCandidateSet = {
      chapters: [
        { ...exemptChapter },
        {
          ...exemptChapter,
          path: 'chapters/05.mdx',
          affectedFiles: [{ path: '.github/workflows/ci.yml', change: 'modified' }],
          keepExemption: {
            reason: '规则命中：受影响文件全部为基础设施角色（.github/workflows/ci.yml），章节教学源未变，零 LLM 裁决',
            evidence: '.github/workflows/ci.yml',
          },
        },
      ],
      unmatchedFiles: [],
      structuralAdds: [],
      structuralRemoves: [],
      diffStats: { added: 0, modified: 2, removed: 0, renamed: 0 },
      hasOldArchive: false,
    };

    const plan = await generateUpdatePlan({
      owner: 'test-owner',
      repo: 'test-repo',
      branch: 'main',
      fromSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      toSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      candidateSet,
      existingChapterTitles: ['解析器模块'],
    });

    expect(generateStructured).not.toHaveBeenCalled(); // 零 token、零重试
    expect(plan).not.toBeNull();
    expect(plan?.chapters).toHaveLength(2);
    expect(plan?.chapters.every((c) => c.action === 'keep')).toBe(true);
    expect(plan?.chapters[0].evidence).toBe('pnpm-lock.yaml');
    expect(plan?.summary).toContain('确定性规则豁免');
  });

  test('部分豁免 → 豁免章节不进 LLM 提示词，预填 keep 合并回最终计划', async () => {
    (generateStructured as any).mockResolvedValue({
      object: {
        chapters: [
          { path: 'docs/01-intro.md', action: 'update', reason: '核心内容变更', evidence: 'docs/01-intro.md' },
        ],
        summary: 'LLM 计划概要',
      },
    });

    const candidateSet: UpdateCandidateSet = {
      chapters: [
        {
          path: 'docs/01-intro.md',
          title: 'Intro',
          oldSummary: null,
          change: 'content',
          affectedFiles: [{ path: 'docs/01-intro.md', change: 'modified' }],
        },
        { ...exemptChapter },
      ],
      unmatchedFiles: [],
      structuralAdds: [],
      structuralRemoves: [],
      diffStats: { added: 0, modified: 2, removed: 0, renamed: 0 },
      hasOldArchive: false,
    };

    const plan = await generateUpdatePlan({
      owner: 'test-owner',
      repo: 'test-repo',
      branch: 'main',
      fromSha: 'cccccccccccccccccccccccccccccccccccccccc',
      toSha: 'dddddddddddddddddddddddddddddddddddddddd',
      candidateSet,
      existingChapterTitles: ['Intro', '解析器模块'],
    });

    // LLM 提示词只含未豁免章节（豁免章节零漂移面）
    const promptArg = (generateStructured as any).mock.calls[0][0].prompt as string;
    expect(promptArg).toContain('docs/01-intro.md');
    expect(promptArg).not.toContain('chapters/03.mdx');

    // 合并计划：LLM 裁决 + 预填 keep 并存
    expect(plan?.chapters).toHaveLength(2);
    const keepEntry = plan?.chapters.find((c) => c.path === 'chapters/03.mdx');
    expect(keepEntry?.action).toBe('keep');
    expect(keepEntry?.evidence).toBe('pnpm-lock.yaml');
    const updateEntry = plan?.chapters.find((c) => c.path === 'docs/01-intro.md');
    expect(updateEntry?.action).toBe('update');
    expect(plan?.summary).toContain('1 章由确定性规则豁免');
  });

  test('conservativePlan：确定性豁免穿透降级路径（LLM 失败仍保持 keep）', () => {
    const candidateSet: UpdateCandidateSet = {
      chapters: [
        {
          path: 'docs/01-intro.md',
          title: 'Intro',
          oldSummary: null,
          change: 'content',
          affectedFiles: [{ path: 'docs/01-intro.md', change: 'modified' }],
        },
        { ...exemptChapter },
      ],
      unmatchedFiles: [],
      structuralAdds: [],
      structuralRemoves: [],
      diffStats: { added: 0, modified: 2, removed: 0, renamed: 0 },
      hasOldArchive: false,
    };

    const plan = conservativePlan(candidateSet, ['Intro', '解析器模块']);
    const keepEntry = plan.chapters.find((c) => c.path === 'chapters/03.mdx');
    expect(keepEntry?.action).toBe('keep'); // 规则证明与 LLM 可用性无关
    expect(keepEntry?.reason).toContain('基础设施角色');
    expect(plan.chapters.find((c) => c.path === 'docs/01-intro.md')?.action).toBe('update');
    expect(plan.summary).toContain('1 章由确定性规则豁免');
  });

  describe('stripAndNormalizePlanPayload 确定性载荷剥壳与别名自愈', () => {
    test('剥离 <think> 思考标签与 ```json 围栏与前后寒暄', () => {
      const raw = `<think>
用户更新了两个核心文档，需要生成针对性增量计划。
1. doc1 应该 update
2. doc2 应该 keep
</think>
根据变更分析，更新计划如下：
\`\`\`json
{
  "chapters": [
    { "path": "docs/a.md", "action": "update", "reason": "修改了主体内容", "evidence": "docs/a.md" },
    { "path": "docs/b.md", "action": "keep", "reason": "只改了注释", "evidence": "docs/b.md" }
  ],
  "summary": "正常更新"
}
\`\`\`
请确认以上计划。`;

      const parsed = parseUpdatePlanPayload(raw);
      expect(parsed.chapters).toHaveLength(2);
      expect(parsed.chapters[0].path).toBe('docs/a.md');
      expect(parsed.chapters[0].action).toBe('update');
      expect(parsed.chapters[1].path).toBe('docs/b.md');
      expect(parsed.chapters[1].action).toBe('keep');
      expect(parsed.summary).toBe('正常更新');
    });

    test('解开嵌套容器 data / result / plan', () => {
      const nestedData = {
        data: {
          result: {
            plan: {
              chapters: [
                { path: "docs/nested.md", action: "update", reason: "嵌套测试", evidence: "docs/nested.md" }
              ],
              summary: "多层嵌套解开"
            }
          }
        }
      };

      const parsed = parseUpdatePlanPayload(nestedData);
      expect(parsed.chapters).toHaveLength(1);
      expect(parsed.chapters[0].path).toBe('docs/nested.md');
      expect(parsed.summary).toBe('多层嵌套解开');
    });

    test('顶层字段别名自愈：actions / items / modules / sections 映射到 chapters', () => {
      const payloadWithActions = {
        actions: [
          { file: "docs/action.md", type: "update", rationale: "actions 别名", proof: "docs/action.md" }
        ],
        description: "顶层别名描述"
      };

      const parsed = parseUpdatePlanPayload(payloadWithActions);
      expect(parsed.chapters).toHaveLength(1);
      expect(parsed.chapters[0].path).toBe('docs/action.md');
      expect(parsed.chapters[0].action).toBe('update');
      expect(parsed.chapters[0].reason).toBe('actions 别名');
      expect(parsed.chapters[0].evidence).toBe('docs/action.md');
      expect(parsed.summary).toBe('顶层别名描述');
    });

    test('generateUpdatePlan 遇到外层包裹与字段漂移直接自愈，零额外重试', async () => {
      (generateStructured as any).mockResolvedValue({
        object: `\`\`\`json
{
  "plan": {
    "items": [
      { "target": "docs/drift.md", "operation": "update", "desc": "来自漂移模型的载荷", "facts": "docs/drift.md" }
    ],
    "overview": "自愈成功"
  }
}
\`\`\``,
      });

      const candidateSet: UpdateCandidateSet = {
        chapters: [
          {
            path: 'docs/drift.md',
            title: 'Drift',
            oldSummary: null,
            change: 'content',
            affectedFiles: [{ path: 'docs/drift.md', change: 'modified' }],
          },
        ],
        unmatchedFiles: [],
        structuralAdds: [],
        structuralRemoves: [],
        diffStats: { added: 0, modified: 1, removed: 0, renamed: 0 },
        hasOldArchive: false,
      };

      const plan = await generateUpdatePlan({
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        fromSha: '5555555555555555555555555555555555555555',
        toSha: '6666666666666666666666666666666666666666',
        candidateSet,
        existingChapterTitles: ['Drift'],
      });

      expect(generateStructured).toHaveBeenCalledTimes(1);
      expect(plan).not.toBeNull();
      expect(plan?.chapters).toHaveLength(1);
      expect(plan?.chapters[0].path).toBe('docs/drift.md');
      expect(plan?.chapters[0].action).toBe('update');
      expect(plan?.summary).toBe('自愈成功');
    });

    test('支持顶层 JSON 数组载荷与前后寒暄包裹的数组', () => {
      const rawArray = `[
        { "path": "docs/a.md", "action": "update", "reason": "更新理由", "evidence": "docs/a.md" },
        { "path": "docs/b.md", "action": "keep", "reason": "保留理由", "evidence": "docs/b.md" }
      ]`;

      const parsed = parseUpdatePlanPayload(rawArray);
      expect(parsed.chapters).toHaveLength(2);
      expect(parsed.chapters[0].path).toBe('docs/a.md');
      expect(parsed.chapters[0].action).toBe('update');
      expect(parsed.chapters[1].path).toBe('docs/b.md');
      expect(parsed.chapters[1].action).toBe('keep');

      const rawArrayWithChat = `模型输出的计划如下：
\`\`\`json
[
  { "file": "docs/conv.md", "type": "update", "desc": "数组寒暄测试", "proof": "docs/conv.md" }
]
\`\`\`
请审阅。`;

      const parsedChat = parseUpdatePlanPayload(rawArrayWithChat);
      expect(parsedChat.chapters).toHaveLength(1);
      expect(parsedChat.chapters[0].path).toBe('docs/conv.md');
      expect(parsedChat.chapters[0].action).toBe('update');
      expect(parsedChat.chapters[0].reason).toBe('数组寒暄测试');
      expect(parsedChat.chapters[0].evidence).toBe('docs/conv.md');
    });

    test('buildPrompt 将 surgicalAnchors 与 diffSnippet 注入局部变更锚点', async () => {
      (generateStructured as any).mockResolvedValue({
        object: {
          chapters: [
            { path: 'chapters/01.mdx', action: 'update', reason: '符号变动', evidence: 'src/calc.ts' },
          ],
          summary: '按差异切片精确定位',
        },
      });

      const candidateSet: UpdateCandidateSet = {
        chapters: [
          {
            path: 'chapters/01.mdx',
            title: '数学计算',
            oldSummary: '计算模块',
            change: 'content',
            affectedFiles: [{ path: 'src/calc.ts', change: 'modified' }],
            surgicalAnchors: [
              {
                symbolName: 'Compute',
                kind: 'function',
                file: 'src/calc.ts',
                change: 'modified',
                exported: true,
                line: 10,
                reason: '导出符号 Compute 发生变更 (modified)',
                diffSnippet: '- return x * 2\n+ return x * 3',
              },
            ],
          },
        ],
        unmatchedFiles: [],
        structuralAdds: [],
        structuralRemoves: [],
        diffStats: { added: 0, modified: 1, removed: 0, renamed: 0 },
        hasOldArchive: false,
      };

      await generateUpdatePlan({
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        fromSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        toSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        candidateSet,
        existingChapterTitles: ['数学计算'],
      });

      expect(generateStructured).toHaveBeenCalledTimes(1);
      const callArgs = (generateStructured as any).mock.calls[0][0];
      expect(callArgs.prompt).toContain('【局部变更锚点】');
      expect(callArgs.prompt).toContain('function Compute (导出符号 Compute 发生变更 (modified))');
      expect(callArgs.prompt).toContain('差异切片:');
      expect(callArgs.prompt).toContain('- return x * 2');
      expect(callArgs.prompt).toContain('+ return x * 3');
    });
  });

  describe('Layer 1 内存状态机物理急救打捞 (salvagePartialUpdatePlan)', () => {
    test('从 Token 耗尽被截断的 JSON 中完整打捞已闭合的章节决策', () => {
      const truncatedRaw = `
      {
        "chapters": [
          {
            "path": "docs/01-intro.md",
            "action": "keep",
            "reason": "仅修改了拼写错误",
            "evidence": "docs/01-intro.md"
          },
          {
            "path": "docs/02-arch.md",
            "action": "update",
            "reason": "核心拓扑变动",
            "evidence": "src/core.ts"
          },
          {
            "path": "docs/03-api.md",
            "action": "upda
      `;

      const salvaged = salvagePartialUpdatePlan(truncatedRaw);
      expect(salvaged).toHaveLength(2);
      expect(salvaged[0]).toEqual({
        path: 'docs/01-intro.md',
        action: 'keep',
        position: undefined,
        title: undefined,
        reason: '仅修改了拼写错误',
        evidence: 'docs/01-intro.md',
      });
      expect(salvaged[1]).toEqual({
        path: 'docs/02-arch.md',
        action: 'update',
        position: undefined,
        title: undefined,
        reason: '核心拓扑变动',
        evidence: 'src/core.ts',
      });
    });

    test('支持穿透 <think> 思考标签和带 Markdown 围栏的截断载荷', () => {
      const rawWithFences = `
      <think>
      这是模型的思考过程，正在分析 diff...
      </think>
      \`\`\`json
      {
        "chapters": [
          {
            "target": "chapters/network.mdx",
            "op": "UPDATE",
            "rationale": "通信协议重构",
            "proof": "net.go"
          }
        ]
      `;

      const salvaged = salvagePartialUpdatePlan(rawWithFences);
      expect(salvaged).toHaveLength(1);
      expect(salvaged[0].path).toBe('chapters/network.mdx');
      expect(salvaged[0].action).toBe('update');
      expect(salvaged[0].reason).toBe('通信协议重构');
      expect(salvaged[0].evidence).toBe('net.go');
    });

    test('parseUpdatePlanPayload 在 JSON 语法损坏时自动触发 Layer 1 急救', () => {
      const brokenJson = `{"chapters": [{"path": "a.mdx", "action": "keep", "reason": "ok", "evidence": "a.ts"}, {"path": "b.mdx", "action": "update", "reason": "broken"`;
      const plan = parseUpdatePlanPayload(brokenJson);
      expect(plan.chapters).toHaveLength(1);
      expect(plan.chapters[0].path).toBe('a.mdx');
      expect(plan.chapters[0].action).toBe('keep');
    });
  });

  describe('AST 物理事实精准保底与显式防御 (conservativePlan)', () => {
    test('当 isBreaking 为 false 且无破坏性变更时，保底裁决判定为 keep 而非无脑 update', () => {
      const candidateSet: UpdateCandidateSet = {
        chapters: [
          {
            path: 'docs/01-safe.md',
            title: '安全章节',
            oldSummary: null,
            change: 'content',
            isBreaking: false,
            affectedFiles: [{ path: 'src/utils.ts', change: 'modified' }],
            surgicalAnchors: [
              {
                symbolName: 'internalHelper',
                kind: 'function',
                file: 'src/utils.ts',
                change: 'modified',
                exported: false,
                line: 20,
              },
            ],
          },
          {
            path: 'docs/02-breaking.md',
            title: '破坏性章节',
            oldSummary: null,
            change: 'content',
            isBreaking: true,
            affectedFiles: [{ path: 'src/api.ts', change: 'modified' }],
          },
        ],
        unmatchedFiles: [],
        structuralAdds: [],
        structuralRemoves: [],
        diffStats: { added: 0, modified: 2, removed: 0, renamed: 0 },
        hasOldArchive: false,
      };

      const plan = conservativePlan(candidateSet, ['安全章节', '破坏性章节']);
      expect(plan.isFallback).toBe(true);
      expect(plan.fallbackReason).toContain('LLM 规划服务响应异常');

      const safeChapter = plan.chapters.find((c) => c.path === 'docs/01-safe.md');
      expect(safeChapter?.action).toBe('keep');
      expect(safeChapter?.reason).toContain('静态 AST 事实核验');

      const breakingChapter = plan.chapters.find((c) => c.path === 'docs/02-breaking.md');
      expect(breakingChapter?.action).toBe('update');
      expect(breakingChapter?.reason).toContain('保守策略');
    });
  });

  describe('大候选集分批切片规划 (Batching & Chunking)', () => {
    test('当候选章节超过 6 个时，分批调用 generateStructured 并完整汇聚所有批次结果', async () => {
      // 构造 8 个候选章节
      const mockChapters = Array.from({ length: 8 }, (_, i) => ({
        path: `docs/chap-${i + 1}.md`,
        title: `章节 ${i + 1}`,
        oldSummary: null,
        change: 'content' as const,
        affectedFiles: [{ path: `src/mod${i + 1}.ts`, change: 'modified' as const }],
      }));

      (generateStructured as any)
        .mockResolvedValueOnce({
          object: {
            chapters: mockChapters.slice(0, 6).map((c) => ({
              path: c.path,
              action: 'update',
              reason: '批次 1 决议',
              evidence: c.path,
            })),
            summary: '批次 1 概要',
          },
        })
        .mockResolvedValueOnce({
          object: {
            chapters: mockChapters.slice(6, 8).map((c) => ({
              path: c.path,
              action: 'keep',
              reason: '批次 2 决议',
              evidence: c.path,
            })),
            summary: '批次 2 概要',
          },
        });

      const candidateSet: UpdateCandidateSet = {
        chapters: mockChapters,
        unmatchedFiles: [],
        structuralAdds: [],
        structuralRemoves: [],
        diffStats: { added: 0, modified: 8, removed: 0, renamed: 0 },
        hasOldArchive: false,
      };

      const plan = await generateUpdatePlan({
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        fromSha: '8888888888888888888888888888888888888888',
        toSha: '9999999999999999999999999999999999999999',
        candidateSet,
        existingChapterTitles: mockChapters.map((c) => c.title),
      });

      expect(plan).not.toBeNull();
      expect(plan?.chapters).toHaveLength(8);
      // 8 个章节应该被拆分为 2 批 (6 + 2)
      expect(generateStructured).toHaveBeenCalledTimes(2);
      expect(plan?.chapters.slice(0, 6).every((c) => c.action === 'update')).toBe(true);
      expect(plan?.chapters.slice(6, 8).every((c) => c.action === 'keep')).toBe(true);
    });
  });
});
