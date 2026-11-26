import { z } from 'zod';
import { generateObject } from 'ai';
import { generateStructured } from '../lib/ai';
import { withLlmCache, hashCacheVariant } from '../lib/llm-cache';
import { TRANSLATION_LANGUAGES } from '../lib/constants';
import type { UpdateCandidateSet, UpdateCandidateChapter, AffectedFile } from './update-candidate-set';
import { stripEnclosingFences } from './mdx-enhancer';
import { PromptRegistry } from '@/lib/prompt-registry';
import { ignoreBestEffort } from '@/lib/best-effort';

type LanguageModelLike = Parameters<typeof generateObject>[0]['model'];

export type UpdateActionKind = 'update' | 'keep' | 'remove' | 'add';

interface UpdatePlanAction {
  path: string;
  action: UpdateActionKind;
  position?: string;
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

export function stripAndNormalizePlanPayload(raw: unknown): unknown {
  let data: any = raw;

  if (typeof data === 'string') {
    let str = data.trim();
    str = str.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    str = str.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();

    str = stripEnclosingFences(str, ['', 'json']);

    let parsed: any = null;
    try {
      parsed = JSON.parse(str);
    } catch {
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

  if (Array.isArray(data)) {
    data = { chapters: data, summary: '' };
  }

  if (data && typeof data === 'object') {
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

    if (Array.isArray(data)) {
      data = { chapters: data, summary: '' };
    }

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

// Recovers complete chapter objects from token-truncated JSON streams via brace-depth tracking.
export function salvagePartialUpdatePlan(rawText: string): UpdatePlanAction[] {
  if (!rawText || typeof rawText !== 'string') return [];

  let text = rawText.trim();
  text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  text = text.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  text = stripEnclosingFences(text, ['', 'json']).trim();

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
  } catch (err) {
    ignoreBestEffort(err);
  }

  const text = typeof raw === 'string' ? raw : (typeof (normalized as any)?.rawText === 'string' ? (normalized as any).rawText : JSON.stringify(raw));
  const salvaged = salvagePartialUpdatePlan(text);
  if (salvaged.length > 0) {
    return {
      chapters: salvaged,
      summary: typeof (normalized as any)?.summary === 'string' && (normalized as any).summary ? (normalized as any).summary : '（由 Layer 1 内存状态机截断急救挽救产出）',
    };
  }

  return updatePlanSchema.parse(normalized);
}

interface GenerateUpdatePlanParams {
  owner: string;
  repo: string;
  branch: string;
  fromSha: string;
  toSha: string;
  prefix?: string;
  targetLanguage?: string;
  teachingDepth?: string;
  candidateSet: UpdateCandidateSet;
  existingChapterTitles: string[];
  userId?: string;
  token?: string;
  model?: LanguageModelLike;
}

const PLAN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 3;
const SAMPLE_MAX_FILES = 8;
const SAMPLE_MAX_BYTES = 1000;

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
    } catch (err) {
      ignoreBestEffort(err);
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

function sanitizePlan(plan: UpdatePlan): UpdatePlan {
  const seen = new Set<string>();
  const chapters = plan.chapters.filter((ch) => {
    if (!ch.path || seen.has(ch.path)) return false;
    seen.add(ch.path);
    return true;
  });
  return { chapters, summary: plan.summary };
}

// Preserves deterministic keep exemptions for user transparency and overrides any hallucinated LLM actions on those paths.
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

export async function generateUpdatePlan(params: GenerateUpdatePlanParams): Promise<UpdatePlan | null> {
  const { owner, repo, fromSha, toSha, prefix = '', targetLanguage, teachingDepth } = params;

  const exemptChapters = params.candidateSet.chapters.filter((c) => c.keepExemption);
  const llmChapters = params.candidateSet.chapters.filter((c) => !c.keepExemption);
  if (llmChapters.length === 0) {
    // Short-circuit before cache/LLM calls when every chapter is deterministically exempted.
    return mergeExemptions({ chapters: [], summary: '' }, exemptChapters);
  }
  const llmCandidateSet: UpdateCandidateSet = { ...params.candidateSet, chapters: llmChapters };

  let addedSamples: Array<{ path: string; snippet: string }> = [];
  if (params.candidateSet.hasOldArchive) {
    try {
      addedSamples = await sampleAddedFiles(owner, repo, toSha, params.candidateSet.unmatchedFiles, params.token);
    } catch (err) {
      ignoreBestEffort(err);
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
      const um = await resolveActiveUserModel(params.userId).catch((err) => {
        ignoreBestEffort(err);
        return null;
      });
      modelToUse = toInjectableStructuredModel(um);
    }

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

      const decidedPaths = new Set(sanitized.chapters.map((c) => c.path));
      const missingChapters = batchChapters.filter((c) => !decidedPaths.has(c.path));

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
