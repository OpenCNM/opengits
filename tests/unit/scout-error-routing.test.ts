import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runScoutPipeline } from '@/lib/scout/pipeline/run-scout-pipeline';
import { ScoutPipelineError } from '@/lib/scout/pipeline/types';
import { SidecarError } from '@/lib/sidecar-client';
import * as scoutDriver from '@/engine/scout-driver';
import * as snifferDriver from '@/engine/sniffer-driver';
import * as treeResolver from '@/lib/scout/pipeline/tree-resolver';
import * as repoMetaModule from '@/lib/scout/pipeline/repo-meta';
import { inspectGithubUrl } from '@/lib/url-inspector';
import { archiveDirFor } from '@/engine/tarball/archive-store';
import { collectScopedMarkdownFiles } from '@/lib/scout/pipeline/tree-resolver';
import type { GitHubNode } from '@/engine/fetcher';

// 需真实 PostgreSQL：Item 3 组的 runScoutPipeline 内部 repo-dedup
// （prisma.repository.findMany）与 tier 配额（prisma.user.findUnique）均走真实
// prisma 查询（prisma 连接串读 DATABASE_URL）。门控沿用 go-sidecar job 同款惯例：
// 仅认显式注入的 WORKER_TEST_DATABASE_URL（未注入时整组自动 skip）——
// 不直接认 DATABASE_URL，因其会被 ai.ts 顶部的 dotenv.config(override) 从本地
// .env 静默注入（本机凭据未必可用，门形同虚设）。纯函数组（路径匹配/归一化/403
// 判别）不依赖 DB，无条件执行。
const HAS_TEST_DB = Boolean(process.env.WORKER_TEST_DATABASE_URL);

describe('Scout error routing and pipeline hardening (Item 3, 4, 7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe.skipIf(!HAS_TEST_DB)('Sidecar 4xx terminal error vs 5xx fallback routing (Item 3)', () => {
    const defaultMeta = {
      description: 'Test Repo',
      topics: [],
      starCount: 10,
      pushedAt: '2026-01-01T00:00:00Z',
      defaultBranch: 'main',
      upstream: null,
      repoSizeBytes: 1024,
      language: 'TypeScript',
    };

    it('re-throws 404 terminal error directly without falling back to local tree API', async () => {
      vi.spyOn(repoMetaModule, 'fetchRepoMeta').mockResolvedValue({
        githubToken: 'gh-tok',
        meta: defaultMeta,
      });

      vi.spyOn(scoutDriver, 'executeSidecarScoutInspect').mockRejectedValue(
        new SidecarError('sidecar 404', 404)
      );

      const resolveSpy = vi.spyOn(treeResolver, 'resolveScoutTree');

      await expect(
        runScoutPipeline(
          { owner: 'test-owner', repo: 'not-found-repo', userId: 'u1' },
          {}
        )
      ).rejects.toMatchObject({
        scoutStatus: 'NOT_FOUND',
        httpStatus: 404,
      });

      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('re-throws 401 terminal error directly without falling back', async () => {
      vi.spyOn(repoMetaModule, 'fetchRepoMeta').mockResolvedValue({
        githubToken: 'gh-tok',
        meta: defaultMeta,
      });

      vi.spyOn(scoutDriver, 'executeSidecarScoutInspect').mockRejectedValue(
        new SidecarError('sidecar 401', 401)
      );

      const resolveSpy = vi.spyOn(treeResolver, 'resolveScoutTree');

      await expect(
        runScoutPipeline(
          { owner: 'test-owner', repo: 'expired-token-repo', userId: 'u1' },
          {}
        )
      ).rejects.toMatchObject({
        scoutStatus: 'GITHUB_TOKEN_EXPIRED',
        httpStatus: 401,
      });

      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('re-throws 403 terminal error directly without falling back', async () => {
      vi.spyOn(repoMetaModule, 'fetchRepoMeta').mockResolvedValue({
        githubToken: 'gh-tok',
        meta: defaultMeta,
      });

      vi.spyOn(scoutDriver, 'executeSidecarScoutInspect').mockRejectedValue(
        new SidecarError('sidecar 403', 403)
      );

      const resolveSpy = vi.spyOn(treeResolver, 'resolveScoutTree');

      await expect(
        runScoutPipeline(
          { owner: 'test-owner', repo: 'forbidden-repo', userId: 'u1' },
          {}
        )
      ).rejects.toMatchObject({
        scoutStatus: 'RATE_LIMITED',
        httpStatus: 403,
      });

      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('falls back to local pipeline on 500/timeout and emits downgrade log step', async () => {
      vi.spyOn(repoMetaModule, 'fetchRepoMeta').mockResolvedValue({
        githubToken: 'gh-tok',
        meta: defaultMeta,
      });

      vi.spyOn(scoutDriver, 'executeSidecarScoutInspect').mockRejectedValue(
        new SidecarError('sidecar 500 Internal Error', 500)
      );

      // 画像嗅探（Stage 2）非本测试对象：mock 最小画像，杜绝随本机 sidecar
      // 死活漂移的真实网络调用（ECONNREFUSED 时该测试 env-coupled 失败）
      vi.spyOn(snifferDriver, 'executeSidecarSniff').mockResolvedValue({
        profile: {
          tier: 'docs',
          textRoot: 'docs/',
          languageHubs: {},
          globalAssets: { pdfs: [], translations: [], buildScripts: [], misc: [] },
          labRoots: [],
          translationRoots: [],
          excludeFromNav: [],
          ingestMode: 'hybrid',
          docCodeRatio: 0,
          hasTranslations: false,
        },
        scale: { scale: 'small', confidence: 0.9 },
      } as never);

      const mockTree: GitHubNode[] = [
        { path: 'README.md', type: 'blob', size: 100, mode: '100644', sha: 'sha1' },
        { path: 'docs/guide.md', type: 'blob', size: 200, mode: '100644', sha: 'sha2' },
      ];

      vi.spyOn(treeResolver, 'resolveScoutTree').mockResolvedValue({
        tree: Object.assign(mockTree, { truncated: false }),
        archiveUsed: false,
      });

      const stepEvents: Array<{ stage: string; tag: string; title: string }> = [];
      const onStep = async (step: any) => {
        stepEvents.push(step);
      };

      const result = await runScoutPipeline(
        { owner: 'test-owner', repo: 'test-repo', userId: 'u1' },
        {},
        onStep
      );

      expect(result).toBeDefined();
      expect(result.owner).toBe('test-owner');
      const downgradeStep = stepEvents.find((s) => s.title === '引擎降级本地扫描');
      expect(downgradeStep).toBeDefined();
      expect(downgradeStep?.tag).toBe('本地降级');
    });
  });

  describe('Single-doc exact path match priority (Item 7 - 2c)', () => {
    it('prioritizes exact path equality over endsWith suffix match', () => {
      const nodes: GitHubNode[] = [
        { path: 'README.md', type: 'blob', size: 100, mode: '100644', sha: 's1' },
        { path: 'packages/core/README.md', type: 'blob', size: 200, mode: '100644', sha: 's2' },
        { path: 'packages/ui/README.md', type: 'blob', size: 300, mode: '100644', sha: 's3' },
      ];

      const matched = collectScopedMarkdownFiles(nodes, {
        singleDocMode: true,
        filePath: 'README.md',
      });

      expect(matched).toHaveLength(1);
      expect(matched[0].path).toBe('README.md');
    });

    it('falls back to suffix match if exact match does not exist', () => {
      const nodes: GitHubNode[] = [
        { path: 'packages/core/docs/setup.md', type: 'blob', size: 200, mode: '100644', sha: 's1' },
        { path: 'docs/other.md', type: 'blob', size: 100, mode: '100644', sha: 's2' },
      ];

      const matched = collectScopedMarkdownFiles(nodes, {
        singleDocMode: true,
        filePath: 'setup.md',
      });

      expect(matched).toHaveLength(1);
      expect(matched[0].path).toBe('packages/core/docs/setup.md');
    });
  });

  describe('Case normalization (Item 4)', () => {
    it('inspectGithubUrl normalizes owner and repo to lowercase', () => {
      const res = inspectGithubUrl('https://github.com/Facebook/React');
      expect(res.isValid).toBe(true);
      expect(res.owner).toBe('facebook');
      expect(res.repo).toBe('react');
    });

    it('archiveDirFor normalizes owner, repo, and sha to lowercase', () => {
      const dir = archiveDirFor('Facebook', 'React', 'ABCDEF123456');
      expect(dir).toContain('/facebook/react/abcdef123456');
    });
  });

  describe('403 status discrimination in fetchRepoMeta (Item 7 - 1c)', () => {
    it('throws RATE_LIMITED when 403 has rate limit header', async () => {
      const clientModule = await import('@/lib/github/client');
      vi.spyOn(clientModule, 'githubFetch').mockResolvedValue(
        new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        })
      );

      await expect(
        repoMetaModule.fetchRepoMeta('owner', 'repo', 'u1')
      ).rejects.toMatchObject({
        scoutStatus: 'RATE_LIMITED',
        httpStatus: 403,
      });
    });

    it('throws FORBIDDEN when 403 lacks rate limit headers (private/unauthorized repo)', async () => {
      const clientModule = await import('@/lib/github/client');
      vi.spyOn(clientModule, 'githubFetch').mockResolvedValue(
        new Response(JSON.stringify({ message: 'Must have push access' }), {
          status: 403,
          headers: { 'x-ratelimit-remaining': '50' },
        })
      );

      await expect(
        repoMetaModule.fetchRepoMeta('owner', 'repo', 'u1')
      ).rejects.toMatchObject({
        scoutStatus: 'FORBIDDEN',
        displayError: '无权限访问该 GitHub 仓库',
        httpStatus: 403,
      });
    });
  });
});
