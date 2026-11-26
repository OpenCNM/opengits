import { z } from 'zod';
import { ignoreBestEffort } from '@/lib/best-effort';
import { generateStructured, trackTokenUsage } from '@/lib/ai';
import { PromptRegistry } from '@/lib/prompt-registry';
import { resolveActiveUserModel, toInjectableStructuredModel } from '@/lib/ai/user-model-resolver';
import { isIngestModeGrayZone } from '@/engine/repo-sniffer';
import type { RepoProfile } from '@/engine/repo-sniffer';
import type { GitHubNode } from '@/engine/fetcher';
import type { DirTreeNode } from '@/lib/dir-verdict';

// Arbitrates gray-zone repos (docs majority + substantial code) via LLM intent while keeping clear cases zero-LLM.

const arbitrationSchema = z.object({
  teachingFocus: z.enum(['code', 'docs']),
  rationale: z.string().max(200),
});

export type ArbitrationVerdict = z.infer<typeof arbitrationSchema>;

export interface ArbitrateIngestModeInput {
  profile: RepoProfile;
  dirTree: DirTreeNode[];
  markdownFiles: GitHubNode[];
  owner: string;
  repo: string;
  sha?: string | null;
  userId?: string;
}

export interface ArbitrateIngestModeResult {
  profile: RepoProfile;
  arbitrated: boolean;
  fallback?: boolean;
  rationale?: string;
}

// Clear textRoot when switching to hybrid so scopePrefix does not lock the wizard back inside docs/.
export function deriveArbitratedProfile(
  profile: RepoProfile,
  verdict: ArbitrationVerdict
): RepoProfile {
  if (verdict.teachingFocus !== 'code') return profile;
  return { ...profile, ingestMode: 'hybrid', repoType: 'codebase', textRoot: '' };
}

export function buildDirEvidence(dirTree: DirTreeNode[], maxDirs = 60): string {
  const rows: Array<{
    path: string;
    depth: number;
    mdCount: number;
    codeCount?: number;
    primaryLang?: string;
    keyFiles?: string[];
    totalFiles: number;
  }> = [];
  const walk = (nodes: DirTreeNode[]) => {
    for (const n of nodes) {
      rows.push({
        path: n.path,
        depth: n.depth,
        mdCount: n.mdCount,
        codeCount: n.codeCount,
        primaryLang: n.primaryLang,
        keyFiles: n.keyFiles,
        totalFiles: n.totalFiles,
      });
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(dirTree);
  rows.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const aActivity = (a.codeCount ?? 0) + a.mdCount;
    const bActivity = (b.codeCount ?? 0) + b.mdCount;
    if (aActivity !== bActivity) return bActivity - aActivity;
    return b.totalFiles - a.totalFiles;
  });
  return rows
    .slice(0, maxDirs)
    .map((r) => {
      const details: string[] = [];
      if (r.codeCount && r.codeCount > 0) {
        const lang = r.primaryLang ? `${r.primaryLang} ` : '';
        const samples = r.keyFiles && r.keyFiles.length > 0 ? ` [${r.keyFiles.join(', ')}]` : '';
        details.push(`${r.codeCount} ${lang}code files${samples}`);
      }
      if (r.codeCount !== undefined) {
        details.push(`${r.mdCount} docs`);
      } else if (r.totalFiles > 0) {
        details.push(`${r.mdCount}/${r.totalFiles} docs`);
      } else {
        details.push(`${r.mdCount} docs`);
      }
      return `${r.path} | ${details.join(', ')} | depth ${r.depth}`;
    })
    .join('\n');
}

// Cache successes 24h by SHA, but cap failure debounce at 5m so transient LLM blips do not stick.
export const ARBITRATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const ARBITRATION_FAILURE_TTL_MS = 5 * 60 * 1000;
const ARBITRATION_CACHE_MAX_ENTRIES = 100;
const arbitrationCache = new Map<string, { ts: number; verdict: ArbitrationVerdict | null }>();
// In-flight singleflight deduplicates concurrent cold starts for the same repo@sha.
const arbitrationInFlight = new Map<string, Promise<ArbitrateIngestModeResult>>();

export async function arbitrateIngestMode(
  input: ArbitrateIngestModeInput
): Promise<ArbitrateIngestModeResult> {
  const { profile, dirTree, markdownFiles, owner, repo, sha, userId } = input;

  if (!isIngestModeGrayZone(profile)) {
    return { profile, arbitrated: false };
  }

  // Log before cache lookup so 5m failure debounce does not hide retry failure rates.
  console.log(`[ingest-arbiter] grayZoneHit=true repo=${owner}/${repo} sha=${sha ?? 'no-sha'}`);

  const cacheKey = `${owner}/${repo}@${sha ?? 'no-sha'}`;
  const hit = arbitrationCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < (hit.verdict ? ARBITRATION_CACHE_TTL_MS : ARBITRATION_FAILURE_TTL_MS)) {
    if (!hit.verdict) {
      console.log('[ingest-arbiter] outcome=cache_failure_ttl repo=' + owner + '/' + repo);
      return { profile, arbitrated: false, fallback: true };
    }
    console.log(`[ingest-arbiter] outcome=cache_hit verdict=${hit.verdict.teachingFocus} repo=${owner}/${repo}`);
    return {
      profile: deriveArbitratedProfile(profile, hit.verdict),
      arbitrated: hit.verdict.teachingFocus === 'code',
      rationale: hit.verdict.rationale,
    };
  }

  const pending = arbitrationInFlight.get(cacheKey);
  if (pending) return pending;
  const run = arbitrateIngestModeUncached(input, cacheKey).finally(() => {
    if (arbitrationInFlight.get(cacheKey) === run) arbitrationInFlight.delete(cacheKey);
  });
  arbitrationInFlight.set(cacheKey, run);
  return run;
}

async function arbitrateIngestModeUncached(
  input: ArbitrateIngestModeInput,
  cacheKey: string
): Promise<ArbitrateIngestModeResult> {
  const { profile, dirTree, markdownFiles, owner, repo, sha, userId } = input;

  try {
    const userModel = await resolveActiveUserModel(userId).catch(() => { ignoreBestEffort(); return null; });
    const injectable = toInjectableStructuredModel(userModel);
    if (!injectable) {
      console.log(`[ingest-arbiter] outcome=fallback_no_model repo=${owner}/${repo}`);
      return { profile, arbitrated: false, fallback: true };
    }

    const compiled = await PromptRegistry.getCompiledPrompt('ingest_mode_arbitration', {
      owner,
      repo,
      docCodeRatio: JSON.stringify(profile.docCodeRatio),
      dirEvidence: buildDirEvidence(dirTree),
      docSamples: markdownFiles.slice(0, 30).map((n) => n.path).join('\n'),
    });

    let verdict: ArbitrationVerdict | null = null;
    for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
      try {
        const result = await generateStructured({
          model: injectable,
          schema: arbitrationSchema,
          prompt: compiled.compiledPrompt,
          disableThinking: true,
        });
        trackTokenUsage(result.usage, { source: 'scout_ingest_mode_arbitration', userId });
        verdict = result.object;
      } catch (err) {
        if (attempt === 1) throw err;
        console.warn('[ingest-mode-arbiter] 仲裁首次调用失败，重试一次:', err);
      }
    }
    if (!verdict) throw new Error('arbitration produced no verdict');

    cacheVerdict(arbitrationCache, cacheKey, verdict);
    console.log(`[ingest-arbiter] outcome=verdict verdict=${verdict.teachingFocus} repo=${owner}/${repo}`);
    return {
      profile: deriveArbitratedProfile(profile, verdict),
      arbitrated: verdict.teachingFocus === 'code',
      rationale: verdict.rationale,
    };
  } catch (err) {
    console.warn('[ingest-mode-arbiter] 灰区仲裁失败，fail-closed 回落规则裁定:', err);
    console.log(`[ingest-arbiter] outcome=fallback_error repo=${owner}/${repo}`);
    cacheVerdict(arbitrationCache, cacheKey, null);
    return { profile, arbitrated: false, fallback: true };
  }
}

function cacheVerdict(
  cache: Map<string, { ts: number; verdict: ArbitrationVerdict | null }>,
  key: string,
  verdict: ArbitrationVerdict | null
) {
  if (cache.size >= ARBITRATION_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), verdict });
}
