import { describe, it, expect } from 'vitest';
import {
  dissectSearchQuery,
  matchRepoWithSmartQuery,
  calculateSourceTypeCounts,
} from '@/lib/search/smart-repo-search';
import type { DisplayRepo } from '@/lib/home-data';

describe('dashboard-smart-search', () => {
  const mockRepos: DisplayRepo[] = [
    {
      id: 'repo-1',
      owner: 'vllm-project',
      repo: 'vllm',
      title: 'vLLM',
      category: 'AI',
      description: 'A high-throughput and memory-efficient LLM serving engine',
      isPublic: true,
      chapterCount: 10,
      processedDocsCount: 10,
      isFullyTranscribed: true,
      isSaved: false,
      savedCount: 10,
      progress: 0,
      viewedCount: 10,
      hasUpdate: false,
      importedSha: null,
      isPinned: false,
    },
    {
      id: 'repo-2',
      owner: 'web-doc',
      repo: 'cilium-docs',
      title: 'Cilium Documentation',
      category: 'Systems',
      description: 'eBPF-based Networking, Security, and Observability',
      repoProfile: {
        siteTitle: 'Cilium',
        originalUrl: 'https://docs.cilium.io/en/stable/',
        sourceType: 'web',
      },
      isPublic: true,
      chapterCount: 50,
      processedDocsCount: 50,
      isFullyTranscribed: true,
      isSaved: false,
      savedCount: 5,
      progress: 0,
      viewedCount: 20,
      hasUpdate: false,
      importedSha: null,
      isPinned: false,
    },
    {
      id: 'repo-3',
      owner: 'karpathy',
      repo: 'llm.c',
      title: 'llm.c',
      category: 'AI',
      description: 'LLM training in simple pure C/CUDA',
      isPublic: true,
      chapterCount: 5,
      processedDocsCount: 5,
      isFullyTranscribed: true,
      isSaved: false,
      savedCount: 100,
      progress: 0,
      viewedCount: 200,
      hasUpdate: false,
      importedSha: null,
      isPinned: false,
    },
    {
      id: 'repo-4',
      owner: 'web-doc',
      repo: 'cloudflare-workerd',
      title: 'cloudflare-workerd',
      category: 'Cloud',
      description: 'JavaScript/Wasm runtime',
      repoProfile: {
        siteTitle: 'cloudflare-workerd',
        originalUrl: 'https://github.com/cloudflare/workerd',
        sourceType: 'web',
      },
      isPublic: true,
      chapterCount: 20,
      processedDocsCount: 20,
      isFullyTranscribed: true,
      isSaved: false,
      savedCount: 5,
      progress: 0,
      viewedCount: 15,
      hasUpdate: false,
      importedSha: null,
      isPinned: false,
    },
  ];

  it('dissects raw queries, GitHub URLs, and web URLs properly', () => {
    expect(dissectSearchQuery('vllm')).toEqual({
      raw: 'vllm',
      isUrl: false,
      cleanQuery: 'vllm',
    });

    expect(dissectSearchQuery('karpathy/llm.c')).toEqual({
      raw: 'karpathy/llm.c',
      isUrl: false,
      cleanQuery: 'karpathy/llm.c',
      candidateOwner: 'karpathy',
      candidateRepo: 'llm.c',
    });

    expect(dissectSearchQuery('https://github.com/vllm-project/vllm')).toEqual({
      raw: 'https://github.com/vllm-project/vllm',
      isUrl: true,
      cleanQuery: 'vllm-project/vllm',
      candidateOwner: 'vllm-project',
      candidateRepo: 'vllm',
      hostname: 'github.com',
    });

    expect(dissectSearchQuery('https://docs.cilium.io/en/stable/')).toEqual({
      raw: 'https://docs.cilium.io/en/stable/',
      isUrl: true,
      cleanQuery: 'en stable',
      candidateRepo: 'en',
      hostname: 'docs.cilium.io',
    });
  });

  it('matches full GitHub URLs against existing repositories without leaking to other GitHub webdocs', () => {
    // When searching vllm, it should NOT match cloudflare-workerd even though workerd has a github.com originalUrl
    const matched = mockRepos.filter((r) =>
      matchRepoWithSmartQuery(r, 'https://github.com/vllm-project/vllm')
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe('repo-1');

    // When searching for the exact GitHub URL of a WebDoc, it should match that WebDoc
    const matchedWebDoc = mockRepos.filter((r) =>
      matchRepoWithSmartQuery(r, 'https://github.com/cloudflare/workerd')
    );
    expect(matchedWebDoc).toHaveLength(1);
    expect(matchedWebDoc[0].id).toBe('repo-4');

    // Searching a specific GitHub URL like xtls/xray-core should never match unrelated GitHub-based WebDocs
    expect(
      matchRepoWithSmartQuery(
        {
          owner: 'web-doc',
          repo: 'bpftrace-docs',
          repoProfile: {
            originalUrl: 'https://github.com/bpftrace/bpftrace/blob/master/man/adoc/bpftrace.adoc',
            sourceType: 'web',
          },
        } as any,
        'https://github.com/xtls/xray-core'
      )
    ).toBe(false);
  });

  it('matches WebDoc URLs via hostname', () => {
    const matched = mockRepos.filter((r) =>
      matchRepoWithSmartQuery(r, 'https://docs.cilium.io/some-page')
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe('repo-2');
  });

  it('filters by source type (github vs webdoc)', () => {
    const githubOnly = mockRepos.filter((r) =>
      matchRepoWithSmartQuery(r, '', 'github')
    );
    expect(githubOnly).toHaveLength(2);
    expect(githubOnly.map((r) => r.id)).toEqual(['repo-1', 'repo-3']);

    const webdocOnly = mockRepos.filter((r) =>
      matchRepoWithSmartQuery(r, '', 'webdoc')
    );
    expect(webdocOnly).toHaveLength(2);
    expect(webdocOnly.map((r) => r.id)).toEqual(['repo-2', 'repo-4']);
  });

  it('orthogonal source and category filtering', () => {
    // AI + GitHub
    const aiGithub = mockRepos.filter((r) =>
      matchRepoWithSmartQuery(r, '', 'github', 'AI')
    );
    expect(aiGithub).toHaveLength(2);

    // AI + WebDoc (no match)
    const aiWebdoc = mockRepos.filter((r) =>
      matchRepoWithSmartQuery(r, '', 'webdoc', 'AI')
    );
    expect(aiWebdoc).toHaveLength(0);

    // Systems + WebDoc
    const systemsWeb = mockRepos.filter((r) =>
      matchRepoWithSmartQuery(r, '', 'webdoc', 'Systems')
    );
    expect(systemsWeb).toHaveLength(1);
    expect(systemsWeb[0].id).toBe('repo-2');

    // Cloud + WebDoc
    const cloudWeb = mockRepos.filter((r) =>
      matchRepoWithSmartQuery(r, '', 'webdoc', 'Cloud')
    );
    expect(cloudWeb).toHaveLength(1);
    expect(cloudWeb[0].id).toBe('repo-4');
  });

  it('supports hashtag queries and Chinese domain matching', () => {
    const taggedRepo: DisplayRepo = {
      ...mockRepos[0],
      tags: ['CUDA', 'vLLM'],
    };

    // 1. Hashtag matching on tags
    expect(matchRepoWithSmartQuery(taggedRepo, '#CUDA')).toBe(true);
    expect(matchRepoWithSmartQuery(taggedRepo, '#cuda')).toBe(true);
    expect(matchRepoWithSmartQuery(taggedRepo, '#vLLM')).toBe(true);

    // 2. Hashtag matching on description/title when stripped
    expect(matchRepoWithSmartQuery(mockRepos[2], '#CUDA')).toBe(true);

    // 3. Category Chinese alias matching
    expect(matchRepoWithSmartQuery(taggedRepo, '', 'all', '云原生')).toBe(false);
    expect(matchRepoWithSmartQuery(taggedRepo, '', 'all', 'AI / 大模型')).toBe(true);
    expect(matchRepoWithSmartQuery(taggedRepo, '', 'all', '人工智能')).toBe(true);
  });

  it('correctly calculates source type counts', () => {
    const counts = calculateSourceTypeCounts(mockRepos);
    expect(counts).toEqual({
      all: 4,
      github: 2,
      webdoc: 2,
    });
  });

  it('matches keyword inside repo.description and repoProfile.siteTitle', () => {
    const webRepoWithDesc: DisplayRepo = {
      ...mockRepos[1],
      description: '基于 eBPF 的 Kubernetes 高性能服务网络与安全框架',
      repoProfile: {
        siteTitle: 'Cilium eBPF 云原生网络与安全',
      },
    };
    expect(matchRepoWithSmartQuery(webRepoWithDesc, 'Kubernetes')).toBe(true);
    expect(matchRepoWithSmartQuery(webRepoWithDesc, '高性能服务网络')).toBe(true);
    expect(matchRepoWithSmartQuery(webRepoWithDesc, 'Cilium')).toBe(true);
  });

  it('fails closed for non-matching WebDoc URLs without leaking into substring keyword fuzzing', () => {
    const buck2Docs: DisplayRepo = {
      ...mockRepos[1],
      id: 'buck2',
      owner: 'web-doc',
      repo: 'buck2-docs',
      title: 'Buck2 高性能构建系统官方指南',
      description: 'Meta 开源的 Rust 构建工具，面向超大规模单体代码库的高并发构建',
      tags: ['Build System', 'Rust', 'Tooling'],
      repoProfile: {
        siteTitle: 'Buck2 高性能构建系统官方指南',
        originalUrl: 'https://buck2.build/docs/about/why/',
        sourceType: 'web',
      },
    };

    // Regression: "https://coss.com/ui/docs" previously fell back to tokens ["ui", "docs"],
    // matching "Build System" ("ui" in "Build") + "buck2-docs" ("docs").
    expect(matchRepoWithSmartQuery(buck2Docs, 'https://coss.com/ui/docs')).toBe(false);

    // Reject hostname substring / subdomain collisions
    const subOrLookalike: DisplayRepo = {
      ...mockRepos[1],
      id: 'sub-coss',
      repoProfile: {
        originalUrl: 'https://sub.coss.com/ui/docs',
        sourceType: 'web',
      },
    };
    const evilLookalike: DisplayRepo = {
      ...mockRepos[1],
      id: 'evil-coss',
      repoProfile: {
        originalUrl: 'https://coss.com.example.org/ui/docs',
        sourceType: 'web',
      },
    };
    expect(matchRepoWithSmartQuery(subOrLookalike, 'https://coss.com/ui/docs')).toBe(false);
    expect(matchRepoWithSmartQuery(evilLookalike, 'https://coss.com/ui/docs')).toBe(false);

    // Respect allowedPrefixes on shared hosts while normalizing www.
    const cossUi: DisplayRepo = {
      ...mockRepos[1],
      id: 'coss-ui',
      repo: 'coss-ui',
      repoProfile: {
        originalUrl: 'https://www.coss.com/ui/docs',
        allowedPrefixes: ['/ui'],
        sourceType: 'web',
      },
    };
    const cossAi: DisplayRepo = {
      ...mockRepos[1],
      id: 'coss-ai',
      repo: 'coss-ai',
      repoProfile: {
        originalUrl: 'https://coss.com/ai/docs',
        allowedPrefixes: ['/ai'],
        sourceType: 'web',
      },
    };
    expect(matchRepoWithSmartQuery(cossUi, 'https://coss.com/ui/docs')).toBe(true);
    expect(matchRepoWithSmartQuery(cossAi, 'https://coss.com/ui/docs')).toBe(false);

    // Generic GitHub org URL should not fall through to keyword substring match
    expect(matchRepoWithSmartQuery(mockRepos[0], 'https://github.com/serving')).toBe(false);
    expect(matchRepoWithSmartQuery(mockRepos[0], 'https://github.com/vllm-project')).toBe(true);
  });
});
