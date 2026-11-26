import { prisma } from '@/lib/db';
import { ignoreBestEffort } from '@/lib/best-effort';
import { checkRepoDuplicates } from '@/lib/repo-dedup';
import { checkRepoLimit, repoLimitErrorResponse } from '@/lib/tiers';
import { buildDirTree, type DirTreeNode } from '@/lib/dir-verdict';
import { ENGINE_CONFIG } from '@/lib/config';
import type { GitHubNode, ExclusionReport } from '@/engine/fetcher';
import type { RepoProfile } from '@/engine/repo-sniffer';
import { executeSidecarScoutInspect } from '@/engine/scout-driver';
import { SidecarError } from '@/lib/sidecar-client';
import {
  ScoutDedupInfo,
  ScoutPipelineInput,
  ScoutPipelineResult,
  ScoutStepReporter,
  SameSourceSummary,
  ScoutTree,
  ScoutPipelineError,
  isScoutPipelineError,
} from './types';
import { fetchRepoMeta } from './repo-meta';
import { collectScopedMarkdownFiles, resolveCurrentSha, resolveScoutTree } from './tree-resolver';
import { buildRepoProfile } from './repo-profile';
import { arbitrateIngestMode } from './ingest-mode-arbiter';
import { arbitrateScopeVerdict, toDirVerdict } from './scope-verdict';
import { attachVersionStats, buildVersionCandidates } from './version-candidates';
import { DEFAULT_METADATA } from './metadata-ai';
import { githubFetch } from '@/lib/github/client';

export type { ScoutPipelineInput, ScoutPipelineResult, ScoutStepInfo, ScoutStepReporter } from './types';

export interface ScoutPipelineContext {
  urlBranch?: string;
  inspectionFilePath?: string;
  inspectionResourceType?: string;
  signal?: AbortSignal;
}

export async function runScoutPipeline(
  input: ScoutPipelineInput,
  context: ScoutPipelineContext,
  onStep?: ScoutStepReporter
): Promise<ScoutPipelineResult> {
  const { owner, repo, userId } = input;

  const { githubToken, meta } = await fetchRepoMeta(owner, repo, userId);

  const urlBranch = context.urlBranch && context.urlBranch !== ENGINE_CONFIG.defaultBranch
    ? context.urlBranch
    : undefined;
  const activeBranch = urlBranch || meta.defaultBranch;
  const effectivePrefixFilter =
    input.prefixFilter ||
    (context.inspectionResourceType === 'tree' && (input.filePath || context.inspectionFilePath)
      ? (input.filePath || context.inspectionFilePath)
      : undefined);

  const formattedDate = meta.pushedAt ? new Date(meta.pushedAt).toISOString().split('T')[0] : '最近';
  const upstreamText = meta.upstream ? ` · 派生自 ${meta.upstream.owner}/${meta.upstream.repo}` : '';
  if (onStep) {
    await onStep({
      stage: 'meta',
      tag: '仓库解析',
      title: `解析 GitHub 仓库: ${owner}/${repo}`,
      detail: `${meta.starCount.toLocaleString()} Stars · 最近更新: ${formattedDate}${upstreamText}`,
    });
  }

  const dedupInfo = await checkRepoDuplicates({
    owner,
    repo,
    userId,
    upstream: meta.upstream,
  });

  const dedupMsg = dedupInfo?.existingRepo
    ? `系统内置已有教程 (${dedupInfo.existingRepo.owner}/${dedupInfo.existingRepo.repo})`
    : '校验通过，无历史重名冲突';

  if (onStep) {
    await onStep({
      stage: 'dedup',
      tag: '智能查重',
      title: dedupInfo?.existsInExplore || dedupInfo?.existsOnShelf ? '检测到已有公开教程' : '校验通过，准备扫描目录树',
      detail: dedupMsg,
    });
  }

  const shaPromise = resolveCurrentSha(owner, repo, activeBranch, githubToken);

  if (onStep) {
    await onStep({
      stage: 'tree',
      tag: '仓库解析',
      title: '正在扫描仓库文件拓扑树...',
      detail: `拉取 ${owner}/${repo}@${activeBranch} 文件目录树结构...`,
    });
  }

  const currentSha = await shaPromise;

  let archiveUsed = false;
  let markdownFiles: GitHubNode[];
  let repoProfile: RepoProfile;
  let dirTree: DirTreeNode[];
  let exclusionReport: ExclusionReport | undefined;
  let skeleton: string | undefined;
  let skeletonHash: string | undefined;
  let totalNodeCount = 0;
  let fallbackTree: ScoutTree | null = null;
  let readmeSnippet = '';

  try {
    const sidecarRes = await executeSidecarScoutInspect({
      owner,
      repo,
      branch: activeBranch,
      sha: currentSha,
      token: githubToken,
      prefixFilter: effectivePrefixFilter,
      filePath: input.filePath || (context.inspectionResourceType === 'tree' ? context.inspectionFilePath : undefined),
      singleDocMode: input.importScopeMode === 'single_doc',
      stars: meta.starCount,
    }, {
      signal: context.signal,
    });

    archiveUsed = sidecarRes.archiveUsed;
    markdownFiles = sidecarRes.markdownFiles;
    repoProfile = sidecarRes.profile;
    dirTree = sidecarRes.dirTree;
    exclusionReport = sidecarRes.exclusionReport;
    skeleton = sidecarRes.skeleton;
    skeletonHash = sidecarRes.skeletonHash;
    totalNodeCount = sidecarRes.totalNodeCount;
    readmeSnippet = sidecarRes.readmeSnippet || '';
  } catch (err) {
    if (isScoutPipelineError(err)) {
      throw err;
    }
    if (err instanceof SidecarError && err.status !== undefined && err.status >= 400 && err.status < 500) {
      if (err.status === 404) {
        throw new ScoutPipelineError({
          status: 'NOT_FOUND',
          error: '未找到该 GitHub 仓库',
          diagnosticDescription: '仓库可能不存在、已被更名/删除，或属于未提供 Token 授权的私有仓库。',
          suggestedFormat: 'https://github.com/owner/repo',
          httpStatus: 404,
        });
      }
      if (err.status === 401) {
        throw new ScoutPipelineError({
          status: 'GITHUB_TOKEN_EXPIRED',
          error: '你绑定的 GitHub 授权已失效，请到设置中重新绑定后再导入',
          diagnosticDescription: '你绑定的 GitHub 授权已失效，请到设置中重新绑定后再导入。',
          suggestedFormat: 'https://github.com/owner/repo',
          httpStatus: 401,
          extra: { code: 'GITHUB_TOKEN_EXPIRED' },
        });
      }
      if (err.status === 403) {
        throw new ScoutPipelineError({
          status: 'RATE_LIMITED',
          error: 'GitHub API 请求频繁或无权限访问',
          diagnosticDescription: '触发了 GitHub API 限流频率控制，或当前 Token 无权限访问该仓库。',
          suggestedFormat: 'https://github.com/owner/repo',
          httpStatus: 403,
        });
      }
      throw err;
    }
    console.warn('[scout] Sidecar scout inspection failed, falling back to local pipeline:', err);
    if (onStep) {
      await onStep({
        stage: 'tree',
        tag: '本地降级',
        title: '引擎降级本地扫描',
        detail: 'Sidecar 暂不可用或超时，已自动切换为本地扫描管线',
      });
    }
    const resolved = await resolveScoutTree(owner, repo, activeBranch, currentSha, githubToken);
    fallbackTree = resolved.tree;
    archiveUsed = resolved.archiveUsed;
    totalNodeCount = fallbackTree.length;

    markdownFiles = collectScopedMarkdownFiles(fallbackTree, {
      prefixFilter: effectivePrefixFilter,
      filePath: input.filePath,
      inspectionFilePath: context.inspectionResourceType === 'tree' ? context.inspectionFilePath : undefined,
      singleDocMode: input.importScopeMode === 'single_doc',
    });

    const scopeKey = effectivePrefixFilter ? effectivePrefixFilter.replace(/\/$/, '') : '';

    repoProfile = await buildRepoProfile({
      owner,
      repo,
      branch: activeBranch,
      currentSha,
      archiveUsed,
      tree: fallbackTree,
      scopeKey,
      userId,
    });

    dirTree = buildDirTree(fallbackTree);
    exclusionReport = fallbackTree.exclusionReport;
  }

  if (onStep) {
    await onStep({
      stage: 'tree',
      tag: '本地画像',
      title: archiveUsed ? '仓库快照本地就绪，画像完成' : 'Git 目录树扫描完成',
      detail: `${totalNodeCount.toLocaleString()} 个文件节点 · ${archiveUsed ? '来自本地归档' : '来自 GitHub API'} · 锁定正文路径: ${repoProfile.textRoot || '/'}`,
    });
  }

  if (!readmeSnippet && markdownFiles.length > 0) {
    const rootReadme = markdownFiles.find(
      (n) => !n.path.includes('/') && /^readme(\.md|\.rst|\.txt)?$/i.test(n.path)
    );
    if (rootReadme) {
      try {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${currentSha || activeBranch}/${rootReadme.path}`;
        const res = await githubFetch(rawUrl, {}, {
          endpointClass: 'raw',
          explicitToken: githubToken,
          userId,
        });
        if (res.ok) {
          const text = await res.text();
          readmeSnippet = text.slice(0, 3000);
        }
      } catch {
        ignoreBestEffort();
      }
    }
  }

  const scopeVerdictPromise = arbitrateScopeVerdict({
    dirTree,
    markdownFiles,
    docCodeRatio: repoProfile.docCodeRatio,
    owner,
    repo,
    sha: currentSha,
    userId,
    targetLanguage: input.targetLanguage,
    readmeSnippet,
  });

  // Arbitrate gray-zone ingestMode before the wizard branches on menuStyle/outline flow.
  const arbitration = await arbitrateIngestMode({
    profile: repoProfile,
    dirTree,
    markdownFiles,
    owner,
    repo,
    sha: currentSha,
    userId,
  });
  repoProfile = arbitration.profile;
  if (arbitration.arbitrated || arbitration.fallback) {
    if (onStep) {
      await onStep({
        stage: 'tree',
        tag: '形态仲裁',
        title: arbitration.arbitrated
          ? '识别为代码课程形态：代码将成为教学骨干，手册作为附页'
          : '仓库形态仲裁不可用，按文档教程处理',
        detail:
          arbitration.rationale ||
          '代码与文档规模相当，规则无法独断；本次回落规则裁定（不产生额外 AI 消耗）',
      });
    }
  }

  const { aiCategory, aiTags, paradigm, parallelTracks } = DEFAULT_METADATA;

  let sameSource: SameSourceSummary | null = null;
  try {
    const { runSourceDetection } = await import('@/lib/similarity/service');
    const { summarizeDetection } = await import('@/lib/similarity/cluster');
    const detection = await runSourceDetection({
      owner,
      repo,
      branch: activeBranch,
      gitSha: currentSha,
      treeNodes: fallbackTree,
      existingSignature: skeleton ? { skeleton, skeletonHash } : undefined,
      forkUpstream: meta.upstream,
    });
    sameSource = summarizeDetection(detection);
  } catch (err) {
    console.warn('[scout] source detection skipped:', err);
  }

  const scopeVerdict = await scopeVerdictPromise.catch(() => { ignoreBestEffort(); return null; });
  const { versions: finalVersions } = buildVersionCandidates({
    repoProfileTextRoot: repoProfile.textRoot,
    repoProfileTranslationRoots: repoProfile.translationRoots,
    markdownFiles,
    inspectionFilePath: context.inspectionResourceType === 'tree' ? context.inspectionFilePath : undefined,
    verdict: scopeVerdict ? toDirVerdict(scopeVerdict) : null,
  });
  const versionsWithStats = attachVersionStats(finalVersions, markdownFiles);

  if (onStep) {
    await onStep({
      stage: 'dedup',
      tag: '智能定位',
      title: scopeVerdict ? 'AI 已锁定教程主体目录' : '候选目录就绪，请在确认页选择',
      detail: scopeVerdict
        ? `锁定正文路径: ${scopeVerdict.targetRoot || '/'} · 识别 ${scopeVerdict.auxiliaryPaths.length} 个辅助目录`
        : `发现 ${versionsWithStats.length} 个候选目录 · ${dedupMsg}`,
    });
  }

  // Surface upstream commit mismatch as an update notice only; tutorials remain frozen until user-triggered sync.
  const existingGitSha = dedupInfo?.existingRepo?.gitSha ?? null;
  const hasUpdate = Boolean(currentSha && existingGitSha && currentSha !== existingGitSha);

  const dedupPayload: ScoutDedupInfo = {
    ...dedupInfo,
    currentSha,
    importedSha: existingGitSha,
    hasUpdate,
  };

  const enrichedProfile: RepoProfile = meta.description?.trim() && !repoProfile.description
    ? { ...repoProfile, description: meta.description.trim() }
    : repoProfile;

  return {
    owner,
    repo,
    branch: activeBranch,
    currentSha,
    starCount: meta.starCount,
    pushedAt: meta.pushedAt,
    profile: enrichedProfile,
    versions: versionsWithStats,
    dirTree,
    aiCategory,
    aiTags,
    paradigm,
    parallelTracks,
    exclusionReport: exclusionReport || fallbackTree?.exclusionReport,
    dedupInfo: dedupPayload,
    sameSource,
    scopeVerdict,
  };
}

export async function getRepoImportQuotaError(
  userId: string,
  owner: string,
  repo: string
): Promise<ReturnType<typeof repoLimitErrorResponse> | null> {
  const tierUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { tier: true, role: true },
  });
  const repoLimit = await checkRepoLimit(userId, {
    role: tierUser?.role,
    tier: tierUser?.tier,
    targetRepo: { owner, repo },
  });
  if (!repoLimit.allowed) {
    return repoLimitErrorResponse(userId, repoLimit);
  }
  return null;
}

export type { ScoutTree } from './types';
