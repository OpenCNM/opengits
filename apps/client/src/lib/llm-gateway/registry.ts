import { z } from 'zod';
import { PromptRegistry } from '@/lib/prompt-registry';
import { RelayTranscriptionSchema } from '@/lib/schemas/relay-contract';
import { chapterMapSchema } from '@/engine/chapter-map';
import { normalizeOutlinePlan, normalizeOutlineMap } from './normalizers';
import {
  siteTopologyDecisionSchema,
  normalizeSiteTopologyDecision,
  siteContainerProbeDecisionSchema,
  normalizeSiteContainerProbeDecision,
} from '@/lib/schemas/webdoc-topology';

// Wire sends purpose + variables + userId only; web owns prompts and Zod schemas as SSOT to prevent drift and prompt leakage.

interface MetaCompilerSpec<TBrief = unknown> {
  metaPurpose: string;
  briefSchema: z.ZodType<TBrief>;
  timeoutMs?: number;
  prepareMetaVariables: (variables: Record<string, any>) => Record<string, any>;
  injectBrief: (brief: TBrief | null, variables: Record<string, any>) => MetaBriefInjection;
  shouldCompile?: (variables: Record<string, any>) => boolean;
}

interface MetaBriefInjection {
  variables: Record<string, any>;
  briefState?: MetaBriefState;
}

interface LlmGatewayPurpose<P extends z.ZodTypeAny = z.ZodTypeAny> {
  kind: 'structured' | 'text';
  schema?: P;
  // Idempotently unwrap, align aliases, and clamp model output before strict Zod validation.
  normalizeOutput?: (raw: unknown) => unknown;
  compile: (variables: Record<string, unknown>) => Promise<string>;
  source: string;
  keyOrigin: 'user' | 'platform';
  priority: 'interactive' | 'batch';
  temperature?: number;
  maxTokens?: number;
  disableThinking?: boolean;
  // Hard purpose-level deadline aborts upstream AI SDK fetch so cancelled requests stop burning tokens.
  timeoutMs?: number;
  preferFastFallback?: boolean;
  metaCompiler?: MetaCompilerSpec<any>;
}

const teachingBriefStepSchema = z.object({
  goal: z.string(),
  layer: z.enum(['core', 'deep']),
  slotIds: z.array(z.number().int()),
});

// Isolate malformed steps via .catch(undefined) while keeping OpenAI strict json_schema compatibility (nullable, no default).
const resilientTeachingBriefStepSchema = teachingBriefStepSchema.catch(undefined as never);

export const teachingBriefSchema = z.object({
  persona: z.string().max(80),
  mentalModel: z.string().max(200),
  pedagogicalArc: z.array(z.string().max(120)).min(2).max(5),
  mermaidStrategy: z.object({
    diagramType: z.enum(['flowchart', 'sequence', 'state', 'class']),
    focus: z.string().max(160),
  }),
  learnerTrap: z.string().max(200),
  narrativeGuidelines: z.string().max(300),
  steps: z
    .array(resilientTeachingBriefStepSchema)
    .nullable()
    .refine((v) => v !== null && v.some((item) => item !== undefined))
    .catch(undefined as never) as z.ZodType<Array<z.infer<typeof teachingBriefStepSchema> | undefined> | undefined>,
});

export type TeachingBriefStep = z.infer<typeof teachingBriefStepSchema>;
export type TeachingBrief = Omit<z.infer<typeof teachingBriefSchema>, 'steps'> & {
  steps?: Array<TeachingBriefStep | undefined>;
};

function truncateStrField(val: unknown, maxLen: number): unknown {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

export function normalizeTeachingBrief(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  obj.persona = truncateStrField(obj.persona, 80);
  obj.mentalModel = truncateStrField(obj.mentalModel, 200);
  obj.learnerTrap = truncateStrField(obj.learnerTrap, 200);
  obj.narrativeGuidelines = truncateStrField(obj.narrativeGuidelines, 300);

  if (Array.isArray(obj.pedagogicalArc)) {
    obj.pedagogicalArc = obj.pedagogicalArc.map((item) => truncateStrField(item, 120));
  }
  if (obj.mermaidStrategy && typeof obj.mermaidStrategy === 'object' && !Array.isArray(obj.mermaidStrategy)) {
    const ms = { ...(obj.mermaidStrategy as Record<string, unknown>) };
    ms.focus = truncateStrField(ms.focus, 160);
    obj.mermaidStrategy = ms;
  }
  if (Array.isArray(obj.steps)) {
    obj.steps = obj.steps.map((step) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
      const st = { ...(step as Record<string, unknown>) };
      if (typeof st.goal === 'string') {
        st.goal = st.goal.trim();
      }
      if (typeof st.layer === 'string') {
        const l = st.layer.trim().toLowerCase();
        if (l === 'mainline') st.layer = 'core';
        else if (l === 'deep-dive' || l === 'deep_dive') st.layer = 'deep';
        else st.layer = l;
      }
      if (Array.isArray(st.slotIds)) {
        st.slotIds = st.slotIds
          .map((id) => (typeof id === 'string' && /^\d+$/.test(id.trim()) ? Number(id.trim()) : id))
          .filter((id) => typeof id === 'number' && Number.isInteger(id));
      }
      return st;
    });
  }
  return obj;
}

export type MetaBriefState = 'plan' | 'arc';

const TEACHING_BRIEF_HEADER = '[AI TEACHING BRIEF & PEDAGOGICAL STRATEGY — SPECIFIC TO THIS CHAPTER]';
// Fallback guard injected if DB-hosted pedagogy_rewrite lacks the deep-dive contract.
const STALE_REWRITE_CONTRACT_GUARD = [
  'MAINLINE NARRATIVE CONTRACT (MANDATORY): Write like a teacher, not like an auditor. Explain each core mechanism in plain language FIRST and then prove it with a fenced code slot (` ```lang // [File N#anchor:core] `). Chapters with source files keep at least 2 anchored code slots on the mainline. Name at most ONE representative identifier per concept family per paragraph, never pack 3 or more identifiers into one sentence, and do NOT sprinkle inline `[File N]` handles in prose when code slots already prove the file.',
  'DEEP-DIVE BLOCK CONTRACT (MANDATORY): Secondary implementation detail (sibling helper inventories, internal state types/constants, defensive branches) goes into at most 3 collapsed blocks wrapped in <details data-layer="deep"><summary>…</summary>…</details> right after the mainline section they extend. Keep data-layer="deep" strictly literal (NEVER translate "deep"), write <summary> as a concise topic title ONLY without generic prefixes like "深入：" / "深挖：" / "进阶：" / "Deep Dive:" (the UI renders the badge), and use NO markdown headings and NO Mermaid diagrams inside.',
].join('\n');
const SLOT_MENU_HEADER = '[PRE-VALIDATED SLOT MENU — every id below is a real, already-verified code slot]';
const LESSON_PLAN_SLOTS_PER_STEP = 6;
const LESSON_PLAN_MAX_STEPS = 5;
const SLOT_MENU_MAX_FILE_INDEX = 64;
const SLOT_MENU_ANCHOR_MAX_LEN = 120;
const SLOT_MENU_VALID_ASPECTS = new Set(['core', 'contract', 'full', 'auto']);
const SLOT_MENU_LINE_RANGE_RE = /^L?(\d+)(?:-L?(\d+))?$/i;
const SLOT_MENU_SYMBOL_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

interface SlotMenuItem {
  id: number;
  fileIndex: number;
  anchor: string;
  aspect?: string;
}

function isValidSlotAnchor(anchor: string): boolean {
  if (!anchor || anchor.length > SLOT_MENU_ANCHOR_MAX_LEN) return false;
  const lineMatch = SLOT_MENU_LINE_RANGE_RE.exec(anchor);
  if (lineMatch) {
    const start = Number(lineMatch[1]);
    const end = lineMatch[2] !== undefined ? Number(lineMatch[2]) : undefined;
    if (!Number.isInteger(start) || start < 1) return false;
    if (end !== undefined && (!Number.isInteger(end) || end < start)) return false;
    return true;
  }
  return SLOT_MENU_SYMBOL_RE.test(anchor);
}

function inferMaxFileIndex(variables: Record<string, any>): number | undefined {
  if (typeof variables.fileCount === 'number' && Number.isInteger(variables.fileCount) && variables.fileCount >= 0) {
    return variables.fileCount;
  }
  if (Array.isArray(variables.files)) {
    return variables.files.length;
  }
  if (typeof variables.filesSummary === 'string' && variables.filesSummary.trim()) {
    let maxIdx = 0;
    const fileHeaderRe = /^\[File[ \t]+(\d+)\]/gm;
    let m: RegExpExecArray | null;
    while ((m = fileHeaderRe.exec(variables.filesSummary)) !== null) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > maxIdx) maxIdx = n;
    }
    if (maxIdx > 0) return maxIdx;
  }
  return undefined;
}

export function parseSlotMenu(raw: unknown, maxFileIndex?: number): SlotMenuItem[] {
  if (!Array.isArray(raw)) return [];
  const fileUpperBound =
    maxFileIndex !== undefined && Number.isInteger(maxFileIndex) && maxFileIndex >= 0
      ? Math.min(maxFileIndex, SLOT_MENU_MAX_FILE_INDEX)
      : SLOT_MENU_MAX_FILE_INDEX;
  const menu: SlotMenuItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (typeof it.id !== 'number' || !Number.isInteger(it.id) || it.id < 1) continue;
    if (
      typeof it.fileIndex !== 'number' ||
      !Number.isInteger(it.fileIndex) ||
      it.fileIndex < 1 ||
      it.fileIndex > fileUpperBound
    ) {
      continue;
    }
    if (typeof it.anchor !== 'string') continue;
    const anchor = it.anchor.trim();
    if (!isValidSlotAnchor(anchor)) continue;

    let aspect: string | undefined;
    if (it.aspect !== undefined && it.aspect !== null) {
      if (typeof it.aspect !== 'string') continue;
      const trimmedAspect = it.aspect.trim().toLowerCase();
      if (trimmedAspect) {
        if (!SLOT_MENU_VALID_ASPECTS.has(trimmedAspect)) continue;
        aspect = trimmedAspect;
      }
    }
    menu.push({ id: it.id, fileIndex: it.fileIndex, anchor, aspect });
  }
  return menu;
}

export function renderLessonPlan(
  brief: TeachingBrief,
  variables: Record<string, any>,
): { lines: string[]; slotCount: number } | null {
  const rawSteps = Array.isArray(brief.steps) ? brief.steps : [];
  const steps = rawSteps
    .filter((s): s is TeachingBriefStep => Boolean(s && typeof s.goal === 'string' && s.goal.trim().length > 0))
    .slice(0, LESSON_PLAN_MAX_STEPS);
  if (steps.length === 0) return null;
  const maxFileIndex = inferMaxFileIndex(variables);
  const byId = new Map<number, SlotMenuItem>();
  for (const item of parseSlotMenu(variables.slotMenu, maxFileIndex)) byId.set(item.id, item);

  const lines: string[] = ['- Lesson Plan (pre-validated evidence slots — copy these handles verbatim):'];
  let slotCount = 0;
  steps.forEach((step, idx) => {
    const handles: string[] = [];
    const seen = new Set<number>();
    for (const id of step.slotIds) {
      if (handles.length >= LESSON_PLAN_SLOTS_PER_STEP) break;
      const item = byId.get(id);
      if (!item || seen.has(id)) continue;
      seen.add(id);
      handles.push(`[File ${item.fileIndex}#${item.anchor}${item.aspect ? `:${item.aspect}` : ''}]`);
    }
    const layer = step.layer === 'deep' ? 'deep-dive' : 'mainline';
    const goalText = step.goal.trim().slice(0, 160);
    lines.push(`  ${idx + 1}. [${layer}] ${goalText}${handles.length > 0 ? ` — evidence: ${handles.join(', ')}` : ''}`);
    slotCount += handles.length;
  });
  return { lines, slotCount };
}

export const curriculumBlueprintSchema = z.object({
  curriculumThesis: z.string().max(160),

  repoArchetype: z.enum([
    'micro_kernel',
    'i18n_tutorial_mirror',
    'embedded_challenge',
    'doc_driven_book',
    'monorepo_matrix',
    'standard_system',
  ]),

  contentScopeDirective: z.object({
    canonicalScope: z.string().max(100),
    ignoredScopes: z.array(z.string().max(60)),
  }),

  pedagogicalPattern: z.enum([
    'single_masterclass',
    'dual_kernel_app',
    'author_curated_mirror',
    'progressive_system',
    'matrix_course_tree',
  ]),

  learnerProfile: z.object({
    archetype: z.enum([
      'architecture_overview',
      'deep_dive_internals',
      'cross_language_migrant',
      'pedagogical_beginner',
    ]),
    targetOutcome: z.string().max(140),
  }),

  cognitivePhases: z.array(
    z.object({
      phaseName: z.string().max(40),
      coreFocus: z.string().max(120),
      targetChaptersEstimate: z.number().int().min(1).max(5),
    }),
  ).min(1).max(5),

  pruningDirectives: z.object({
    spotlightModules: z.array(z.string().max(80)).min(1).max(5),
    prunedModules: z.array(z.string().max(80)).max(5),
  }),

  anchorDirectives: z.array(
    z.object({
      symbolPath: z.string().max(100),
      pedagogicalRole: z.string().max(120),
    }),
  ).max(8).optional(),

  compilerInstruction: z.string().max(300),
});

export type CurriculumBlueprint = z.infer<typeof curriculumBlueprintSchema>;

export function formatCurriculumBlueprint(brief: CurriculumBlueprint): string {
  const phasesLines = brief.cognitivePhases
    .map((p, idx) => `  ${idx + 1}. [${p.phaseName}] (预估 ${p.targetChaptersEstimate} 章): ${p.coreFocus}`)
    .join('\n');
  const spotlightLines = brief.pruningDirectives.spotlightModules
    .map((m) => `  - 重点精读/聚焦: ${m}`)
    .join('\n');
  const prunedLines = brief.pruningDirectives.prunedModules.length > 0
    ? brief.pruningDirectives.prunedModules.map((m) => `  - 坚决剪枝/过滤: ${m}`).join('\n')
    : '  - 无特定剪枝目录';
  const ignoredScopesLine = brief.contentScopeDirective.ignoredScopes.length > 0
    ? `  - 忽略/剪枝范围: ${brief.contentScopeDirective.ignoredScopes.join(', ')}`
    : '  - 忽略/剪枝范围: (无)';
  const anchorLines =
    brief.anchorDirectives && brief.anchorDirectives.length > 0
      ? brief.anchorDirectives.map((a) => `  - 关键符号锚点: \`${a.symbolPath}\` (${a.pedagogicalRole})`).join('\n')
      : '';

  return [
    '[AI CURRICULUM ARCHITECTURE BLUEPRINT & PEDAGOGICAL DESIGN]',
    `- Curriculum Thesis: ${brief.curriculumThesis}`,
    `- Repository Archetype: ${brief.repoArchetype}`,
    `- Pedagogical Pattern: ${brief.pedagogicalPattern}`,
    `- Learner Archetype: ${brief.learnerProfile.archetype} (Target Outcome: ${brief.learnerProfile.targetOutcome})`,
    `- Content Scope Directive:`,
    `  - 标准主干范围: ${brief.contentScopeDirective.canonicalScope}`,
    ignoredScopesLine,
    `- Cognitive Progression Phases:`,
    phasesLines,
    `- Module Spotlight & Pruning Directives:`,
    spotlightLines,
    prunedLines,
    ...(anchorLines ? ['- Micro-Repo / Fine-Grained Anchors:', anchorLines] : []),
    `- Compiler Instruction: ${brief.compilerInstruction}`,
  ].join('\n');
}

const outlineSamplerSchema = z.object({
  architectureArchetype: z
    .string()
    .describe('系统架构类型，例如 game_engine, compiler, web_framework, cli_tool, monorepo, library, microservice'),
  subsystemCount: z
    .number()
    .int()
    .describe('识别出的核心子系统/功能分区数量'),
  needFiles: z
    .array(z.string())
    .min(1)
    .max(25)
    .describe('AI 自主挑选的、必须获取源码 AST 以准确设计大纲的核心入口和门面文件路径列表（最多 25 个）'),
});

export const conceptEdgesSchema = z.object({
  edges: z.array(
    z.object({
      fromConcept: z.string().describe('前置/来源概念名（必须来自上方概念清单）'),
      toConcept: z.string().describe('目标概念名（必须来自上方概念清单）'),
      type: z.enum(['prerequisite', 'related', 'part_of']).describe('prerequisite=前置知识；related=相关；part_of=组成部分'),
      weight: z.number().min(0).max(1).describe('关系强度 0-1'),
      evidence: z.string().max(300).describe('从文档摘录的证据句（简短，中文）'),
    }),
  ).max(40),
});

const PURPOSES: Record<string, LlmGatewayPurpose> = {
  outline_sampler_v1: {
    kind: 'structured',
    schema: outlineSamplerSchema,
    compile: async (variables) => {
      // Empty/unknown depth, archetype, and intent omit optional rules to keep default prompts byte-clean.
      const prefix = typeof variables.prefix === 'string' && variables.prefix.trim() ? variables.prefix.trim() : '';
      const depth = typeof variables.teachingDepth === 'string' ? variables.teachingDepth.trim().toLowerCase() : '';
      const archetype = typeof variables.learnerArchetype === 'string' ? variables.learnerArchetype.trim() : '';
      const archetypeFocus = learnerArchetypeFocus(archetype);
      const { sanitizePromptText, USER_INTENT_MAX_CHARS } = await import('@/lib/prompt-safety');
      const intent = sanitizePromptText(String(variables.customPrompt ?? ''), { maxChars: USER_INTENT_MAX_CHARS }).trim();
      const compiled = await PromptRegistry.getCompiledPrompt('outline_sampler_v1', {
        skeleton: String(variables.skeleton ?? ''),
        readme: String(variables.readme ?? '').slice(0, 3000),
        prefixScopeRule: prefix
          ? `   - 本次导入作用域被限制在子卷目录: "${prefix}"，请仅在 "${prefix}" 作用域内挑选核心文件；\n`
          : '',
        teachingDepthRule:
          depth === 'overview'
            ? '   - 教学深度为 overview：优先各模块对外门面 API、程序入口与示例配置文件，过滤深层内部实现；\n'
            : depth === 'deep'
            ? '   - 教学深度为 deep：优先核心状态机、调度引擎、编译器 Pass、核心数据结构与并发控制等深层实现文件；\n'
            : '',
        archetypeRule: archetypeFocus
          ? `   - 学习者画像为 ${archetype}：${archetypeFocus}——抽样文件应支撑该叙事侧重；\n`
          : '',
        customPromptRule: intent
          ? `   - 用户侧重意图："${intent}"——允许打破跨子系统均匀配额，将抽样名额集中分配给最可能承载用户关注主题（如状态流转、核心模式、关键接口）的源码文件，减少通用胶水/入口/文档文件的配额；\n`
          : '',
      });
      return compiled.compiledPrompt;
    },
    source: 'outline-sampler',
    keyOrigin: 'user',
    priority: 'interactive',
    temperature: 0.1,
    maxTokens: 1000,
    disableThinking: true,
    timeoutMs: 5000,
  },
  mcp_concept_edges: {
    kind: 'structured',
    schema: conceptEdgesSchema,
    compile: async (variables) => {
      const compiled = await PromptRegistry.getCompiledPrompt('mcp_concept_edges', {
        conceptList: String(variables.conceptList ?? ''),
        contextText: String(variables.contextText ?? ''),
      });
      return compiled.compiledPrompt;
    },
    source: 'llm-edges',
    keyOrigin: 'user',
    priority: 'batch',
  },
  chapter_pedagogy_compiler: {
    kind: 'structured',
    schema: teachingBriefSchema,
    normalizeOutput: normalizeTeachingBrief,
    compile: async (variables) => {
      const { sanitizePromptText, USER_INTENT_MAX_CHARS } = await import('@/lib/prompt-safety');
      const architectureSkeleton = typeof variables.architectureSkeletonSection === 'string' && variables.architectureSkeletonSection.trim()
        ? variables.architectureSkeletonSection.trim()
        : '';
      const chapterIndex = variables.chapterIndex && Number(variables.chapterIndex) > 0
        ? Number(variables.chapterIndex)
        : 1;
      const totalChapters = variables.totalChapters && Number(variables.totalChapters) > 0
        ? Number(variables.totalChapters)
        : chapterIndex;
      const isFinalChapter = variables.isFinalChapter === true || String(variables.isFinalChapter).toLowerCase() === 'true' || chapterIndex >= totalChapters;
      const nextChapterTitle = typeof variables.nextChapterTitle === 'string' && variables.nextChapterTitle.trim()
        ? sanitizePromptText(variables.nextChapterTitle.trim())
        : '';
      const intent = sanitizePromptText(String(variables.customPrompt ?? ''), { maxChars: USER_INTENT_MAX_CHARS }).trim();
      const customPromptRule = intent
        ? `用户聚焦意图："${intent}"——教学大纲、叙事视角与 Mermaid 图表策略必须与该聚焦一致（如状态机专题倾向 stateDiagram-v2），严禁偏离主题铺设通用入门内容\n`
        : '';
      const slotMenuText = String(variables.slotMenuSection ?? '').trim();
      const compiled = await PromptRegistry.getCompiledPrompt('chapter_pedagogy_compiler', {
        chapterIndex,
        totalChapters,
        isFinalChapter: isFinalChapter ? 'true' : 'false',
        nextChapterTitle: nextChapterTitle || '(none - this is the final chapter)',
        chapterTitle: sanitizePromptText(String(variables.chapterTitle ?? '')),
        chapterDescription: sanitizePromptText(String(variables.chapterDescription ?? '')),
        targetLanguage: String(variables.targetLanguage ?? 'zh'),
        architectureSkeletonSection: architectureSkeleton
          ? `\n[ARCHITECTURE TOPOLOGY SKELETON (Ground Truth Call Flow & Dependencies)]\n${architectureSkeleton}\n`
          : '',
        filesSummary: String(variables.filesSummary ?? ''),
        slotMenuSection: slotMenuText,
        customPromptRule,
      });
      // Append slotMenuSection / customPromptRule deterministically when DB-hosted templates omit those placeholders.
      let promptText = compiled.compiledPrompt;
      if (slotMenuText && !promptText.includes(slotMenuText)) {
        promptText += `\n\n${SLOT_MENU_HEADER}\n${slotMenuText}\n`;
      }
      if (customPromptRule && !promptText.includes(customPromptRule)) {
        return `${promptText}\n=== 用户聚焦意图(教学叙事必须对齐) ===\n- ${customPromptRule.trim()}\n`;
      }
      return promptText;
    },
    source: 'transcription',
    keyOrigin: 'user',
    priority: 'batch',
    temperature: 0.2,
    disableThinking: true,
  },
  outline_curriculum_compiler: {
    kind: 'structured',
    schema: curriculumBlueprintSchema,
    compile: async (variables) => {
      const { sanitizePromptText, USER_INTENT_MAX_CHARS } = await import('@/lib/prompt-safety');
      const compiled = await PromptRegistry.getCompiledPrompt('outline_curriculum_compiler', {
        map: String(variables.map ?? variables.skeleton ?? ''),
        customPrompt: sanitizePromptText(String(variables.customPrompt ?? ''), { maxChars: USER_INTENT_MAX_CHARS }),
        targetLanguage: String(variables.targetLanguage ?? 'zh-CN'),
        pacing: String(variables.pacing ?? 'normal'),
        teachingDepth: String(variables.teachingDepth ?? 'standard'),
        learnerArchetype: String(variables.learnerArchetype ?? 'architecture_overview'),
      });
      return compiled.compiledPrompt;
    },
    source: 'indexer',
    keyOrigin: 'user',
    priority: 'interactive',
    temperature: 0.2,
    disableThinking: true,
  },
  code_chapter_lesson: {
    kind: 'text',
    source: 'tutor_explanation',
    keyOrigin: 'user',
    priority: 'batch',
    temperature: 0.2,
    maxTokens: 16000,
    metaCompiler: {
      metaPurpose: 'chapter_pedagogy_compiler',
      briefSchema: teachingBriefSchema,
      timeoutMs: 30000,
      shouldCompile: (variables) => {
        if (variables.skipMetaCompiler === true) return false;
        if (typeof variables.teachingBriefSection === 'string' && variables.teachingBriefSection.trim().length > 0) {
          return false;
        }
        return true;
      },
      prepareMetaVariables: (variables) => ({
        chapterIndex: variables.chapterIndex,
        totalChapters: variables.totalChapters,
        isFinalChapter: variables.isFinalChapter,
        nextChapterTitle: variables.nextChapterTitle,
        chapterTitle: variables.chapterTitle,
        chapterDescription: variables.chapterDescription,
        targetLanguage: variables.targetLanguage,
        architectureSkeletonSection: variables.architectureSkeletonSection,
        filesSummary: variables.filesSummary,
        slotMenuSection: variables.slotMenuText,
        customPrompt: variables.customPrompt,
      }),
      injectBrief: (brief: TeachingBrief | null, variables) => {
        if (!brief) {
          return {
            variables: {
              ...variables,
              teachingBriefSection: '',
            },
          };
        }
        const arcLines = brief.pedagogicalArc.map((step, idx) => `  ${idx + 1}. ${step}`).join('\n');
        const plan = renderLessonPlan(brief, variables);
        const briefBlock = [
          TEACHING_BRIEF_HEADER,
          `- Persona: ${brief.persona}`,
          `- Core Mental Model: ${brief.mentalModel}`,
          `- Pedagogical Arc:`,
          arcLines,
          `- Mermaid Diagram Strategy: Type="${brief.mermaidStrategy.diagramType}", Focus="${brief.mermaidStrategy.focus}"`,
          `- Critical Gotcha / Learner Trap: ${brief.learnerTrap}`,
          `- Narrative & Tone Guidelines: ${brief.narrativeGuidelines}`,
          ...(plan ? ['', ...plan.lines] : []),
        ].join('\n');

        return {
          variables: {
            ...variables,
            teachingBriefSection: `\n${briefBlock}\n`,
          },
          briefState: plan && plan.slotCount > 0 ? 'plan' : 'arc',
        };
      },
    },
    compile: async (variables) => {
      const { sanitizePromptText } = await import('@/lib/prompt-safety');
      const { buildStyleDirective } = await import('@/lib/transcription-presets');

      const depthRaw = typeof variables.teachingDepth === 'string' && variables.teachingDepth.trim()
        ? variables.teachingDepth.trim().toLowerCase()
        : 'standard';
      const depth = depthRaw === 'deep' ? 'deep' : depthRaw === 'overview' ? 'overview' : 'standard';
      const depthDesc = depth === 'overview'
        ? '- overview: High-level architectural focus, public APIs only, 1 Mermaid diagram.'
        : depth === 'deep'
            ? '- deep: Every core mechanism is traced through its real source (edge cases, concurrency, failure modes) with explicit design trade-off discussion and Mermaid flowcharts; sibling helper inventories, internal state types and constants are taught inside deep-dive blocks, never listed in mainline prose.'
        : '- standard: Balanced narrative with core code snippets as evidence, intuitive Mermaid architectural pipeline diagrams, key design callouts.';

      let cleanStyle = '';
      if (typeof variables.styleDirective === 'string' && variables.styleDirective.trim()) {
        cleanStyle = sanitizePromptText(variables.styleDirective.trim());
      } else if (typeof variables.stylePreset === 'string' || typeof variables.customPrompt === 'string') {
        const directive = buildStyleDirective(
          typeof variables.stylePreset === 'string' ? variables.stylePreset : null,
          typeof variables.customPrompt === 'string' ? variables.customPrompt : null,
        );
        cleanStyle = directive.trim() ? sanitizePromptText(directive.trim()) : '';
      }

      const cognitiveScaffold = typeof variables.cognitiveScaffold === 'string' && variables.cognitiveScaffold.trim()
        ? variables.cognitiveScaffold.trim()
        : '';
      const architectureSkeleton = typeof variables.architectureSkeletonSection === 'string' && variables.architectureSkeletonSection.trim()
        ? variables.architectureSkeletonSection.trim()
        : '';
      const upstreamTerminology = typeof variables.upstreamTerminologySection === 'string' && variables.upstreamTerminologySection.trim()
        ? variables.upstreamTerminologySection.trim()
        : '';
      const groundingFeedback = typeof variables.groundingFeedback === 'string' && variables.groundingFeedback.trim()
        ? variables.groundingFeedback.trim()
        : '';

      const moduleDirectories = Array.isArray(variables.moduleDirectories)
        ? variables.moduleDirectories.join(', ')
        : (typeof variables.moduleDirectories === 'string' ? variables.moduleDirectories : '');

      const targetLang = typeof variables.targetLanguage === 'string' && variables.targetLanguage.trim()
        ? variables.targetLanguage.trim()
        : 'zh';

      const chapterIndex = variables.chapterIndex && Number(variables.chapterIndex) > 0
        ? Number(variables.chapterIndex)
        : 1;
      const totalChapters = variables.totalChapters && Number(variables.totalChapters) > 0
        ? Number(variables.totalChapters)
        : chapterIndex;
      const isFinalChapter = variables.isFinalChapter === true || String(variables.isFinalChapter).toLowerCase() === 'true' || chapterIndex >= totalChapters;
      const nextChapterTitle = typeof variables.nextChapterTitle === 'string' && variables.nextChapterTitle.trim()
        ? sanitizePromptText(variables.nextChapterTitle.trim())
        : '';

      const chapterOutline = typeof variables.chapterOutlineSection === 'string' && variables.chapterOutlineSection.trim()
        ? sanitizePromptText(variables.chapterOutlineSection.trim())
        : '';

      const compiled = await PromptRegistry.getCompiledPrompt('pedagogy_rewrite', {
        chapterIndex,
        totalChapters,
        isFinalChapter: isFinalChapter ? 'true' : 'false',
        nextChapterTitle: nextChapterTitle || '(none - this is the final chapter)',
        chapterTitle: sanitizePromptText(String(variables.chapterTitle ?? '')),
        chapterDescription: sanitizePromptText(String(variables.chapterDescription ?? '')),
        targetLanguage: targetLang,
        teachingDepth: depth.toUpperCase(),
        teachingDepthDescription: depthDesc,
        teachingBriefSection: typeof variables.teachingBriefSection === 'string' ? variables.teachingBriefSection : '',
        styleSection: cleanStyle ? `\n[TRANSCRIPTION STYLE]\n${cleanStyle}` : '',
        moduleDirectories: moduleDirectories || '(repository root)',
        cognitiveScaffoldSection: cognitiveScaffold ? `\n${cognitiveScaffold}\n` : '',
        architectureSkeletonSection: architectureSkeleton
          ? `\n[ARCHITECTURE TOPOLOGY SKELETON (Ground Truth Call Flow & Dependencies)]\n${architectureSkeleton}\n`
          : '',
        upstreamTerminologySection: upstreamTerminology ? `\n${upstreamTerminology}\n` : '',
        chapterOutlineSection: chapterOutline ? `\n${chapterOutline}\n` : '',
        groundingFeedbackSection: groundingFeedback ? `\n[FACT-GROUNDING CORRECTIONS — MANDATORY]\n${groundingFeedback}\n` : '',
        filesSummary: String(variables.filesSummary ?? '') || '(no source files excerpted — describe the module from its directory structure)',
      });
      // Append teachingBriefSection / deep-dive guard deterministically if stale DB templates omit placeholders.
      const briefSection = typeof variables.teachingBriefSection === 'string' ? variables.teachingBriefSection : '';
      let promptText = compiled.compiledPrompt;
      if (briefSection.includes(TEACHING_BRIEF_HEADER) && !promptText.includes(TEACHING_BRIEF_HEADER)) {
        promptText += `\n${briefSection}\n`;
      }
      if (!promptText.includes('DEEP-DIVE BLOCK CONTRACT') && !promptText.includes('data-layer="deep"')) {
        promptText += `\n${STALE_REWRITE_CONTRACT_GUARD}\n`;
      }
      return promptText;
    },
  },
  code_slot_repair: {
    kind: 'text',
    compile: async (variables) => {
      const compiled = await PromptRegistry.getCompiledPrompt('code_slot_repair', {
        slotsContext: String(variables.slotsContext ?? ''),
        fileMenu: String(variables.fileMenu ?? ''),
      });
      return compiled.compiledPrompt;
    },
    source: 'tutor_explanation',
    keyOrigin: 'user',
    priority: 'batch',
    temperature: 0.0,
    maxTokens: 1200,
  },
  book_final_audit: {
    kind: 'text',
    compile: async (variables) => {
      const { sanitizePromptText } = await import('@/lib/prompt-safety');
      const compiled = await PromptRegistry.getCompiledPrompt('book_final_audit', {
        chapterOutline: sanitizePromptText(String(variables.chapterOutline ?? '')),
        chaptersDigest: String(variables.chaptersDigest ?? ''),
      });
      return compiled.compiledPrompt;
    },
    source: 'tutor_explanation',
    keyOrigin: 'user',
    priority: 'batch',
    temperature: 0.0,
    maxTokens: 2000,
  },
  chapter_intro_repair: {
    kind: 'text',
    compile: async (variables) => {
      const { sanitizePromptText } = await import('@/lib/prompt-safety');
      const compiled = await PromptRegistry.getCompiledPrompt('chapter_intro_repair', {
        chapterOutline: sanitizePromptText(String(variables.chapterOutline ?? '')),
        chapterTitle: sanitizePromptText(String(variables.chapterTitle ?? '')),
        chapterIndex: String(variables.chapterIndex ?? '1'),
        totalChapters: String(variables.totalChapters ?? '1'),
        introSection: String(variables.introSection ?? ''),
        fixHint: String(variables.fixHint ?? ''),
        targetLanguage: String(variables.targetLanguage ?? 'zh'),
      });
      return compiled.compiledPrompt;
    },
    source: 'tutor_explanation',
    keyOrigin: 'user',
    priority: 'batch',
    temperature: 0.2,
    maxTokens: 3000,
  },
  chapter_code_enrich: {
    kind: 'text',
    compile: async (variables) => {
      const compiled = await PromptRegistry.getCompiledPrompt('chapter_code_enrich', {
        fileMenu: String(variables.fileMenu ?? ''),
        sectionTitles: String(variables.sectionTitles ?? ''),
        fixHint: String(variables.fixHint ?? ''),
      });
      return compiled.compiledPrompt;
    },
    source: 'tutor_explanation',
    keyOrigin: 'user',
    priority: 'batch',
    temperature: 0.0,
    maxTokens: 1500,
  },
  doc_transcribe_enhance_localize: {
    kind: 'text',
    compile: async (variables) => {
      const { buildStyleDirective } = await import('@/lib/transcription-presets');
      const { sanitizePromptText } = await import('@/lib/prompt-safety');
      const stylePreset = typeof variables.stylePreset === 'string' ? variables.stylePreset : null;
      const customPrompt = typeof variables.customPrompt === 'string' ? variables.customPrompt.trim() : '';
      const directive = buildStyleDirective(stylePreset);
      const styleInstruction = directive.trim()
        ? `\nUSER TRANSCRIPTION STYLE (refine tone and presentation only; never violate the integrity and format rules above):\n${sanitizePromptText(directive.trim())}\n`
        : '';
      const customInstruction = customPrompt
        ? `\nUSER CUSTOM INSTRUCTION: ${sanitizePromptText(customPrompt)}\nYou MUST follow this instruction during enhancement and localization.`
        : '';
      const compiled = await PromptRegistry.getCompiledPrompt('mdx_enhance_localize', {
        targetLanguage: String(variables.targetLanguage ?? ''),
        condensationMode: String(variables.condensationMode ?? 'balanced'),
        styleInstruction,
        customInstruction,
        content: String(variables.content ?? ''),
      });
      return compiled.compiledPrompt;
    },
    source: 'transcription',
    keyOrigin: 'user',
    priority: 'batch',
    temperature: 0.1,
    maxTokens: 16000,
  },
  doc_translate: {
    kind: 'text',
    compile: async (variables) => {
      const customPrompt = typeof variables.customPrompt === 'string' ? variables.customPrompt.trim() : '';
      const customInstruction = customPrompt
        ? `\nUSER CUSTOM INSTRUCTION: ${customPrompt}\nYou MUST follow this instruction during translation.`
        : '';
      const compiled = await PromptRegistry.getCompiledPrompt('markdown_document_translation', {
        targetLanguage: String(variables.targetLanguage ?? ''),
        customInstruction,
        content: String(variables.content ?? ''),
      });
      return compiled.compiledPrompt;
    },
    source: 'transcription',
    keyOrigin: 'user',
    priority: 'batch',
    temperature: 0.1,
    maxTokens: 8000,
  },
  doc_translation_sample: {
    kind: 'text',
    compile: async (variables) => {
      const compiled = await PromptRegistry.getCompiledPrompt('doc_translation_sample', {
        targetLanguage: String(variables.targetLanguage ?? 'Chinese'),
        snippet: String(variables.snippet ?? ''),
      });
      return compiled.compiledPrompt;
    },
    source: 'transcription',
    keyOrigin: 'user',
    priority: 'interactive',
    temperature: 0,
    maxTokens: 30,
    disableThinking: true,
  },
  relay_transcription: {
    kind: 'structured',
    schema: RelayTranscriptionSchema,
    compile: async (variables) => {
      const compiled = await PromptRegistry.getCompiledPrompt('relay_transcription_envelope', {
        targetLanguage: String(variables.targetLanguage || '中文'),
        path: String(variables.path ?? ''),
        glossarySection: String(variables.glossarySection ?? ''),
        sourceRaw: String(variables.sourceRaw ?? ''),
      });
      return compiled.compiledPrompt;
    },
    source: 'transcription',
    keyOrigin: 'user',
    priority: 'batch',
    temperature: 0,
  },
  doc_enhance: {
    kind: 'text',
    compile: async (variables) => {
      const { buildStyleDirective } = await import('@/lib/transcription-presets');
      const { sanitizePromptText } = await import('@/lib/prompt-safety');
      const directive = buildStyleDirective(
        typeof variables.stylePreset === 'string' ? variables.stylePreset : null,
        typeof variables.customPrompt === 'string' ? variables.customPrompt : null,
      );
      const styleInstruction = directive.trim()
        ? `\nUSER TRANSCRIPTION STYLE (refine tone and presentation only; never violate the integrity and format rules above):\n${sanitizePromptText(directive.trim())}\n`
        : '';
      const compiled = await PromptRegistry.getCompiledPrompt('mdx_enhancer', {
        condensationMode: String(variables.condensationMode ?? 'balanced'),
        styleInstruction,
        content: String(variables.content ?? ''),
      });
      return compiled.compiledPrompt;
    },
    source: 'transcription',
    keyOrigin: 'user',
    priority: 'batch',
    temperature: 0.1,
    maxTokens: 8000,
  },
  mdx_repair: {
    kind: 'text',
    compile: async (variables) => {
      const compiled = await PromptRegistry.getCompiledPrompt('mdx_repair', {
        compileError: String(variables.compileError ?? ''),
        mdxSource: String(variables.mdxSource ?? ''),
      });
      return compiled.compiledPrompt;
    },
    source: 'mdx-repair',
    keyOrigin: 'user',
    priority: 'batch',
    temperature: 0.0,
    maxTokens: 16000,
  },
  mermaid_resilience: {
    kind: 'text',
    compile: async (variables) => {
      const raw = String(variables.rawMermaid ?? variables.mermaidCode ?? '');
      const compiled = await PromptRegistry.getCompiledPrompt('mermaid_resilience', {
        rawMermaid: raw,
        mermaidCode: raw,
      });
      return compiled.compiledPrompt;
    },
    source: 'mermaid-resilience',
    keyOrigin: 'user',
    priority: 'interactive',
    temperature: 0.1,
    maxTokens: 2000,
  },
  chapter_map: {
    kind: 'structured',
    schema: chapterMapSchema,
    compile: async (variables) => {
      const compiled = await PromptRegistry.getCompiledPrompt('chapter_map_builder', {
        owner: String(variables.owner ?? ''),
        repo: String(variables.repo ?? ''),
        textRoot: String(variables.textRoot ?? '(repository root)'),
        docFiles: JSON.stringify(variables.docFiles ?? []),
        codeFiles: JSON.stringify(variables.codeFiles ?? []),
      });
      return compiled.compiledPrompt;
    },
    source: 'indexer',
    keyOrigin: 'user',
    priority: 'interactive',
  },
  // Zod enforces shape only; Go sidecar validates real file paths against the repo tree.
  outline_map_v1: {
    kind: 'structured',
    normalizeOutput: normalizeOutlineMap,
    schema: z.object({
      chapters: z
        .array(
          z.object({
            name: z.string().min(1).max(100).describe('章节名称，严控 35 字以内 (<= 35 chars, en <= 60 chars)，必须通俗易懂且结合具体代码机制，严禁包含 .py/.ts 等文件扩展名，严禁末尾括号罗列符号，严禁使用门面契约/领域模型等抽象套话，严禁出现 subsystem/topology/layer/hot 等内部拓扑与热度指标词'),
            summary: z.string().max(250).describe('本章核心设计动机与教学意图，严控 50 字以内 (<= 50 chars, en <= 80 chars)，一句话说明教学意图'),
            files: z.array(z.string()).min(1),
            partTitle: z.string().max(100).optional().describe('所属教学分卷/模块大标题，自适应结合项目业务角色（如“偏好数据集与加载管线”），严禁使用维度1/维度2等机械套话，严禁携带 Part 1/第 N 卷 等序数前缀（系统按首现次序自动编号），相邻同类章节必须共用同一分卷名').catch(undefined),
            phase: z.string(),
          }),
        )
        .min(1)
        .max(14),
    }),
    metaCompiler: {
      metaPurpose: 'outline_curriculum_compiler',
      briefSchema: curriculumBlueprintSchema,
      timeoutMs: 6000,
      shouldCompile: (variables) => {
        if (variables.skipMetaCompiler === true) return false;
        if (
          typeof variables.curriculumBlueprintSection === 'string' &&
          variables.curriculumBlueprintSection.trim().length > 0
        ) {
          return false;
        }
        return true;
      },
      prepareMetaVariables: (variables) => ({
        map: variables.map,
        customPrompt: variables.customPrompt,
        targetLanguage: variables.targetLanguage,
        pacing: variables.pacing,
        teachingDepth: variables.teachingDepth,
        learnerArchetype: variables.learnerArchetype,
      }),
      injectBrief: (brief: CurriculumBlueprint | null, variables) => {
        if (!brief) {
          return {
            variables: {
              ...variables,
              curriculumBlueprintSection: '',
            },
          };
        }
        return {
          variables: {
            ...variables,
            curriculumBlueprintSection: `\n${formatCurriculumBlueprint(brief)}\n`,
          },
        };
      },
    },
    compile: async (variables) => {
      const { assembleSandwichDirective, sanitizePromptText } = await import('@/lib/prompt-safety');
      const map = String(variables.map ?? '');
      const targetLanguage = String(variables.targetLanguage ?? '') || 'zh-CN';
      const customPrompt = String(variables.customPrompt ?? '').trim();
      const hasIntent = customPrompt.length > 0;
      const previousOutline = hasIntent
        ? sanitizePromptText(String(variables.previousOutline ?? ''), { maxChars: 2000 }).trim()
        : '';
      const depth = normalizeTeachingDepth(variables.teachingDepth);
      const blueprintSection =
        typeof variables.curriculumBlueprintSection === 'string' && variables.curriculumBlueprintSection.trim()
          ? variables.curriculumBlueprintSection.trim()
          : '';
      const coverageFeedback = String(variables.coverageFeedback ?? '').trim();
      const archetypeFocus = learnerArchetypeFocus(variables.learnerArchetype);

      const chapterBand = depth === 'overview' ? '3-6' : depth === 'deep' ? '10-14' : '5-10';
      const fileBand = depth === 'overview' ? '2-3' : depth === 'deep' ? '4-6' : '3-5';
      const depthStrategy =
        depth === 'overview'
          ? `简单模式（overview）：紧凑主干，以全局全貌、主链路与快速上手为主；每章 files 只精选 ${fileBand} 个门面与契约文件（程序入口、公共接口/类型定义、README），过滤深层内部实现与算法细节`
          : depth === 'deep'
          ? `困难模式（deep）：垂直深潜；每章 files 放宽至 ${fileBand} 个，允许下潜底层实现——算法细节、锁与并发原语、边界防御与错误处理、spec 规格验证文件`
          : `默认模式（standard）：循序渐进，设计动机与实现并重；每章 files 精选 ${fileBand} 个高 hotness 的核心业务流文件（管道与调度核心）`;

      const partBand = depth === 'overview' ? '1~2' : depth === 'deep' ? '3~5' : '2~4';

      const lines = [
        '你是资深技术课程架构师。下面是一个代码仓库的子系统多尺度地图（Subsystem Topology Map）与 AST 拓扑目录，已按物理依赖拓扑组织：',
        '- 子系统全景：每个核心子系统一行紧凑统计（子系统名 | 路径 | 文件数 | 代码行数 | 主语言）；',
        '- 跨子系统依赖：由 AST 调用/导入边聚合的跨模块调用关系（from -> to，附高频符号或权重）；',
        '- 子系统核心锚点：各子系统按教学深度加权挑选的 Top-K 代表文件（path | loc | hot | layer | exports）；微型仓库模式下为完整目录表与细粒度符号锚点清单（path#anchor）。',
        '',
        '任务：依据子系统全景（Subsystem Topology）、跨模块调用依赖与各模块核心文件/导出符号，规划一部面向人类读者的教程大纲（结构清晰，传神精炼）。',
        ...(archetypeFocus ? [`学习者画像叙事侧重（必须贯穿章节规划与行文视角）：${archetypeFocus}。`] : []),
        '1. 依据认知规律与技术原理规划章节：整仓通常规划 5-10 章（简单模式 3-6 章，困难模式 10-14 章），循序渐进；' +
          '但章节数量必须与代码物理体量强对齐：若为微内核仓库（micro-repo mode）或架构蓝图明确指定范式时，严格遵循范式章数（single_masterclass 为 1 章，dual_kernel_app 为 2 章），严禁机械套用多章规则！' +
          `分卷聚类同理与体量强对齐：常规仓库聚合为 ${partBand} 个高内聚分卷（相邻同类章节归入同一 partTitle，严禁逐章一切一卷，严禁同名分卷交错断续）；` +
          '微内核范式下 single_masterclass 单章大师课不设分卷（省略 partTitle），dual_kernel_app 至多 2 卷（内核原理 + 应用实战）！',
        ...(hasIntent
          ? [
              '专题聚焦放行（thematic）: 若用户围栏意图聚焦特定子域或模块，排除无关子系统的同时必须将释放的章节配额重新投入目标域的垂直机制拆解——除非用户明确要求极简速通或仓库为微内核，否则不得简单删成 2~3 章残缺骨架，应重新规划为完整清晰的递进大纲；',
            ]
          : []),
        '2. 通俗易懂与直击机制（认知单元 ≠ 物理文件，杜绝学术八股）：\n' +
          '  - 【严禁内部维度词汇】严禁直接使用“门面契约”、“领域模型”、“核心执行引擎”、“特化算法”、“规范约束”等架构分类套话作为章节标题！严禁把上方地图的内部指标词带入章节标题（subsystem/topology/layer/hot 等内部拓扑与热度术语，读者不可见）；分卷 partTitle 必须采用工程师业务语境命名（如“智能路由与门面调度”、“偏好数据集与输入预处理”），且严禁携带 Part 1/维度 1/第 N 卷 等序数前缀（系统按首现次序自动编号）；章节标题必须采用工程师日常交流的直观语言，直击具体业务角色与工作机制（如“智能路由分流”、“网络寻址与缓冲区”、“实例状态控制”）；\n' +
          '  - 【严禁末尾括号堆砌符号】严禁在章节名称末尾使用括号罗列符号清单（反例：`第 1 章: 门面契约与域名匹配体系 (Domain、NewDomain 与 matcherset)` ✗，`第 4 章: 核心执行引擎: 命令框架 (Command、errors)` ✗）；\n' +
          '  - 【符号自然融入技术陈述】提取到的核心代码符号必须作为主语或宾语自然融入技术陈述，阐明具体机制（正例：`第 1 章: 智能路由分流：基于 matcherset 的域名匹配机制` ✓，`第 2 章: 高效网络寻址：Address、Port 与 multi_buffer 内存管理` ✓）；若核心文件为脚本或工具（如 train.py, utils.py），必须提炼其业务职责与设计模式（如「训练流程主循环与评估调度」、「分布式通信与辅助工具集」）；严禁直接在章节名称中拼接物理文件名，严禁出现任何代码文件扩展名后缀（如 .py, .ts, .js, .go, .rs, .java, .cpp 等）；',
        '3. 认知粒度守恒与三大物理定律（CRITICAL & MANDATORY）：\n' +
          '  - 【定律一：强内聚原子闭包律 (Atomic Cohesion)】同一物理文件内且总代码量小于 200 行的算法微内核（如标量数据结构 Value 与 backward 逆向求导引擎），物理上属于同一个不可分割的原子整体，必须聚合在同一个章节内完成推导闭环，严禁为了凑章节数跨章拆分！\n' +
          '  - 【定律二：认知物理密度守恒律 (Cognitive Density)】单个代码符号行数小于 30 行的微构件（如标注为 micro-component 或只有 10~20 行的代码结构，如 Neuron/Layer/MLP），严禁为每个符号单独开设 1 节课时！必须作为组合构件合并在同一个课时内以“分层组合”方式教学（一个课时覆盖多个微构件）；\n' +
          '  - 【定律三：前言体积等比律 (Proportional Preamble)】若仓库仅有简短 README（<100行）且无独立 docs/ 目录，严禁单独开设独立的全景大章，必须作为第 1 章的引子或第一课时切入，杜绝概念注水。\n' +
          '  - 【微内核范式死锁】当目录表顶部包含 (micro-repo mode: fine-grained anchors enabled) 时，仓库为高度凝练的核心算法/极简组件库（如 micrograd、mitt 等），必须借助目录表中的符号锚点（path#anchor）保证完整符号覆盖与深度教学，但必须遵循上述三大物理定律合并教学；章节规划自适应遵循下方架构蓝图指令：当教学编排范式为 single_masterclass 时，规划为 1 个高度凝聚的大师课深度专章；为 dual_kernel_app 时规划为 2 章（微内核原理 + 应用实战/模型训练），严禁违背代码体量强行拆分成 3 章及以上！为 author_curated_mirror 时严格对齐原作者目录脉络；常规多模块或标准仓库规划 3~8 个循序渐进章节，严禁违背代码体量强行拆分或粗暴压缩；',
        `4. ${depthStrategy}（每章 files 必须严格使用下方模型中列出的真实代表文件或符号锚点 path#anchor，在微型库模式下若提供微型库符号锚点优先使用；禁止编造不存在的路径）；`,
        '5. 极度紧凑精炼（CRITICAL）：章节名称 name 严控在 35 字以内（英文 <= 60 chars）；本章摘要 summary 严控在 50 字以内（英文 <= 80 chars，仅陈述核心教学意图，严禁展开具体实现细节或撰写长篇小作文）；',
        '6. 每章标注 phase（入门 | 进阶 | 实战）；',
        ...(blueprintSection
          ? [
              '7. 导师级蓝图遵从（CRITICAL）：章节规划遵循下方架构蓝图指令；若提供微型库符号锚点，files 中必须引用相应符号；当教学范式为 single_masterclass 时输出 1 章，dual_kernel_app 时输出 2 章，严禁违背蓝图强行拆分（严禁为 micro_kernel 输出 3 章及以上）；author_curated_mirror 时对齐原作者目录，严禁违背蓝图强行拆分或合并；',
              `8. 全部文字使用 ${targetLanguage}；直接输出 JSON，无任何思考过程或多余说明，结构如下：`,
            ]
          : [`7. 全部文字使用 ${targetLanguage}；直接输出 JSON，无任何思考过程或多余说明，结构如下：`]),
      ];
      // Only inject thematic example when customPrompt is non-empty; empty-intent output remains byte-identical.
      lines.push(
        hasIntent
          ? '{"chapters":[{"name":"第 1 章: 会话建立与令牌刷新的状态流转","summary":"剖析会话状态迁移与刷新边界","files":["模型中的真实代表文件或 path#anchor"],"partTitle":"会话状态机与令牌生命周期","phase":"进阶"}]}'
          : '{"chapters":[{"name":"第 1 章: 智能路由分流：基于 matcherset 的域名匹配机制","summary":"剖析域名解析与路由匹配算法设计","files":["模型中的真实代表文件或 path#anchor"],"partTitle":"智能路由与门面调度","phase":"入门"}]}',
      );
      if (blueprintSection) {
        lines.push('');
        lines.push(blueprintSection);
      }
      lines.push('');
      lines.push('=== 仓库架构全景（子系统多尺度地图） ===');
      lines.push(map);
      if (coverageFeedback) {
        lines.push('');
        lines.push('=== 覆盖率缺口反馈（必须补齐） ===');
        lines.push(coverageFeedback);
        lines.push('要求：上述遗漏的核心子系统必须被章节覆盖——增补新章节或在既有章节的 files 中补入其推荐核心文件（真实路径，禁止编造），确保遗漏子系统至少被一个章节覆盖；其余章节结构保持稳定，仅做必要微调。');
      }
      if (hasIntent && previousOutline) {
        lines.push('');
        lines.push('=== 上一版大纲参考坐标（仅用于解析章节号指代，严禁在此基础上简单删减剩余） ===');
        lines.push(previousOutline);
        lines.push('坐标解析与重构规则：若用户意图提及“第 X 章”，先对照上方参考坐标还原其真实源码路径与主题，剔除被移除内容，再围绕目标主题重新规划完整的多章递进大纲。');
      }
      const sandwich = assembleSandwichDirective(customPrompt, '资深技术课程架构师', [
        `必须且仅能使用 ${targetLanguage} 输出全部文字（语言契约）`,
        '直接输出纯 JSON 对象（格式死锁）：无思考过程、无解释、无 markdown 围栏',
        'files 中的路径必须逐字来自上述子系统多尺度地图：虚构路径一票否决，RealPaths 求交装甲会静默剔除任何幻觉路径',
        '章节名称必须是通俗易懂的技术机制或业务角色，严禁出现“门面契约/领域模型”等抽象套话，严禁出现 subsystem/topology/layer/hot 等内部拓扑与热度指标词，严禁末尾带括号罗列符号清单 (A、B 与 C)，严禁出现 .py/.ts/.go 等代码文件扩展名',
        '若沙盒意图含时间预算（如「一天看完」「浓缩为 N 课时」），以该预算压制章节数（极速通关最低可至 1 核心章）',
        '若沙盒意图指定侧重目录，优先将其置于前序核心章节',
        '专题聚焦重构：若围栏意图聚焦特定主题，排除无关子系统的同时把章节配额重新投入目标域的机制拆解；除非用户明确要求极简速通或仓库属于微内核，否则不得简单删减成 2~3 章残缺大纲',
      ]);
      if (sandwich) {
        lines.push('');
        lines.push(sandwich);
      }
      return lines.join('\n');
    },
    source: 'outline-map',
    keyOrigin: 'user',
    priority: 'interactive',
    temperature: 0.3,
    maxTokens: 1000,
    disableThinking: true,
    // Ceiling above Go caller ctx timeout (10-90s); aborts only hung streams.
    timeoutMs: 95_000,
  },
  outline_plan_v1: {
    kind: 'structured',
    normalizeOutput: normalizeOutlinePlan,
    schema: z.object({
      intentMode: z
        .enum(['full_repo', 'thematic_slice'])
        .optional()
        .describe(
          '本次编排意图模式（由模型依据用户围栏意图语义判定）: full_repo=全仓视角微调; thematic_slice=横切专题切片',
        ),
      curriculumMode: z.enum(['single', 'matrix']).optional(),
      chapters: z
        .array(
          z
            .object({
              moduleTitle: z
                .string()
                .min(1)
                .max(120)
                .describe(
                  '所属模块标题，格式必须为“模块 N: [模块主题]”。根据顶层子系统的自然边界进行模块划分（小型系统通常 2~3 个模块，大型/多包系统通常 3~6 个模块，同一模块可包含多个连续章节）',
                ),
              name: z.string().min(1).max(100).describe('章节名称，严控 35 字以内 (<= 35 chars, en <= 60 chars)，必须通俗易懂直击工程机制，严禁包含 .py/.ts/.go 等代码文件扩展名，严禁末尾括号罗列符号，严禁使用抽象架构分类词'),
              summary: z.string().max(250).describe('本章核心教学意图与模块职责，严控 60 字以内 (<= 60 chars, en <= 100 chars)'),
              targetPaths: z
                .array(z.string())
                .max(4)
                .optional()
                .describe('骨架缩进子分区路径（≤4 个,逐字复制骨架行标识）; thematic_slice 模式允许为空数组改由 focusFiles 承载'),
              focusFiles: z
                .array(z.string())
                .max(8)
                .optional()
                .describe(
                  '可选: 本章核心符号/文件路径清单（仅 thematic_slice 输出,每章 ≤8 个,必须逐字来自骨架符号索引/文件清单; full_repo 严禁输出该字段）',
                ),
              phase: z.string(),
              drillDown: z.boolean().optional(),
            })
            .superRefine((ch, ctx) => {
              if ((ch.targetPaths?.length ?? 0) === 0 && (ch.focusFiles?.length ?? 0) === 0) {
                ctx.addIssue({
                  code: 'custom',
                  message: '每章 targetPaths 与 focusFiles 至少一项非空(targetPaths ≤ 4 个, focusFiles ≤ 8 个)',
                });
              }
            }),
        )
        .min(1)
        .max(14),
      needRollup: z
        .array(z.string().min(1))
        .max(10)
        .optional()
        .describe('可选:需要补充一层子树骨架才能规划好的分区路径(仅前 3 个会被采纳,超出部分忽略);无需补充则省略该字段'),
    }),
    metaCompiler: {
      metaPurpose: 'outline_curriculum_compiler',
      briefSchema: curriculumBlueprintSchema,
      timeoutMs: 6000,
      shouldCompile: (variables) => {
        if (variables.skipMetaCompiler === true) return false;
        if (
          typeof variables.curriculumBlueprintSection === 'string' &&
          variables.curriculumBlueprintSection.trim().length > 0
        ) {
          return false;
        }
        return true;
      },
      prepareMetaVariables: (variables) => ({
        map: variables.skeleton ?? variables.map,
        skeleton: variables.skeleton,
        customPrompt: variables.customPrompt,
        targetLanguage: variables.targetLanguage,
        pacing: variables.pacing,
        teachingDepth: variables.teachingDepth,
        learnerArchetype: variables.learnerArchetype,
      }),
      injectBrief: (brief: CurriculumBlueprint | null, variables) => {
        if (!brief) {
          return {
            variables: {
              ...variables,
              curriculumBlueprintSection: '',
            },
          };
        }
        return {
          variables: {
            ...variables,
            curriculumBlueprintSection: `\n${formatCurriculumBlueprint(brief)}\n`,
          },
        };
      },
    },
    compile: async (variables) => {
      const { assembleSandwichDirective, sanitizePromptText } = await import('@/lib/prompt-safety');
      const skeleton = String(variables.skeleton ?? '');
      const targetLanguage = String(variables.targetLanguage ?? '') || 'zh-CN';
      const pacing = String(variables.pacing ?? '').trim();
      const depth = normalizeTeachingDepth(variables.teachingDepth);
      const customPrompt = String(variables.customPrompt ?? '').trim();
      const hasIntent = customPrompt.length > 0;
      const previousOutline = hasIntent
        ? sanitizePromptText(String(variables.previousOutline ?? ''), { maxChars: 2000 }).trim()
        : '';
      const planFeedback = String(variables.planFeedback ?? '').trim();
      const rollups = (variables.rollups ?? {}) as Record<string, string>;
      const archetypeFocus = learnerArchetypeFocus(variables.learnerArchetype);
      const blueprintSection =
        typeof variables.curriculumBlueprintSection === 'string' && variables.curriculumBlueprintSection.trim()
          ? variables.curriculumBlueprintSection.trim()
          : '';

      // Explicit pacing overrides depth when selecting chapter count bounds.
      let maxChapters = Number(variables.maxChapters ?? 10) || 10;
      const chapterGuidance =
        pacing === 'compact'
          ? '紧凑主干,通常 5-7 章'
          : pacing === 'detailed'
          ? '详尽展开,通常 11-14 章'
          : depth === 'overview'
          ? '紧凑主干,通常 3-6 章,以全局全貌、主链路与快速上手为主'
          : depth === 'deep'
          ? '深潜矩阵,通常 10-14 章,垂直拆解各子系统(内容不足时据实收敛)'
          : '循序渐进,通常 7-10 章';
      if (pacing === 'compact') maxChapters = 6;
      else if (pacing === 'detailed') maxChapters = 14;
      else if (depth === 'overview') maxChapters = Math.min(maxChapters, 6);
      else if (depth === 'deep') maxChapters = Math.max(maxChapters, 12);

      const drillGuidance =
        depth === 'overview'
          ? '所有章节 drillDown 一律 false——即使目标模块庞大,也只在总览中概括其职责与入口,不拆子课程'
          : depth === 'deep'
          ? '对复杂或高 hot 分区优先设置 drillDown: true 拆出子课程深潜;只在总览中提及的简单分区才设 drillDown: false'
          : '如果其目标模块过于庞大或复杂，值得深挖出一个独立的子课程，则设置 drillDown: true；如果目标模块简单，只需在总览中提及，则设置 drillDown: false';

      const lines = [
        '你是资深技术教程架构师。下面是一个大代码仓库的目录骨架图:每行一个目录分区,',
        '包含文件数(files)、代码行数(loc)、热度(hot = 子树内文件被其他文件调用的程度)与语言分布。',
        '',
        '任务:依据骨架图为整个仓库规划一部教程大纲。你需要作为课程架构师判断：',
        'A. curriculumMode: 该仓库是适合作为一个统一的单一课程(single)教学，还是适合作为一个多课程矩阵(matrix)教学？对于中型以上项目，通常选择 matrix。',
        `B. chapters: 规划具体章节（只定章节与教学意图,不选具体文件）。对于每个章节，${drillGuidance}。`,
        ...(hasIntent
          ? [
              '意图分流（intentMode，CRITICAL）: 先依据下方 <<<USER_INTENT_SANDBOX>>> 围栏内用户意图的语义判定本次作用域模式，并在输出 JSON 顶层给出 intentMode 字段：',
              '- 意图聚焦某个特定领域/子系统/机制，或明确要求排除无关模块/章节 → intentMode = "thematic_slice"（目标域独立重构）；',
              '- 意图为全仓通读、系统全景或未表达作用域聚焦 → intentMode = "full_repo"（全仓视角微调）；',
              '注意：thematic_slice 仅控制作用域边界（允许过滤无关目录），绝不意味着要把完整课程压缩成 2~3 章小碎片！严禁凭猜测判定，判定唯一依据是用户围栏意图的语义；',
            ]
          : []),
        ...(archetypeFocus ? [`学习者画像叙事侧重(必须贯穿章节规划与叙事): ${archetypeFocus}。`] : []),
        '',
        '要求:',
        ...(hasIntent
          ? [
              '1. 认知模块划分随意图分流: full_repo 时全书划分为 2~4 个认知模块（moduleTitle），格式统一为“模块 N: [模块主题]”（例如“模块 1: 架构全景与环境准备”）;thematic_slice（目标域独立重构）时围绕用户保留与深化的目标域重新划分 2~4 个递进式认知模块（按启动链路/入口结构→核心机制/状态抽象→编排/协议→子场景实战递进；仅当目标域本身是单一微组件时允许 1 个模块），严禁包含用户明确移除的模块，也严禁在目标域之外编造无关全仓凑数章;',
              `2. 体量守恒与深化重排（CRITICAL）: full_repo 时${chapterGuidance},最多 ${maxChapters} 章,从上手到进阶到实战,循序渐进;thematic_slice 时除非用户明确选定紧凑篇幅或要求“浓缩为 N 章/一天速通”，否则严禁在旧大纲基础上只删减剩余 2~3 章！必须将排除无关模块后释放的章节配额重新投入到用户保留与深化的核心主题中（${chapterGuidance}，常规重构通常规划 5~9 章，含深入剖析/源码解析/多示例拆解时规划 7~12 章，最多 ${maxChapters} 章，受目标作用域内真实文件与机制密度约束），按启动链路、底层设计、任务编排、工具调用、消息流转与典型子应用分别独立成章;`,
            ]
          : [
              '1. 全书必须划分为 2~4 个认知模块（moduleTitle），格式统一为“模块 N: [模块主题]”（例如“模块 1: 架构全景与环境准备”）；',
              `2. ${chapterGuidance},最多 ${maxChapters} 章,从上手到进阶到实战,循序渐进;`,
            ]),
        '3. 章节名称 name 统一为“第 1 章: ……”，全书章节全局连续编号，从“第 1 章”到“第 N 章”严格单调递增，教学时序严禁颠倒;',
        '4. 每个章节（无论是模块首章还是后续章节）的 moduleTitle 字段都必须明确填写该章所属的完整模块名称（如“模块 1: 架构全景与环境准备”）；同一模块下的多个连续章节填写相同的 moduleTitle;',
        ...(hasIntent
          ? [
              '5. 每章 targetPaths 从骨架图的缩进子分区行中挑选 0-4 个路径,且必须原样复制骨架行中的路径标识——严禁添加仓库根名前缀(反例: xray-core/transport ✗ 应为 transport)、严禁绝对路径、严禁凭记忆改写;可用 README 等根文件;禁止使用仓库根名,禁止编造;thematic_slice 时允许 targetPaths 为空数组,改由 focusFiles 承载本章核心文件（每章 ≤8 个,路径必须逐字来自骨架图中的符号索引/文件清单,严禁虚构改写;不同章节应分配不同的核心文件,避免多章重复引用同一文件列表;targetPaths 与 focusFiles 至少一项非空）;full_repo 模式严禁输出 focusFiles 字段（严守输出 token 预算）;',
            ]
          : [
              '5. 每章 targetPaths 从骨架图的缩进子分区行中挑选 1-4 个路径,且必须原样复制骨架行中的路径标识——严禁添加仓库根名前缀(反例: xray-core/transport ✗ 应为 transport)、严禁绝对路径、严禁凭记忆改写;可用 README 等根文件;禁止使用仓库根名,禁止编造;',
            ]),
        '6. name 与 summary 必须通俗易懂，直击核心工程机制与教学意图：用目标语言阐明该模块解决什么问题、如何工作；严禁使用“门面契约”、“领域模型”、“核心执行引擎”等抽象分类套话；严禁在章节名称末尾使用括号机械堆砌符号（反例：“第 2 章: 传输协议 (TCP、UDP)” ✗，正例：“第 2 章: 网络传输层实现：TCP 与 UDP 协议栈封装” ✓）；严禁把骨架行中的原始目录名/文件名直接充当标题（反例：“第 2 章: transport” ✗）；章节名称严禁包含任何代码文件扩展名后缀（如 .py, .ts, .go, .rs 等）；name 严控在 35 字以内（英文 <= 60 chars）；summary 严控在 60 字以内（英文 <= 100 chars，仅陈述教学意图与模块核心职责，严禁长篇展开或写小作文）；',
        '7. 各章 targetPaths 必须以不同分区为主——仅第 1 章允许指向仓库根/README,其余章禁止全部指向同一分区;hot 高的分区优先安排核心章;',
        '8. 每章标注 phase(入门/进阶/实战);骨架未覆盖的分区不必强塞章节;',
        ...(blueprintSection
          ? [
              '9. 导师级蓝图遵从（CRITICAL）：章节与认知模块规划必须严格遵循下方 [Curriculum Blueprint] 的主线立意与认知进阶阶段（Cognitive Progression Phases）；核心模块与章节必须优先覆盖聚焦模块（Spotlight Modules），坚决弱化或过滤剪枝模块（Pruned Modules）；',
              `10. 全部文字使用 ${targetLanguage};直接输出 JSON,无任何思考过程或多余说明,结构如下:`,
            ]
          : [`9. 全部文字使用 ${targetLanguage};直接输出 JSON,无任何思考过程或多余说明,结构如下:`]),
      ];
      // Dual examples prevent anchoring bias when user intent is present; empty-intent path keeps single example.
      const fullRepoExample =
        '{"curriculumMode":"matrix","chapters":[{"moduleTitle":"模块 1: 架构全景与环境准备","name":"第 1 章: 仓库全景与认知地图","summary":"系统全貌与环境准备","targetPaths":["README.md"],"phase":"入门","drillDown":false},{"moduleTitle":"模块 1: 架构全景与环境准备","name":"第 2 章: 核心源码分层与运行入口","summary":"核心分层架构","targetPaths":["src"],"phase":"入门","drillDown":false},{"moduleTitle":"模块 2: 核心引擎与扩展系统","name":"第 3 章: 引擎核心剖析","summary":"核心算法与状态调度","targetPaths":["packages/core"],"phase":"进阶","drillDown":false}],"needRollup":["仅当需补充子树骨架时输出(≤3 个路径,按优先级排序,超出仅前 3 个被采纳),否则省略"]}';
      if (hasIntent) {
        lines.push('输出范例（full_repo 全仓模式，严禁输出 focusFiles 字段）:');
        lines.push(fullRepoExample);
        lines.push('输出范例（thematic_slice 目标域独立重构模式，排除无关模块后沿核心机制拆深为多模块完整大纲）:');
        lines.push(
          '{"curriculumMode":"matrix","intentMode":"thematic_slice","chapters":[{"moduleTitle":"模块 1: CLI 入口与 Agent 启动链路","name":"第 1 章: CLI 命令解析与运行时上下文初始化","summary":"剖析命令行入口参数解析与 Agent 实例化链路","targetPaths":["apps/cli"],"phase":"入门","drillDown":false},{"moduleTitle":"模块 1: CLI 入口与 Agent 启动链路","name":"第 2 章: Agent 核心抽象与消息流转状态机","summary":"拆解对话循环、上下文窗口与消息调度机制","focusFiles":["apps/examples/cli-agent/src/index.ts"],"phase":"进阶","drillDown":false},{"moduleTitle":"模块 2: 多智能体编排与工具调用实战","name":"第 3 章: 工具注册协议与执行回调闭环","summary":"深入工具定义、权限校验与执行结果回填链路","focusFiles":["apps/examples/code-review/src/index.ts"],"phase":"进阶","drillDown":false},{"moduleTitle":"模块 2: 多智能体编排与工具调用实战","name":"第 4 章: 多智能体任务编排与协作路由","summary":"剖析多 Agent 角色分工与子任务派发机制","targetPaths":["apps/examples"],"phase":"实战","drillDown":false}]}',
        );
      } else {
        lines.push(fullRepoExample);
      }
      if (blueprintSection) {
        lines.push('');
        lines.push('=== 导师级课程架构蓝图 (Curriculum Blueprint) ===');
        lines.push(blueprintSection);
      }
      lines.push('');
      lines.push('=== 目录骨架图 ===');
      lines.push(skeleton);
      if (planFeedback) {
        lines.push('');
        lines.push('=== 上次规划反馈(必须按反馈修正后重新输出完整 JSON) ===');
        lines.push(planFeedback);
      }
      if (Object.keys(rollups).length > 0) {
        lines.push('');
        lines.push('=== 补充子树骨架(上次请求的 needRollup 上卷) ===');
        for (const [p, sk] of Object.entries(rollups)) {
          lines.push(`--- ${p} ---`);
          lines.push(String(sk ?? ''));
        }
      }
      if (hasIntent && previousOutline) {
        lines.push('');
        lines.push('=== 上一版大纲参考坐标（仅作章节序号指代解析字典，严禁在旧大纲上直接删减剩 2~3 章） ===');
        lines.push(previousOutline);
        lines.push('坐标解析与重构规则：若用户意图提及“第 X 章”（如“移除第 4、7 章”“保留并深化第 5、6 章”“结合第 1 章”），先对照上方参考坐标还原其真实源码目录与技术主题，剔除被移除的模块，再按体量守恒规则围绕目标主题从零重新规划完整的章节体系！');
      }
      const sandwich = assembleSandwichDirective(customPrompt, '资深技术教程架构师', [
        `必须且仅能使用 ${targetLanguage} 输出全部文字（语言契约）`,
        '直接输出纯 JSON 对象（格式死锁）：无思考过程、无解释、无 markdown 围栏',
        'targetPaths 必须逐字来自骨架图：虚构路径一票否决，RealPaths 求交装甲会静默剔除任何幻觉路径',
        '章节名称必须是通俗易懂的工程机制或模块职责，严禁使用“门面契约/领域模型”等抽象架构分类词，严禁末尾带括号罗列符号清单，严禁出现 .py/.ts/.go 等代码文件扩展名',
        '若沙盒意图含时间预算（如「一天看完」「浓缩为 N 课时」），以该预算压制章节数（极速通关最低可至 3 核心章）',
        '若沙盒意图指定侧重目录，优先将其置于前序核心章节',
        '专题聚焦重构（thematic_slice）必须排除与用户主题无关的目录，同时将释放出的章节配额投入目标主题的垂直拆解——除非用户明确要求极简速通，否则严禁简单删成 2~3 章残缺大纲，必须重新生成结构完整的新大纲',
        'focusFiles 必须逐字来自骨架图中的符号索引与文件清单：虚构路径一票否决，RealPaths 求交装甲会静默剔除任何幻觉路径',
      ]);
      if (sandwich) {
        lines.push('');
        lines.push(sandwich);
      }

      return lines.join('\n');
    },
    source: 'outline-plan',
    keyOrigin: 'user',
    priority: 'interactive',
    temperature: 0.3,
    maxTokens: 2000,
    disableThinking: true,
    timeoutMs: 120_000,
  },
  diagram_architecture_macro_v1: {
    kind: 'structured',
    schema: z.object({
      nodes: z
        .array(
          z.object({
            id: z.string().describe('物理节点 ID，必须严格对应输入的 nodes 列表中已有的 id'),
            title: z.string().describe('通俗的领域/业务角色名称，如 CLI 控制台入口'),
            subtitle: z.string().describe('简要核心职责描述，15 字以内'),
            layer: z
              .enum(['interface', 'core', 'infra', 'storage', 'utility'])
              .describe(
                '架构分层：interface=接入与交互层, core=核心业务引擎, infra=底层支持与网络, storage=数据存储与持久化, utility=基础工具库',
              ),
          }),
        )
        .describe('节点语义丰富列表'),
      edges: z
        .array(
          z.object({
            from: z.string().describe('源节点 ID，必须严格来自输入的 edges'),
            to: z.string().describe('目标节点 ID，必须严格来自输入的 edges'),
            label: z.string().describe('跨边界业务交互动作，如 传递编译参数并触发构建'),
          }),
        )
        .describe('边动作语义丰富列表'),
      summary: z.string().optional().describe('1~2 句话的宏观系统设计模式与数据流总结'),
    }),
    compile: async (variables) => {
      const repoName = String(variables.repoName ?? 'Repository');
      const scope = String(variables.scope ?? '');
      const scale = Number(variables.scale ?? 1);
      const targetLanguage = String(variables.targetLanguage ?? 'zh-CN') || 'zh-CN';
      const nodes = Array.isArray(variables.nodes) ? variables.nodes : [];
      const edges = Array.isArray(variables.edges) ? variables.edges : [];
      const rawMermaid = String(variables.rawMermaid ?? '');

      const scaleDesc =
        scale === 2
          ? `子系统内部组件协作图 (Scope: ${scope || 'Subsystem'})`
          : `全局宏观系统上下文图 (System Context)`;

      const nodesSummary = nodes
        .map(
          (n: any) =>
            `- ID: ${n.id} | Name: ${n.name} | Path: ${n.path} | Files: ${n.fileCount} | LOC: ${n.loc} | RoleHint: ${n.role || 'core'} | TopExports: ${(n.topExports || []).join(', ')}`,
        )
        .join('\n');

      const edgesSummary = edges
        .map(
          (e: any) =>
            `- ${e.from} -> ${e.to} (Weight: ${e.weight}, CalledSymbols: ${(e.symbols || []).join(', ')})`,
        )
        .join('\n');

      return [
        `你是资深系统架构师。下面是代码仓库「${repoName}」的确定性物理拓扑事实数据 (${scaleDesc})。`,
        '所有节点与跨模块调用边均已由 Tree-sitter AST 真实提取并验证。',
        '',
        '任务：为这些物理节点与物理边注入清晰、易懂、专业的领域工程语义：',
        '1. nodes: 对输入列表中的每个节点（严禁增加或删除 ID）：',
        '   - title: 业务/领域名称（例如 commands -> "CLI 控制台入口", hugolib -> "Hugo 核心引擎"）；',
        '   - subtitle: 15 字以内的简要职责（例如 "命令行参数解析与上下文初始化"）；',
        '   - layer: 归属架构层（interface / core / infra / storage / utility）；',
        '2. edges: 对输入列表中的每条调用边（根据其调用的真实符号 Symbols 和调用权重）：',
        '   - label: 给出清晰的业务交互描述（例如 "传递编译标志与配置", "调用模板解析器渲染页面"）；',
        '3. summary: 用 1~2 句话精辟提炼该系统的核心设计模式与数据流动特点。',
        '',
        `全部描述使用 ${targetLanguage}。`,
        '输出格式：必须严格输出合规 JSON 对象，与所要求的 Schema 结构一致，无思考过程。',
        '',
        '=== 物理节点列表 (Nodes) ===',
        nodesSummary || '(none)',
        '',
        '=== 物理调用边列表 (Edges) ===',
        edgesSummary || '(none)',
        '',
        '=== 物理骨架图参考 (RawMermaid) ===',
        rawMermaid,
      ].join('\n');
    },
    source: 'diagram-macro',
    keyOrigin: 'user',
    priority: 'interactive',
    temperature: 0.2,
    maxTokens: 4000,
    disableThinking: true,
    // Coloring is non-critical; 3s cap prevents thinking models from stalling topology responses.
    timeoutMs: 3_000,
  },
  webdoc_topology_scout: {
    kind: 'structured',
    schema: siteTopologyDecisionSchema,
    normalizeOutput: normalizeSiteTopologyDecision,
    compile: async (variables) => {
      const entryUrl = String(variables.entryUrl ?? '');
      const siteTitle = String(variables.siteTitle ?? 'Documentation');
      const headerLinks = Array.isArray(variables.headerLinks) ? variables.headerLinks : [];
      const candidatePrefixes = Array.isArray(variables.candidatePrefixes) ? variables.candidatePrefixes : [];
      const navBlocks = Array.isArray(variables.navBlocks) ? variables.navBlocks : [];

      const headerLinksText = headerLinks
        .map((h: any) => `- [${h.text || 'Link'}](${h.href || '/'})`)
        .join('\n') || '(No header navigation links detected)';

      const candidatePrefixesText = candidatePrefixes
        .map((p: any) => `- ${p}`)
        .join('\n') || '(None)';

      const navBlocksText = navBlocks.length > 0
        ? navBlocks
            .map((b: any) => {
              const samples = Array.isArray(b.sampleLinks)
                ? b.sampleLinks.map((s: any) => `  - [${s.text || 'Link'}](${s.href || '/'})`).join('\n')
                : '';
              return `- block ${b.id} (${b.regionHint || 'unknown'}, ${b.linkCount ?? 0} links):\n${samples}`;
            })
            .join('\n')
        : '(None)';

      const compiled = await PromptRegistry.getCompiledPrompt('webdoc_topology_scout', {
        entryUrl,
        siteTitle,
        headerLinksText,
        candidatePrefixesText,
        navBlocksText,
      });
      if (navBlocks.length > 0 && !compiled.compiledPrompt.includes('sidebarBlockId')) {
        return `${compiled.compiledPrompt}\n\nCandidate Navigation Blocks:\n${navBlocksText}\n\nAdditionally output "sidebarBlockId": the id (e.g. "b2") of the non-header block that represents the main left documentation sidebar, or "" if none.`;
      }
      return compiled.compiledPrompt;
    },
    source: 'webdoc-scout',
    keyOrigin: 'user',
    priority: 'interactive',
    preferFastFallback: true,
    temperature: 0.1,
    maxTokens: 1000,
    disableThinking: true,
    timeoutMs: 8000,
  },
  webdoc_container_probe: {
    kind: 'structured',
    schema: siteContainerProbeDecisionSchema,
    normalizeOutput: normalizeSiteContainerProbeDecision,
    compile: async (variables) => {
      const entryUrl = String(variables.entryUrl ?? '');
      const degradedCount = String(variables.degradedCount ?? '0');
      const skeletonsText = String(variables.skeletonsText ?? '(none)');

      const compiled = await PromptRegistry.getCompiledPrompt('webdoc_container_probe', {
        entryUrl,
        degradedCount,
        skeletonsText,
      });
      return compiled.compiledPrompt;
    },
    source: 'webdoc-ingest',
    keyOrigin: 'user',
    priority: 'batch',
    temperature: 0.0,
    maxTokens: 800,
    disableThinking: true,
    timeoutMs: 6000,
  },
  webdoc_outline_synthesizer: {
    kind: 'structured',
    schema: z.object({
      sections: z
        .array(
          z.object({
            title: z.string(),
            items: z.array(z.object({ title: z.string(), href: z.string() })),
          }),
        )
        .min(1),
    }),
    compile: async (variables) => {
      const compiled = await PromptRegistry.getCompiledPrompt('webdoc_outline_synthesizer', {
        entryUrl: String(variables.entryUrl ?? ''),
        siteTitle: String(variables.siteTitle ?? 'Documentation'),
        sidebarLinksText: String(variables.sidebarLinksText ?? ''),
      });
      return compiled.compiledPrompt;
    },
    source: 'webdoc-scout',
    keyOrigin: 'user',
    priority: 'interactive',
    preferFastFallback: true,
    temperature: 0.1,
    maxTokens: 1000,
    disableThinking: true,
    timeoutMs: 8000,
  },
};

export function lookupLlmPurpose(purpose: string): LlmGatewayPurpose | null {
  return PURPOSES[purpose] ?? null;
}

export function registeredLlmPurposes(): string[] {
  return Object.keys(PURPOSES);
}

export type TeachingDepth = 'overview' | 'standard' | 'deep';

function normalizeTeachingDepth(raw: unknown): TeachingDepth {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v === 'overview' || v === 'deep' ? v : 'standard';
}

// Unknown/missing archetypes return empty string so callers inject zero spurious constraints.
const LEARNER_ARCHETYPE_FOCUS: Record<string, string> = {
  architecture_overview: '侧重模块边界、数据流向与架构设计权衡',
  deep_dive_internals: '侧重核心数据结构、生命周期钩子、底层状态机与边界防护',
  cross_language_migrant: '侧重范式映射、运行时/内存/异步模型差异',
  pedagogical_beginner: '强化前置概念铺垫、从最小可用示例切入再展开原理',
};

function learnerArchetypeFocus(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  return LEARNER_ARCHETYPE_FOCUS[v] ?? '';
}
