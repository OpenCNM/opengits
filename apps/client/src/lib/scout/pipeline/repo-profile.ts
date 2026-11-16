import { prisma } from '@/lib/db';
import type { GitHubNode } from '@/engine/fetcher';
import { toRepoProfile } from './repo-meta';
import type { RepoProfile } from '@/engine/repo-sniffer';
import { executeSidecarSniff } from '@/engine/sniffer-driver';

export interface RepoProfileOptions {
  owner: string;
  repo: string;
  /** 活动分支（DB 快捷路径按 owner+repo+branch 定位仓库记录） */
  branch: string;
  currentSha: string | null;
  archiveUsed: boolean;
  tree: GitHubNode[];
  /** 非空作用域键禁用 DB 快捷路径（作用域画像不落库复用） */
  scopeKey: string;
  userId: string;
}

/**
 * STAGE 2 (画像)：纯本地/Sidecar 毫秒级画像（零 LLM、零 Token 消耗、<10ms）——
 * 1) DB 快捷路径：仓库最近导入 sha 与当前一致且无作用域过滤 → 直接复用已落库 repoProfile
 * 2) 确定性规则画像：Go Sidecar executeSidecarSniff 单实现（Fail-Closed）
 */
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
      // DB 读取异常不阻断，继续走规则嗅探（sidecar 单实现）
    }
  }

  // Go sidecar 单实现（Fail-Closed，2026-09-11 收刀）：本地 sniffRepo 双轨已物理删除
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
    // 数据库复用时，确保 translationRoots 与当前规则一致
    const ruleProfile = await sniffWithFallback();
    if (ruleProfile.translationRoots.length > 0) {
      repoProfile.translationRoots = ruleProfile.translationRoots;
      repoProfile.hasTranslations = true;
    }
    // 同步刷新物理质量统计：codeBytes/docBytes 为后加字段，存量画像缺省
    // （按 0 处理会压住灰区检测，同 sha 重导无法进仲裁）。同 sha 同归档，
    // 规则嗅探是确定性纯函数，刷新即对齐当前口径，无漂移风险。
    repoProfile.docCodeRatio = ruleProfile.docCodeRatio;
  }

  return repoProfile;
}
