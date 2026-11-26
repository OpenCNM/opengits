import { prisma } from '@/lib/db';
import { ignoreBestEffort } from '@/lib/best-effort';
import type { GitHubNode } from '@/engine/fetcher';
import { toRepoProfile } from './repo-meta';
import type { RepoProfile } from '@/engine/repo-sniffer';
import { executeSidecarSniff } from '@/engine/sniffer-driver';

export interface RepoProfileOptions {
  owner: string;
  repo: string;
  branch: string;
  currentSha: string | null;
  archiveUsed: boolean;
  tree: GitHubNode[];
  scopeKey: string;
  userId: string;
}

export async function buildRepoProfile(opts: RepoProfileOptions): Promise<RepoProfile> {
  const { owner, repo, branch, currentSha, tree, scopeKey, archiveUsed } = opts;

  let repoProfile: RepoProfile | null = null;

  if (!scopeKey && currentSha) {
    try {
      const existingRepo = await prisma.repository.findFirst({
        where: { owner, repo, branch },
        select: { gitSha: true, repoProfile: true },
      });
      if (existingRepo?.gitSha === currentSha) {
        repoProfile = toRepoProfile(structuredClone(existingRepo.repoProfile));
      }
    } catch {
      ignoreBestEffort();
    }
  }

  const sniffWithFallback = async (): Promise<RepoProfile> => {
    const sidecarRes = await executeSidecarSniff(
      archiveUsed && currentSha
        ? { owner, repo, sha: currentSha }
        : { nodes: tree }
    );
    return sidecarRes.profile;
  };

  if (!repoProfile) {
    repoProfile = await sniffWithFallback();
  } else {
    const ruleProfile = await sniffWithFallback();
    if (ruleProfile.translationRoots.length > 0) {
      repoProfile.translationRoots = ruleProfile.translationRoots;
      repoProfile.hasTranslations = true;
    }
    // Always refresh docCodeRatio even on SHA cache hit because older profiles may lack byte counters.
    repoProfile.docCodeRatio = ruleProfile.docCodeRatio;
  }

  return repoProfile;
}
