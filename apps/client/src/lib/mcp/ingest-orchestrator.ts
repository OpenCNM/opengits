import { z } from 'zod';
import { trackTokenUsage, generateStructured } from '../ai';
import { GitHubNode } from '@/engine/repo-sniffer';
import { buildDirectoryTopologySummary } from '@/engine/ai-repo-sniffer';
import { MODULE_ROLE_PATTERNS } from '@/engine/language-map';
import { chapterDocPath } from '@/lib/constants';
import { PromptRegistry } from '@/lib/prompt-registry';

export const outlineDraftSchema = z.object({
  parts: z.array(
    z.object({
      title: z.string().catch(''),
      summary: z.string().optional().catch(undefined),
      teachingOrder: z.number().catch(0),
    })
  ).catch([]),
  chapters: z.array(
    z.object({
      title: z.string().catch(''),
      summary: z.string().optional().catch(undefined),
      chapterType: z.enum(['doc', 'code', 'mixed']).catch('mixed'),
      teachingOrder: z.number().catch(0),
      partTitle: z.string().optional().catch(undefined),
      nodes: z.array(
        z.object({
          sourcePath: z.string().catch(''),
          title: z.string().catch(''),
          nodeType: z.enum(['doc', 'code']).catch('doc'),
        })
      ).catch([]),
    })
  ).catch([]),
});

export type OutlineChapter = {
  title: string;
  summary?: string;
  chapterType: 'doc' | 'code' | 'mixed';
  teachingOrder: number;
  partTitle?: string;
  nodes: { sourcePath: string; title: string; nodeType: 'doc' | 'code' }[];
};

export interface OutlineDraft {
  parts: { title: string; summary?: string; teachingOrder: number }[];
  chapters: OutlineChapter[];
}

export function isOutlineDraftValid(draft: OutlineDraft): boolean {
  if (!draft || draft.chapters.length === 0) return false;
  if (draft.chapters.some((c) => !c.title || !c.nodes || c.nodes.length === 0)) return false;
  return true;
}

// Strip hallucinated paths not present in the real input tree before coverage backfill.
function pruneHallucinatedPaths(draft: OutlineDraft, nodes: GitHubNode[]): void {
  const inputPaths = new Set(nodes.filter((n) => n.type === 'blob').map((n) => n.path));
  for (const ch of draft.chapters) {
    ch.nodes = ch.nodes.filter((n) => inputPaths.has(n.sourcePath));
  }
  draft.chapters = draft.chapters.filter((ch) => ch.nodes.length > 0);
}

function ensureFullCoverage(draft: OutlineDraft, nodes: GitHubNode[]): void {
  const inputPaths = new Set(
    nodes.filter((n) => n.type === 'blob').map((n) => n.path),
  );
  const covered = new Set<string>();
  for (const ch of draft.chapters) {
    for (const node of ch.nodes) covered.add(node.sourcePath);
  }
  const uncovered = [...inputPaths].filter((p) => !covered.has(p));
  if (uncovered.length === 0) return;

  const MAX_CHAPTER_NODES = 12;
  const orphans: { sourcePath: string; title: string; nodeType: 'doc' | 'code'; parentDir: string }[] = [];
  for (const p of uncovered) {
    const parentDir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
    const isDoc = MODULE_ROLE_PATTERNS.markdownExtensions.some((ext) => p.endsWith(ext));
    const nodeData = {
      sourcePath: p,
      title: p.split('/').pop()?.replace(/\.[^/.]+$/, '') || p,
      nodeType: (isDoc ? 'doc' : 'code') as 'doc' | 'code',
      parentDir,
    };

    let merged = false;
    if (parentDir) {
      for (const ch of draft.chapters) {
        if (ch.nodes.length >= MAX_CHAPTER_NODES) continue;
        const sameDir = ch.nodes.some((n) => {
          const nDir = n.sourcePath.includes('/')
            ? n.sourcePath.substring(0, n.sourcePath.lastIndexOf('/'))
            : '';
          return nDir === parentDir;
        });
        if (sameDir) {
          ch.nodes.push(nodeData);
          merged = true;
          break;
        }
      }
    }
    if (!merged) orphans.push(nodeData);
  }

  if (orphans.length > 0) {
    const orphanGroups = new Map<string, typeof orphans>();
    for (const orphan of orphans) {
      const gKey = orphan.parentDir || 'root';
      if (!orphanGroups.has(gKey)) orphanGroups.set(gKey, []);
      orphanGroups.get(gKey)!.push(orphan);
    }

    for (const [gKey, gNodes] of orphanGroups.entries()) {
      const rawTitle = gKey === 'root' ? 'Supplementary' : (gKey.split('/').pop() || gKey);
      const title = rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1).replace(/[-_]+/g, ' ');
      draft.chapters.push({
        title,
        chapterType: gNodes.every((n) => n.nodeType === 'doc') ? 'doc' : 'mixed',
        teachingOrder: draft.chapters.length + 1,
        nodes: gNodes,
      });
    }
  }
}

export function ensurePartsIfLarge(draft: OutlineDraft): void {
  if (draft.chapters.length <= 6 || draft.parts.length > 0) return;

  const sorted = [...draft.chapters].sort((a, b) => a.teachingOrder - b.teachingOrder);
  const third = Math.ceil(sorted.length / 3);
  const partNames = ['Basics', 'Core', 'Advanced'];
  draft.parts = partNames.map((title, i) => ({ title, teachingOrder: i + 1 }));
  for (let i = 0; i < sorted.length; i++) {
    const partIdx = Math.min(Math.floor(i / third), 2);
    sorted[i].partTitle = partNames[partIdx];
  }
}

export async function buildOrchestratorPrompt(opts: {
  owner: string;
  repo: string;
  topologySummary: ReturnType<typeof buildDirectoryTopologySummary>;
  contentSamples?: Record<string, string>;
}): Promise<string> {
  const { owner, repo, topologySummary, contentSamples } = opts;
  const samplesSection = contentSamples && Object.keys(contentSamples).length > 0
    ? `\nReal file content samples (head of each file, truncated):\n${JSON.stringify(contentSamples, null, 2)}\n`
    : '';

  const compiled = await PromptRegistry.getCompiledPrompt('ingest_orchestrator', {
    owner,
    repo,
    topologySummary: JSON.stringify(topologySummary, null, 2),
    samplesSection,
  });
  return compiled.compiledPrompt;
}

export async function orchestrateOutline(
  nodes: GitHubNode[],
  owner: string,
  repo: string,
  options?: { contentSamples?: Record<string, string>; userId?: string }
): Promise<OutlineDraft | null> {
  if (!nodes || nodes.length === 0) return null;

  const { resolveActiveUserModel, toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
  const userModel = await resolveActiveUserModel(options?.userId).catch(() => null);
  const injectable = toInjectableStructuredModel(userModel);
  if (!injectable) return null;

  const topologySummary = buildDirectoryTopologySummary(nodes as never);

  try {
    const result = await generateStructured({
      model: injectable,
      userId: options?.userId,
      schema: outlineDraftSchema,
      prompt: await buildOrchestratorPrompt({ owner, repo, topologySummary, contentSamples: options?.contentSamples }),
    });
    trackTokenUsage(result.usage, { source: 'orchestrator', userId: options?.userId });

    const draft: OutlineDraft = {
      parts: result.object.parts || [],
      chapters: result.object.chapters || [],
    };

    pruneHallucinatedPaths(draft, nodes);
    ensureFullCoverage(draft, nodes);
    ensurePartsIfLarge(draft);

    if (!isOutlineDraftValid(draft)) {
      console.warn(`[Orchestrator] LLM produced invalid outline for ${owner}/${repo}, returning null`);
      return null;
    }
    return draft;
  } catch (error) {
    console.error('[Orchestrator] Failed to orchestrate outline:', error);
    return null;
  }
}

// Used by admin reoutline for code repos; normal ingest derives outlines deterministically from navTree.
export function orchestrateFromClusters(
  chapters: { title: string; description?: string; teachingOrder: number; partTitle?: string }[],
): OutlineDraft {
  const parts: { title: string; teachingOrder: number; description?: string }[] = [];
  const partSet = new Set<string>();

  for (const ch of chapters) {
    if (ch.partTitle && !partSet.has(ch.partTitle)) {
      partSet.add(ch.partTitle);
      parts.push({
        title: ch.partTitle,
        teachingOrder: ch.teachingOrder,
      });
    }
  }

  const draft: OutlineDraft = {
    parts,
    chapters: chapters.map((ch) => ({
      title: ch.title,
      summary: ch.description,
      ...(ch.partTitle ? { partTitle: ch.partTitle } : {}),
      chapterType: 'code' as const,
      teachingOrder: ch.teachingOrder,
      nodes: [
        {
          sourcePath: chapterDocPath(ch.teachingOrder),
          title: ch.title,
          nodeType: 'code' as const,
        },
      ],
    })),
  };
  ensurePartsIfLarge(draft);
  return draft;
}
