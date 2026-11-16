import { z } from 'zod';
import { generateStructured, trackTokenUsage } from '@/lib/ai';
import { PromptRegistry } from '@/lib/prompt-registry';
import { resolveActiveUserModel, toInjectableStructuredModel } from '@/lib/ai/user-model-resolver';
import { REPO_METADATA_CATEGORIES } from '@/lib/constants';

/**
 * ─────────────────────────────────────────────────────────────
 * 仓库领域/标签分类伴生产出（树大纲流的 metadata 补全）
 *
 * 原伴生产出挂在 scout_outline_draft（文本大纲草稿）上，其生成器随 D3
 * 收刀退役后，"所属领域"自动预填在所有模式下退化为 Others 兜底。树大纲
 * （现行统一大纲路径）补上这一环：大纲生成后用章节标题/摘要/文件路径
 * 作证据做一次轻量分类，产物写入 draftOutline.{category,tags}——
 * UI 预填（WorkbenchMetadataBar）与入库归一（resolveDraftTags）两条
 * 既有消费链零改动复活。
 *
 * 元数据非关键路径：LLM 失败/漂移 fail-open 返回 null，保持 Others 兜底
 * （与 DEFAULT_METADATA 语义一致），不阻断大纲流程。
 * ─────────────────────────────────────────────────────────────
 */

/** 封闭词表枚举：漂移即整体失败（fail-open 到兜底），绝不落词表外的值 */
const metadataSchema = z.object({
  category: z.enum(REPO_METADATA_CATEGORIES as [string, ...string[]]),
  tags: z.array(z.string().min(1).max(40)).min(1).max(6),
});

export interface RepoMetadataClassifyInput {
  owner: string;
  repo: string;
  chapters: Array<{ name?: string; title?: string; summary?: string; files?: Array<{ path?: string } | string> }>;
  stats?: { files?: number; allFiles?: number };
  userId?: string;
  /** 截止信号：到期取消上游 provider 生成（思考类模型整链可达分钟级，不设界会扣死调用方） */
  signal?: AbortSignal;
}

export interface RepoMetadata {
  category: string;
  tags: string[];
}

/** 大纲证据表（纯函数）：章 | 摘要 | 文件路径采样，封顶防 token 膨胀 */
export function buildOutlineEvidence(
  chapters: RepoMetadataClassifyInput['chapters'],
  maxChapters = 20,
  filesPerChapter = 4
): string {
  const lines: string[] = [];
  for (const ch of chapters.slice(0, maxChapters)) {
    const name = (ch.name || ch.title || '').trim();
    if (!name) continue;
    const summary = (ch.summary || '').trim().slice(0, 80);
    const paths = (ch.files || [])
      .slice(0, filesPerChapter)
      .map((f) => (typeof f === 'string' ? f : f.path || ''))
      .filter(Boolean)
      .join(', ');
    lines.push(`${name} | ${summary} | ${paths}`);
  }
  return lines.join('\n');
}

/** 树大纲后置分类（fail-open）：成功返回 {category, tags}，任何失败返回 null */
export async function classifyRepoMetadata(
  input: RepoMetadataClassifyInput
): Promise<RepoMetadata | null> {
  const outlineEvidence = buildOutlineEvidence(input.chapters);
  if (!outlineEvidence) return null;

  try {
    // Scout BYOK（中继模式）：无可用模型直接兜底，不烧默认引擎
    const userModel = await resolveActiveUserModel(input.userId).catch(() => null);
    const injectable = toInjectableStructuredModel(userModel);
    if (!injectable) return null;

    const statsText = [
      `outline chapters: ${input.chapters.length}`,
      input.stats?.files != null ? `files in outline: ${input.stats.files}` : '',
      input.stats?.allFiles != null ? `files in repository: ${input.stats.allFiles}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const compiled = await PromptRegistry.getCompiledPrompt('repo_metadata_classify', {
      owner: input.owner,
      repo: input.repo,
      statsText,
      outlineEvidence,
    });

    const result = await generateStructured({
      model: injectable,
      schema: metadataSchema,
      prompt: compiled.compiledPrompt,
      disableThinking: true,
      ...(input.signal ? { abortSignal: input.signal } : {}),
    });
    trackTokenUsage(result.usage, { source: 'scout_metadata_classify', userId: input.userId });

    return { category: result.object.category, tags: result.object.tags };
  } catch (err) {
    console.warn('[repo-metadata-classifier] 分类伴生产出失败，fail-open 保持 Others 兜底:', err);
    return null;
  }
}
