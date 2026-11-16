import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSidecarScoutInspect } from '@/engine/scout-driver';

describe('scout-driver (Zero-Tree Scout inspect via Go worker-sidecar)', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.INTERNAL_API_TOKEN;
    delete process.env.WORKER_SIDECAR_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('1.16.1.4 sidecar 离线或未配置令牌时抛 SidecarError', async () => {
    await expect(
      executeSidecarScoutInspect({ owner: 'facebook', repo: 'react', sha: 'a'.repeat(40) })
    ).rejects.toThrow(/sidecar unreachable|not configured/i);
  });

  it('1.16.1.3 sidecar 在线时透传请求并返回紧凑探测决策', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-secret-token';
    process.env.WORKER_SIDECAR_URL = 'http://localhost:8082';

    const mockResponse = {
      ok: true,
      archiveUsed: true,
      totalNodeCount: 1250,
      markdownFiles: [{ path: 'docs/intro.md', type: 'blob', size: 500 }],
      profile: {
        tier: 'docs',
        textRoot: 'docs/',
        languageHubs: {},
        globalAssets: { pdfs: [], translations: [], buildScripts: [], misc: [] },
        labRoots: [],
        translationRoots: [],
        excludeFromNav: [],
        hasTranslations: false,
        semanticTags: {},
      },
      scale: { scale: 'medium', confidence: 0.95 },
      dirTree: [
        {
          path: 'docs/',
          name: 'docs',
          depth: 1,
          mdCount: 1,
          totalFiles: 1,
          children: [],
        },
      ],
      exclusionReport: {
        totalExcludedCount: 5,
        byCategory: { archive: 2, executable: 1, office_media: 1, build_db: 1, oversized: 0 },
        sampleExcludedFiles: [],
      },
      skeleton: 'docs/intro.md\n',
      skeletonHash: 'd41d8cd98f00b204e9800998ecf8427e',
      truncated: false,
    };

    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      return {
        ok: true,
        status: 200,
        json: async () => mockResponse,
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await executeSidecarScoutInspect({
      owner: 'facebook',
      repo: 'react',
      branch: 'main',
      sha: 'a'.repeat(40),
      prefixFilter: 'docs/',
      singleDocMode: false,
    });

    expect(res.ok).toBe(true);
    expect(res.archiveUsed).toBe(true);
    expect(res.totalNodeCount).toBe(1250);
    expect(res.markdownFiles).toHaveLength(1);
    expect(res.dirTree).toHaveLength(1);
    expect(res.skeletonHash).toBe('d41d8cd98f00b204e9800998ecf8427e');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):8082\/v1\/scout\/inspect$/);
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-internal-token': 'test-secret-token',
    });

    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody.owner).toBe('facebook');
    expect(parsedBody.repo).toBe('react');
    expect(parsedBody.branch).toBe('main');
    expect(parsedBody.prefixFilter).toBe('docs/');
  });

  it('sidecar 返回 ok=false 时抛出错误', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-secret-token';
    process.env.WORKER_SIDECAR_URL = 'http://localhost:8082';

    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: false }),
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      executeSidecarScoutInspect({ owner: 'facebook', repo: 'react' })
    ).rejects.toThrow(/response ok is false/);
  });

  it('透传 filePath / singleDocMode / token / maxDepth 完整参数', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-secret-token';
    process.env.WORKER_SIDECAR_URL = 'http://localhost:8082';

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, totalNodeCount: 10 }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await executeSidecarScoutInspect(
      {
        owner: 'facebook',
        repo: 'react',
        branch: 'main',
        filePath: 'docs/guide.md',
        singleDocMode: true,
        token: 'ghp_custom123',
        maxDepth: 4,
      },
      { timeoutMs: 5000 }
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filePath).toBe('docs/guide.md');
    expect(body.singleDocMode).toBe(true);
    expect(body.token).toBe('ghp_custom123');
    expect(body.maxDepth).toBe(4);
  });
});
