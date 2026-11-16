/**
 * 更新计划生成器（plan-then-apply Stage 1，LLM 决策层）。
 *
 * 输入：规则候选集（update-candidate-set.ts 产出）+ 宪法硬约束；
 * 输出：UpdatePlan（每个候选章节的 action 裁决），供用户确认后由确定性执行器应用。
 *
 * 设计要点（Phase 0 pilot 验证）：
 * - Stage 0 豁免分流：候选集中 keepExemption 命中的章节（基础设施-only 变更 +
 *   教学核未动）不进 LLM，预填 keep 合并回计划；全命中时整体短路（零 token）
 * - 宪法把"语义决策"与"安全边界"分离：LLM 只有 update/keep/remove/add 的裁决权，
 *   越权（候选集外章节）、结构重排、无条件豁免均为宪法禁止
 * - 整体级重试必需：qwen3.6-flash 等快模型存在系统性输出漂移（整段输出非 JSON），
 *   zod .catch() 字段容错救不了整体失效（pilot 实测第 1 次失败、第 2 次成功）
 * - 失败返回 null：调用方降级"候选集全量更新"（保守兜底，宁多勿少；
 *   确定性豁免在降级计划中依然保持 keep——规则证明与 LLM 可用性无关）
 * - llm-cache 按 (owner, repo, fromSha→toSha, 变体) 复用：同一 sha 对多用户共享裁决
 */

import { z } from 'zod';
import { generateObject } from 'ai';
import { generateStructured } from '../lib/ai';
import { withLlmCache, hashCacheVariant } from '../lib/llm-cache';
import { TRANSLATION_LANGUAGES } from '../lib/constants';
import type { UpdateCandidateSet, UpdateCandidateChapter, AffectedFile } from './update-candidate-set';
import { stripEnclosingFences } from './mdx-enhancer';
import { PromptRegistry } from '@/lib/prompt-registry';

/** 测试注入的模型类型（与 generateStructured 的 model 参数一致） */
type LanguageModelLike = Parameters<typeof generateObject>[0]['model'];

export type UpdateActionKind = 'update' | 'keep' | 'remove' | 'add';

interface UpdatePlanAction {
  /** Document.path（真实仓库路径或代码章节虚拟路径 chapters/XX.mdx） */
  path: string;
  action: UpdateActionKind;
  /** 仅 add 时需要：插入到该路径章节之后 */
  position?: string;
  /** 仅 add 时需要：新章节标题 */
  title?: string;
  reason: string;
  evidence: string;
}

export interface UpdatePlan {
  chapters: UpdatePlanAction[];
  summary: string;
  isFallback?: boolean;
  fallbackReason?: string;
}

// ─── 计划 zod schema（照抄 ai-repo-sniffer 的 .catch() 全字段容错模式：
// 快模型对复杂 schema 的输出漂移是系统性的，单字段失败用默认值兜底）───
const updatePlanSchema = z.object({
  chapters: z
    .array(
      z.object({
        path: z.string().catch('').describe('候选章节的 Document 路径'),
        action: z.enum(['update', 'keep', 'remove', 'add']).catch('update').describe('update=重新转录 / keep=维持原状 / remove=删除章节 / add=新增章节'),
        position: z.string().optional().catch(undefined).describe('仅 add 时需要：插入到哪个现有章节路径之后'),
        title: z.string().optional().catch(undefined).describe('仅 add 时需要：新章节的标题'),
        reason: z.string().catch('').describe('一句话理由'),
        evidence: z.string().catch('').describe('证据：引用的具体文件路径，keep 必须有强证据'),
      })
    )
    .catch([]),
  summary: z.string().catch('').describe('计划整体说明'),
});

/**
 * 确定性载荷剥壳与归一化：
 * 1. 若为字符串：剥除思考标签（<think>...</think>）、Markdown 围栏（```json ... ```）、前后闲聊寒暄，提取纯净 JSON；
 * 2. 若为对象：解开常见包裹容器（data / result / plan / response）；
 * 3. 顶层字段别名自愈：支持 chapters / actions / items / modules / sections 等映射；
 * 4. 章节条目别名自愈：path / file / filePath，action / type / kind / op 等。
 */
export function stripAndNormalizePlanPayload(raw: unknown): unknown {
  let data: any = raw;

  if (typeof data === 'string') {
    let str = data.trim();
    // 1. 剥除思考标签
    str = str.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    str = str.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();

    // 2. 剥除 Markdown 围栏信封（确定性首尾配对校验；围栏嵌在闲聊中间的场景
    //    由下方「首 {/[ 至末 }/]」确定性切片兜底，不再用跨文本懒匹配正则）
    str = stripEnclosingFences(str, ['', 'json']);

    // 3. 优先尝试直接 JSON.parse（处理纯 JSON 对象或数组）
    let parsed: any = null;
    try {
      parsed = JSON.parse(str);
    } catch {
      // 容错提取外层 JSON 容器（判断是数组还是对象）
      const firstBrace = str.indexOf('{');
      const lastBrace = str.lastIndexOf('}');
      const firstBracket = str.indexOf('[');
      const lastBracket = str.lastIndexOf(']');

      if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace) && lastBracket > firstBracket) {
        try {
          parsed = JSON.parse(str.slice(firstBracket, lastBracket + 1));
        } catch {}
      } else if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
          parsed = JSON.parse(str.slice(firstBrace, lastBrace + 1));
        } catch {}
      }
    }

    if (parsed !== null && typeof parsed === 'object') {
      data = parsed;
    } else {
      return raw;
    }
  }

  // 若顶层为数组，自愈包装为标准计划对象
  if (Array.isArray(data)) {
    data = { chapters: data, summary: '' };
  }

  if (data && typeof data === 'object') {
    // 解开常见嵌套容器（最多 3 层）
    for (let depth = 0; depth < 3; depth++) {
      if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
        data = data.data;
      } else if (data.result && typeof data.result === 'object' && !Array.isArray(data.result)) {
        data = data.result;
      } else if (data.plan && typeof data.plan === 'object' && !Array.isArray(data.plan)) {
        data = data.plan;
      } else if (data.response && typeof data.response === 'object' && !Array.isArray(data.response)) {
        data = data.response;
      } else {
        break;
      }
    }

    // 若容器解开后是数组
    if (Array.isArray(data)) {
      data = { chapters: data, summary: '' };
    }

    // 顶层别名归一化
    if (!Array.isArray(data.chapters)) {
      const aliasCandidates = [data.actions, data.items, data.modules, data.tableOfContents, data.sections];
      for (const cand of aliasCandidates) {
        if (Array.isArray(cand)) {
          data.chapters = cand;
          break;
        }
      }
    }

    if (typeof data.summary !== 'string') {
      const summaryCandidates = [data.description, data.overview, data.reason, data.explanation];
      for (const cand of summaryCandidates) {
        if (typeof cand === 'string' && cand.trim()) {
          data.summary = cand.trim();
          break;
        }
      }
    }

    // 章节条目别名归一化
    if (Array.isArray(data.chapters)) {
      data.chapters = data.chapters.map((item: any) => {
        if (!item || typeof item !== 'object') return item;
        const path = item.path || item.file || item.filePath || item.documentPath || item.target || '';
        let action = item.action || item.type || item.kind || item.op || item.operation || 'update';
        if (typeof action === 'string') action = action.toLowerCase();
        const reason = item.reason || item.rationale || item.desc || item.description || '';
        const evidence = item.evidence || item.proof || item.facts || item.fileEvidence || '';
        return {
          ...item,
          path,
          action,
          reason,
          evidence,
        };
      });
    }
  }

  return data;
}

/**
 * Layer 1: 内存 0ms 截断物理急救器 (SalvagePartialUpdatePlan)
 *
 * 物理动机：
 * 当快模型遇到大候选集，输出到中途因 Token 耗尽被截断，整段 JSON 缺失尾部 `]}` 导致 JSON.parse 全盘失败。
 * 本函数通过花括号深度追踪状态机，从不完整或格式损坏的载荷中物理打捞出所有完整闭合的章节决策对象。
 */
export function salvagePartialUpdatePlan(rawText: string): UpdatePlanAction[] {
  if (!rawText || typeof rawText !== 'string') return [];

  let text = rawText.trim();
  // 1. 剥除思考标签与 Markdown 围栏
  text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  text = text.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  text = stripEnclosingFences(text, ['', 'json']).trim();

  // 2. 定位 chapters 数组或首个数组起始
  const chaptersIdx = text.search(/"chapters"\s*:\s*\[/i);
  let searchStart = 0;
  if (chaptersIdx !== -1) {
    searchStart = text.indexOf('[', chaptersIdx);
  } else {
    const firstBracket = text.indexOf('[');
    if (firstBracket !== -1) {
      searchStart = firstBracket;
    }
  }

  const salvaged: UpdatePlanAction[] = [];
  const n = text.length;
  let inString = false;
  let escape = false;
  let braceDepth = 0;
  let objStart = -1;

  for (let i = searchStart; i < n; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (braceDepth === 0) {
        objStart = i;
      }
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (braceDepth === 0 && objStart !== -1) {
        const objSlice = text.slice(objStart, i + 1);
        try {
          const parsed = JSON.parse(objSlice);
          if (parsed && typeof parsed === 'object') {
            const path = parsed.path || parsed.file || parsed.filePath || parsed.documentPath || parsed.target || '';
            let action = parsed.action || parsed.type || parsed.kind || parsed.op || 'update';
            if (typeof action === 'string') action = action.toLowerCase();
            const validActions = ['update', 'keep', 'remove', 'add'];
            if (!validActions.includes(action)) {
              action = 'update';
            }
            if (path && typeof path === 'string' && path.trim()) {
              salvaged.push({
                path: path.trim(),
                action: action as UpdateActionKind,
                position: typeof parsed.position === 'string' ? parsed.position : undefined,
                title: typeof parsed.title === 'string' ? parsed.title : undefined,
                reason: String(parsed.reason || parsed.desc || parsed.rationale || ''),
                evidence: String(parsed.evidence || parsed.proof || parsed.facts || ''),
              });
            }
          }
        } catch {
          // 容错单个对象解析错误，继续打捞下一个完整闭合对象
        }
        objStart = -1;
      }
    }
  }

  return salvaged;
}

export function parseUpdatePlanPayload(raw: unknown): UpdatePlan {
  const normalized = stripAndNormalizePlanPayload(raw);
  try {
    const parsed = updatePlanSchema.parse(normalized);
    if (parsed.chapters.length > 0) {
      return parsed;
    }
  } catch {
    // 捕获 Zod 异常，转入 Layer 1 打捞
  }

  // Layer 1: 若常规解析产生空章节或异常，但输入包含文本，尝试状态机物理打捞
  const text = typeof raw === 'string' ? raw : (typeof (normalized as any)?.rawText === 'string' ? (normalized as any).rawText : JSON.stringify(raw));
  const salvaged = salvagePartialUpdatePlan(text);
  if (salvaged.length > 0) {
    return {
      chapters: salvaged,
      summary: typeof (normalized as any)?.summary === 'string' && (normalized as any).summary ? (normalized as any).summary : '（由 Layer 1 内存状态机截断急救挽救产出）',
    };
  }

  // 若仍无法挽救，返回经 schema 兜底的标准对象（可能为空）
  return updatePlanSchema.parse(normalized);
}

interface GenerateUpdatePlanParams {
  owner: string;
  repo: string;
  branch: string;
  fromSha: string;
  toSha: string;
  /** 变体维度（影响输出的上下文） */
  prefix?: string;
  targetLanguage?: string;
  teachingDepth?: string;
  candidateSet: UpdateCandidateSet;
  /** 现有章节顺序（来自旧 codeClusters 的 title 列表；文档类仓库为 navTree 章节标题） */
  existingChapterTitles: string[];
  /** 发起用户（BYOK 模型解析与记账） */
  userId?: string;
  /** 用户 GitHub 凭据（added 文件采样 raw 回退时携带；私仓必需） */
  token?: string;
  /** 测试注入：替代真实模型 */
  model?: LanguageModelLike;
}

const PLAN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 3;
/** 新增文件内容采样上限（帮助 LLM 判断是否形成新模块） */
const SAMPLE_MAX_FILES = 8;
const SAMPLE_MAX_BYTES = 1000;

/** 新增文件内容采样（仅 added；modified 走旧摘要判断即可）。
 *  本地归档命中 → 磁盘头读；归档未就绪 → raw 网络回退（同样只取头部字节） */
async function sampleAddedFiles(
  owner: string,
  repo: string,
  toSha: string,
  unmatchedFiles: AffectedFile[],
  token?: string
): Promise<Array<{ path: string; snippet: string }>> {
  const added = unmatchedFiles.filter((f) => f.change === 'added').slice(0, SAMPLE_MAX_FILES);
  if (added.length === 0) return [];
  const { readFileLocal, fetchRawFileHead } = await import('./repo-tarball');
  const samples: Array<{ path: string; snippet: string }> = [];
  for (const f of added) {
    try {
      const content =
        (await readFileLocal(owner, repo, toSha, f.path, SAMPLE_MAX_BYTES)) ??
        (await fetchRawFileHead(owner, repo, toSha, f.path, SAMPLE_MAX_BYTES, token));
      if (content) samples.push({ path: f.path, snippet: content.slice(0, SAMPLE_MAX_BYTES) });
    } catch {
      // 采样失败跳过（不影响计划生成）
    }
  }
  return samples;
}

async function buildPrompt(ctx: {
  candidateSet: UpdateCandidateSet;
  existingChapterTitles: string[];
  addedSamples: Array<{ path: string; snippet: string }>;
  retryFeedback?: string;
}): Promise<string> {
  const { candidateSet } = ctx;
  const diffOverview = `文件内容变更 ${candidateSet.diffStats.modified} 个，新增 ${candidateSet.diffStats.added} 个，删除 ${candidateSet.diffStats.removed} 个，改名/移动 ${candidateSet.diffStats.renamed} 个（内容未变）。`;
  const existingTitles = ctx.existingChapterTitles.map((t, i) => `${i + 1}. ${t}`).join('\n') || '(无)';
  const candidatesList = candidateSet.chapters.map((c, i) => {
    let s = `候选${i + 1}: path=${c.path} | title=${c.title ?? '(无)'} | 变更性质=${c.change}`;
    if (c.oldSummary) s += `\n  旧摘要: ${c.oldSummary.slice(0, 300)}`;
    s += `\n  受影响文件: ${c.affectedFiles.map((f) => `${f.path}(${f.change})`).join(', ')}`;
    if (c.surgicalAnchors && c.surgicalAnchors.length > 0) {
      const anchorDescriptions = c.surgicalAnchors
        .map((a) => {
          let desc = `${a.kind || '符号'} ${a.symbolName || a.file} (${a.reason || a.change})`;
          if (a.diffSnippet) {
            desc += `\n    差异切片:\n    ${a.diffSnippet.split('\n').join('\n    ')}`;
          }
          return desc;
        })
        .join('\n  ');
      s += `\n  【局部变更锚点】\n  ${anchorDescriptions}`;
    }
    return s;
  }).join('\n') || '(无)';

  const unmatchedLines = candidateSet.unmatchedFiles
    .slice(0, 80)
    .map((f) => `${f.path} (${f.change})`)
    .join('\n') || '(无)';
  const diffFilesList = unmatchedLines;

  let samplesSection = '';
  if (candidateSet.structuralAdds.length > 0) {
    samplesSection += '\n【重聚类检测到上游新增模块】\n' + candidateSet.structuralAdds.map((c, i) => `新增模块候选${i + 1}: path=${c.path} | title=${c.title ?? '(无)'}\n  包含文件: ${c.affectedFiles.map((f) => f.path).join(', ').slice(0, 300)}`).join('\n');
  }
  if (ctx.addedSamples.length > 0) {
    samplesSection += '\n【新增文件内容采样】\n' + ctx.addedSamples.map(s => `--- ${s.path} ---\n${s.snippet}`).join('\n');
  }

  const compiled = await PromptRegistry.getCompiledPrompt('update_planner_constitution', {
    diffOverview,
    diffFilesList,
    candidatesList,
    existingTitles,
    samplesSection,
    retryFeedback: ctx.retryFeedback ? `\n\n【格式错误整改重试指令】\n${ctx.retryFeedback}` : '',
  });
  return compiled.compiledPrompt;
}

/**
 * 过滤 LLM 输出的空 path / 重复条目（.catch() 兜底可能产生脏数据）
 */
function sanitizePlan(plan: UpdatePlan): UpdatePlan {
  const seen = new Set<string>();
  const chapters = plan.chapters.filter((ch) => {
    if (!ch.path || seen.has(ch.path)) return false;
    seen.add(ch.path);
    return true;
  });
  return { chapters, summary: plan.summary };
}

/**
 * Stage 0 确定性豁免分流（keep 豁免下沉的核心接线）：
 * - 豁免章节不进 LLM 候选（零 token、零漂移），以预填 keep 合并回最终计划——
 *   用户确认环节仍可见「为什么 keep」（透明性），而非静默消失；
 * - 全部候选豁免 → 整体短路（不进缓存、不调模型、不触发空计划重试）；
 * - LLM 若对豁免路径输出幻觉条目（候选已被剔除仍提及），豁免条目优先覆盖。
 */
function mergeExemptions(
  llmPlan: UpdatePlan,
  exemptChapters: UpdateCandidateChapter[]
): UpdatePlan {
  const exemptByPath = new Map(exemptChapters.map((c) => [c.path, c]));
  const prefilled = exemptChapters.map((c) => ({
    path: c.path,
    action: 'keep' as const,
    reason: c.keepExemption!.reason,
    evidence: c.keepExemption!.evidence,
  }));
  const llmChapters = llmPlan.chapters.filter((ch) => !exemptByPath.has(ch.path));
  const llmKept = llmChapters.filter((ch) => ch.action === 'keep').length;
  const summary = exemptChapters.length > 0
    ? `${llmPlan.summary}${llmPlan.summary ? ' ' : ''}（其中 ${exemptChapters.length} 章由确定性规则豁免 keep，零 LLM 裁决${llmKept > 0 ? `，LLM 另豁免 ${llmKept} 章` : ''}）`
    : llmPlan.summary;
  return {
    chapters: [...llmChapters, ...prefilled],
    summary,
  };
}

/**
 * 生成更新计划。失败/格式错 → null（调用方降级"候选集全量更新"，保守兜底）。
 */
export async function generateUpdatePlan(params: GenerateUpdatePlanParams): Promise<UpdatePlan | null> {
  const { owner, repo, fromSha, toSha, prefix = '', targetLanguage, teachingDepth } = params;

  // Stage 0 确定性豁免分流：豁免章节零 LLM 参与直接预填 keep
  const exemptChapters = params.candidateSet.chapters.filter((c) => c.keepExemption);
  const llmChapters = params.candidateSet.chapters.filter((c) => !c.keepExemption);
  if (llmChapters.length === 0) {
    // 全命中短路：微秒级纯规则完成，不进缓存、不调模型、不触发空计划重试
    return mergeExemptions({ chapters: [], summary: '' }, exemptChapters);
  }
  const llmCandidateSet: UpdateCandidateSet = { ...params.candidateSet, chapters: llmChapters };

  // 内容采样（unmatchedFiles 的 added 文件；旧归档不可用时跳过）
  let addedSamples: Array<{ path: string; snippet: string }> = [];
  if (params.candidateSet.hasOldArchive) {
    try {
      addedSamples = await sampleAddedFiles(owner, repo, toSha, params.candidateSet.unmatchedFiles, params.token);
    } catch {
      addedSamples = [];
    }
  }

  const prompt = await buildPrompt({
    candidateSet: llmCandidateSet,
    existingChapterTitles: params.existingChapterTitles,
    addedSamples,
  });

  const cacheKey = [
    `updateplan:${owner}/${repo}`,
    `${fromSha}->${toSha}`,
    `p${hashCacheVariant(prefix)}`,
    `lang${hashCacheVariant(targetLanguage || TRANSLATION_LANGUAGES.DEFAULT_CODE)}`,
    `d${hashCacheVariant(teachingDepth || '')}`,
  ].join('@');

  return withLlmCache(cacheKey, PLAN_CACHE_TTL_MS, async () => {
    let modelToUse = params.model;
    if (!modelToUse && params.userId) {
      const { resolveActiveUserModel, toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
      const um = await resolveActiveUserModel(params.userId).catch(() => null);
      modelToUse = toInjectableStructuredModel(um);
    }

    // 分批处理：当候选集超过 BATCH_SIZE (6 章) 时切片，避免单次超大 prompt 截断
    const BATCH_SIZE = 6;
    if (llmChapters.length <= BATCH_SIZE) {
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const attemptPrompt = attempt === 1
            ? prompt
            : await buildPrompt({
                candidateSet: llmCandidateSet,
                existingChapterTitles: params.existingChapterTitles,
                addedSamples,
                retryFeedback: '上次输出格式校验未通过。必须严格输出包含 chapters 数组和 summary 字段的合法 JSON 对象，不要输出任何额外说明文字。',
              });
          const result = await generateStructured({
            schema: updatePlanSchema,
            prompt: attemptPrompt,
            temperature: 0,
            model: modelToUse,
            userId: params.userId,
          });
          const parsed = parseUpdatePlanPayload(result.object);
          const sanitized = sanitizePlan(parsed);

          // 检查单批次内是否发生了部分章节截断打捞
          const decidedPaths = new Set(sanitized.chapters.map((c) => c.path));
          const missingChapters = llmChapters.filter((c) => !decidedPaths.has(c.path));
          if (missingChapters.length > 0 && sanitized.chapters.length > 0 && attempt < MAX_RETRIES) {
            try {
              const continuationPrompt = `已完成前 ${sanitized.chapters.length} 章节的裁决。请仅对以下未决的剩余 ${missingChapters.length} 章节输出裁决结果（必须输出严格 JSON 格式）：\n\n` +
                missingChapters.map((c, i) => `未决候选${i + 1}: path=${c.path} | title=${c.title ?? '(无)'} | 变更性质=${c.change}`).join('\n');
              const resumeResult = await generateStructured({
                schema: updatePlanSchema,
                prompt: continuationPrompt,
                temperature: 0,
                model: modelToUse,
                userId: params.userId,
              });
              const resumedParsed = parseUpdatePlanPayload(resumeResult.object);
              const resumedSanitized = sanitizePlan(resumedParsed);
              sanitized.chapters.push(...resumedSanitized.chapters);
            } catch (resErr) {
              console.warn(`[UpdatePlanner] 断点续写尝试失败: ${String((resErr as Error)?.message ?? resErr).slice(0, 100)}`);
            }
          }

          if (sanitized.chapters.length === 0 && llmChapters.length > 0) {
            throw new Error('计划为空（候选集非空但 LLM 未产出任何裁决）');
          }
          return mergeExemptions(sanitized, exemptChapters);
        } catch (err) {
          lastErr = err;
          console.warn(`[UpdatePlanner] 计划生成第 ${attempt} 次尝试失败: ${String((err as Error)?.message ?? err).slice(0, 150)}`);
        }
      }
      console.error('[UpdatePlanner] 计划生成失败（已重试', MAX_RETRIES, '次），降级候选集 AST 保底:', lastErr);
      return null;
    }

    // 多批次切片执行
    const batches: UpdateCandidateChapter[][] = [];
    for (let i = 0; i < llmChapters.length; i += BATCH_SIZE) {
      batches.push(llmChapters.slice(i, i + BATCH_SIZE));
    }

    const allActions: UpdatePlanAction[] = [];
    for (const batch of batches) {
      const batchActions = await planChapterBatch(
        batch,
        params.existingChapterTitles,
        addedSamples,
        modelToUse,
        params.userId
      );
      if (!batchActions) {
        console.error('[UpdatePlanner] 候选分批生成中有一批彻底失败，降级 AST 保底');
        return null;
      }
      allActions.push(...batchActions);
    }

    const combinedPlan: UpdatePlan = {
      chapters: allActions,
      summary: `经分批 AI 规划完成，共处理 ${allActions.length} 个候选章节。`,
    };
    return mergeExemptions(combinedPlan, exemptChapters);
  });
}

async function planChapterBatch(
  batchChapters: UpdateCandidateChapter[],
  existingChapterTitles: string[],
  addedSamples: Array<{ path: string; snippet: string }>,
  modelToUse?: LanguageModelLike,
  userId?: string
): Promise<UpdatePlanAction[] | null> {
  const batchCandidateSet: UpdateCandidateSet = {
    chapters: batchChapters,
    unmatchedFiles: [],
    structuralAdds: [],
    structuralRemoves: [],
    diffStats: { added: 0, modified: 0, removed: 0, renamed: 0 },
    hasOldArchive: false,
  };

  const prompt = await buildPrompt({
    candidateSet: batchCandidateSet,
    existingChapterTitles,
    addedSamples,
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const attemptPrompt = attempt === 1
        ? prompt
        : await buildPrompt({
            candidateSet: batchCandidateSet,
            existingChapterTitles,
            addedSamples,
            retryFeedback: '上次输出格式校验未通过。必须严格输出包含 chapters 数组和 summary 字段的合法 JSON 对象，不要输出任何额外说明文字。',
          });

      const result = await generateStructured({
        schema: updatePlanSchema,
        prompt: attemptPrompt,
        temperature: 0,
        model: modelToUse,
        userId,
      });

      const parsed = parseUpdatePlanPayload(result.object);
      const sanitized = sanitizePlan(parsed);

      // 检查是否覆盖了本批次所有章节
      const decidedPaths = new Set(sanitized.chapters.map((c) => c.path));
      const missingChapters = batchChapters.filter((c) => !decidedPaths.has(c.path));

      // 若有缺失但已产出部分章节：Layer 2 靶向断点增量续写
      if (missingChapters.length > 0 && sanitized.chapters.length > 0 && attempt < MAX_RETRIES) {
        try {
          const continuationPrompt = `已完成前 ${sanitized.chapters.length} 章节的裁决。请仅对以下未决的剩余 ${missingChapters.length} 章节输出裁决结果（必须输出严格 JSON 格式）：\n\n` +
            missingChapters.map((c, i) => `未决候选${i + 1}: path=${c.path} | title=${c.title ?? '(无)'} | 变更性质=${c.change}`).join('\n');

          const resumeResult = await generateStructured({
            schema: updatePlanSchema,
            prompt: continuationPrompt,
            temperature: 0,
            model: modelToUse,
            userId,
          });
          const resumedParsed = parseUpdatePlanPayload(resumeResult.object);
          const resumedSanitized = sanitizePlan(resumedParsed);
          sanitized.chapters.push(...resumedSanitized.chapters);
        } catch (resErr) {
          console.warn(`[UpdatePlanner] 靶向断点续写尝试失败: ${String((resErr as Error)?.message ?? resErr).slice(0, 100)}`);
        }
      }

      if (sanitized.chapters.length > 0) {
        return sanitized.chapters;
      }
      throw new Error('批次计划为空');
    } catch (err) {
      console.warn(`[UpdatePlanner] 批次生成第 ${attempt} 次尝试失败: ${String((err as Error)?.message ?? err).slice(0, 150)}`);
    }
  }

  return null;
}

/**
 * 降级计划：候选集 AST 事实精准保底（LLM 不可用时的保守兜底）。
 * 遵循第一性原理与失效封闭公理：
 * 1. Stage 0 确定性豁免穿透保持 keep；
 * 2. 结合 AST 事实（isBreaking 与 surgicalAnchors）：无破坏性变动者保守维持 keep，
 *    仅有公共接口破坏或结构性文件增删者标记 update，绝不无脑全刷 update；
 * 3. 显式标记 isFallback: true，保障用户知情权，杜绝假装成功的伪弹性欺瞒。
 */
export function conservativePlan(candidateSet: UpdateCandidateSet, existingChapterTitles: string[]): UpdatePlan {
  const chapters = candidateSet.chapters.map((c) => {
    if (c.keepExemption) {
      return {
        path: c.path,
        action: 'keep' as const,
        reason: c.keepExemption.reason,
        evidence: c.keepExemption.evidence,
      };
    }

    // 检查 AST 物理事实：若显式标记 isBreaking === false，且无导出破坏，维持 keep
    const hasBreakingChange =
      c.isBreaking === true ||
      c.change === 'structural' ||
      (c.surgicalAnchors &&
        c.surgicalAnchors.some(
          (a) => a.exported && (a.change === 'removed' || a.change === 'modified')
        ));

    if (c.isBreaking === false && !hasBreakingChange) {
      return {
        path: c.path,
        action: 'keep' as const,
        reason: '静态 AST 事实核验：无导出符号破坏或结构变动，保守维持原状',
        evidence: c.affectedFiles.map((f) => f.path).join(', ') || 'AST isBreaking=false',
      };
    }

    return {
      path: c.path,
      action: 'update' as const,
      reason: 'LLM 计划不可用，按保守策略全量重转录候选章节',
      evidence: c.affectedFiles.map((f) => f.path).join(', '),
    };
  });
  const keptCount = chapters.filter((c) => c.action === 'keep').length;
  const updateCount = chapters.filter((c) => c.action === 'update').length;
  const exemptCount = candidateSet.chapters.filter((c) => c.keepExemption).length;
  const exemptClause = exemptCount > 0 ? `其中 ${exemptCount} 章由确定性规则豁免，` : '';
  return {
    chapters,
    summary: `AI 规划服务暂不可用，已基于 AST 静态事实生成保底计划（共 ${candidateSet.chapters.length} 章，${exemptClause}${keptCount} 章维持原状，${updateCount} 章标记更新；现有章节结构 ${existingChapterTitles.length} 个保持不变）。`,
    isFallback: true,
    fallbackReason: 'LLM 规划服务响应异常，已自动切入静态 AST 事实保底模式',
  };
}
