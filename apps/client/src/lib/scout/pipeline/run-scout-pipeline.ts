import { prisma } from '@/lib/db';
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
  /** URL 预检产物：显式分支（与仓库默认分支相同时视为未指定） */
  urlBranch?: string;
  inspectionFilePath?: string;
  inspectionResourceType?: string;
  signal?: AbortSignal;
}

/**
 * scout 核心探测管道：快速响应，只负责元数据、树扫描与多语言目录匹配，
 * 重度大纲留给 Step 2 按需生成。
 *
 * 阶段顺序与并行关系（SSE 事件序）固定：
 *   meta(仓库解析) → tree(扫描) → [sha‖] → 归档/树 → 画像 →
 *   tree(本地画像) → [作用域裁决‖形态仲裁] → 确定性元数据打标 →
 *   dedup(智能定位/同源检测/候选目录) → dedup(已推荐) → 结果组装
 *
 * 目标目录裁决（scope-verdict）在树就绪后异步先行，与形态仲裁/同源检测
 * 并行，仅结果组装前收口；失败 fail-closed 为 null（无推荐，人工选择）。
 */
export async function runScoutPipeline(
  input: ScoutPipelineInput,
  context: ScoutPipelineContext,
  onStep?: ScoutStepReporter
): Promise<ScoutPipelineResult> {
  const { owner, repo, userId } = input;

  // -------------------------------------------------------------
  // STAGE 1: META - 仓库前置存在性探测与元数据校验
  // -------------------------------------------------------------
  const { githubToken, meta } = await fetchRepoMeta(owner, repo, userId);

  const urlBranch = context.urlBranch && context.urlBranch !== ENGINE_CONFIG.defaultBranch
    ? context.urlBranch
    : undefined;
  const activeBranch = urlBranch || meta.defaultBranch;
  // 生效前缀过滤：显式 prefixFilter 优先，否则 URL 命中子路径（仅 resourceType=tree）
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

  // -------------------------------------------------------------
  // STAGE 2: DEDUP - 智能查重与已有教程校验（前置毫秒级判定）
  // -------------------------------------------------------------
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

  // -------------------------------------------------------------
  // STAGE 3: DOWNLOAD & PROFILE - 下载即验证，本地即画像
  // -------------------------------------------------------------
  // 解析分支当前最新 commit sha（缓存查找钥匙；失败不阻断 scout，hasUpdate 归 null）。
  // 先启动不 await，与下方进度事件并行。
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

  // -------------------------------------------------------------
  // STAGE 3.6: 目标目录裁决（异步先行）——「哪个目录是教程主体」是意图
  // 判断，归 LLM（结合 README 自述与拓扑判断普通项目型 vs 教程书籍型）。
  // 与形态仲裁、同源检测并行执行，仅在候选目录组装前 await；
  // 失败 fail-closed 返回 null → 无自动推荐，用户在确认页手选。
  // -------------------------------------------------------------
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
        // 网络读取异常不阻断，降级空 README
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

  // -------------------------------------------------------------
  // STAGE 3.5: 灰区仲裁——规则判 text_only 但代码物理质量成规模时，
  // 由 LLM 依据目录结构证据裁决教学主体（产品代码库带手册 vs 书籍仓带
  // 示例代码）。非灰区零 LLM 直通；裁定随画像流入信封（Go 侧
  // mergeProvidedProfile 消费）与向导分叉（menuStyle/大纲流）。必须在
  // 向导按 ingestMode 分叉之前完成——事后翻案会被用户已确认的大纲
  // （更高权威证据）压住。
  // -------------------------------------------------------------
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

  // -------------------------------------------------------------
  // STAGE 2.5: METADATA - 未分类占位（分类/打标已折叠进大纲 LLM 伴生产出，
  // 入库侧经 TagRegistry 封闭词表归一；探测阶段零 LLM、零推断）
  // -------------------------------------------------------------
  const { aiCategory, aiTags, paradigm, parallelTracks } = DEFAULT_METADATA;

  // -------------------------------------------------------------
  // STAGE 4: VERSIONS - 智能定位教程核心目录
  // -------------------------------------------------------------
  // 同源相似检测（建议性横幅数据，零拦截；异常静默——检测是增强能力非关键路径）
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

  const scopeVerdict = await scopeVerdictPromise.catch(() => null);
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

  // 冻结语义的"更新检测"：当前最新 commit vs 该仓库最近一次导入的 commit。
  // 仅提示，不自动更新——用户教程只在用户主动重新导入时才更新。
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

/** 路由层预检：返回 403 错误体（用户仓库数超限），允许导入时返回 null */
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
