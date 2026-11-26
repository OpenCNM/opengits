import { z } from 'zod';
import { ignoreBestEffort } from '@/lib/best-effort';
import { generateStructured, trackTokenUsage } from '@/lib/ai';
import { PromptRegistry } from '@/lib/prompt-registry';
import { resolveActiveUserModel, toInjectableStructuredModel } from '@/lib/ai/user-model-resolver';
import { REPO_METADATA_CATEGORIES } from '@/lib/constants';

// Post-outline metadata classification (BYOK only); fails open to null so Others fallback never blocks outlines.

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
  signal?: AbortSignal;
}

export interface RepoMetadata {
  category: string;
  tags: string[];
}

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

export async function classifyRepoMetadata(
  input: RepoMetadataClassifyInput
): Promise<RepoMetadata | null> {
  const outlineEvidence = buildOutlineEvidence(input.chapters);
  if (!outlineEvidence) return null;

  try {
    const userModel = await resolveActiveUserModel(input.userId).catch(() => { ignoreBestEffort(); return null; });
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
