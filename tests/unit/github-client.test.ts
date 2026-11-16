import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GitHub 客户端咽喉单测：池构建去重/轮询避冷却/全冷却匿名降级/
 * 403 换 token 重试/显式 token 不轮换/遗留 Authorization 剥离重注/埋点采样。
 */

const createLogMock = vi.fn();
const callSidecarMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    githubQuotaLog: { create: (...args: unknown[]) => createLogMock(...args) },
  },
}));

// 双轨 resolver：userId 路径不打真实 DB
vi.mock('@/lib/github/token-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/github/token-resolver')>();
  return {
    ...actual,
    resolveGithubToken: vi.fn(async (userId?: string | null) =>
      userId ? `user-oauth-${String(userId).slice(-4)}` : undefined),
  };
});

function jsonResponse(status: number, headers: Record<string, string> = {}) {
  return new Response(null, { status, headers });
}

describe('token-pool', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKENS;
  });

  it('构建去重（GITHUB_TOKENS ∪ GITHUB_TOKEN）+ 轮询避开冷却', async () => {
    process.env.GITHUB_TOKENS = 'tok_aaaa,tok_bbbb';
    process.env.GITHUB_TOKEN = 'tok_aaaa'; // 重复应被去重
    const pool = await import('@/lib/github/token-pool');
    expect(pool.poolStats()).toEqual({ size: 2, healthy: 2, quarantined: 0 });

    // 指纹 = sha256 前 12 位（尾 4 位易撞车，冷却归属会错人）
    const fpA = pool.tokenFingerprint('tok_aaaa');
    const fpB = pool.tokenFingerprint('tok_bbbb');
    expect(fpA).not.toBe(fpB);
    const a = pool.acquirePoolToken();
    expect(a?.fingerprint).toBe(fpA);
    pool.markTokenCooldown(fpA); // 无 reset 默认 60s

    const b = pool.acquirePoolToken();
    expect(b?.fingerprint).toBe(fpB);
    pool.markTokenCooldown(fpB);

    expect(pool.acquirePoolToken()).toBeUndefined(); // 全冷却
    expect(pool.poolStats().healthy).toBe(0);
  });
});

describe('githubFetch(统一咽喉)', () => {
  beforeEach(() => {
    vi.resetModules();
    createLogMock.mockResolvedValue({});
    callSidecarMock.mockReset();
    callSidecarMock.mockResolvedValue({ ok: true });
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKENS;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function client() {
    return import('@/lib/github/client');
  }

  it('403 → 冷却并自动换 token 重试一次，返回重试响应', async () => {
    process.env.GITHUB_TOKENS = 'tok_aaaa,tok_bbbb';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) }))
      .mockResolvedValueOnce(jsonResponse(200, { 'x-ratelimit-remaining': '4999' }));
    vi.stubGlobal('fetch', fetchMock);

    const c = await client();
    const res = await c.githubFetch('https://api.github.com/x');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 第二次请求的 Authorization 已切换到 bbbb
    const authHeader = (fetchMock.mock.calls[1][1] as RequestInit).headers instanceof Headers
      ? ((fetchMock.mock.calls[1][1] as RequestInit).headers as Headers).get('Authorization')
      : null;
    expect(authHeader).toBe('Bearer tok_bbbb');
  });

  it('显式 token 直用且 403 不轮换（调用方语义自管）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, { 'x-ratelimit-remaining': '0' }));
    vi.stubGlobal('fetch', fetchMock);
    const c = await client();

    const res = await c.githubFetch('https://api.github.com/x', {}, { explicitToken: 'tok_zzzz' });
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 不重试不轮换
  });

  it('匿名场景剥离遗留 Authorization；有 token 时重注 Bearer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(jsonResponse(200, { 'x-ratelimit-remaining': '5000' }));
    vi.stubGlobal('fetch', fetchMock);
    const c = await client();

    await c.githubFetch('https://api.github.com/x', {
      headers: { Authorization: 'Bearer stale-cred', Accept: 'application/vnd.github+json' },
    });
    const h1 = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(h1.get('Authorization')).toBeNull(); // 匿名：剥离遗留凭据
    expect(h1.get('Accept')).toBe('application/vnd.github+json'); // 业务头保留

    process.env.GITHUB_TOKEN = 'tok_pool';
    vi.resetModules();
    const c2 = await import('@/lib/github/client');
    await c2.githubFetch('https://api.github.com/y');
    const call = fetchMock.mock.calls[1][1] as RequestInit;
    expect((call.headers as Headers).get('Authorization')).toBe('Bearer tok_pool');
  }, 15000);

  it('埋点采样：remaining<200 必记，fingerprint sha256 前 12 位落库；无配额头不落库', async () => {
    process.env.GITHUB_TOKEN = 'tok_high';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
      'x-ratelimit-remaining': '50',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const c = await client();
    const { tokenFingerprint } = await import('@/lib/github/token-pool');
    const fp = tokenFingerprint('tok_high');
    await c.githubFetch('https://api.github.com/z', {}, { endpointClass: 'raw' });

    // 异步采样存在跨用例晚到：waitFor + 按本用例指纹过滤
    await vi.waitFor(
      () => {
        const mine = callSidecarMock.mock.calls.filter(
          (c) => c[0] === '/v1/github/quota/sample' && (c[1] as any)?.fingerprint === fp
        );
        expect(mine.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000, interval: 10 },
    );
    const mine = callSidecarMock.mock.calls.filter(
      (c) => c[0] === '/v1/github/quota/sample' && (c[1] as any)?.fingerprint === fp
    );
    const data = mine[0][1] as any;
    expect(data.fingerprint).toBe(fp);
    expect(data.remaining).toBe(50);
    expect(data.endpointClass).toBe('raw');
  }, 15000);

  it('userId 双轨：走用户 OAuth 凭据', async () => {
    process.env.GITHUB_TOKENS = 'tok_platform';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { 'x-ratelimit-remaining': '4000' }));
    vi.stubGlobal('fetch', fetchMock);
    const c = await client();

    await c.githubFetch('https://api.github.com/w', {}, { userId: 'user-7777' });
    const h = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(h.get('Authorization')).toBe('Bearer user-oauth-7777');
  }, 15000);
});

describe('githubFetch 瞬态网络重试与准确错误收敛', () => {
  beforeEach(() => {
    vi.resetModules();
    createLogMock.mockResolvedValue({});
    callSidecarMock.mockReset();
    callSidecarMock.mockResolvedValue({ ok: true });
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKENS;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function transientReset(): TypeError {
    // undici 统一外壳：TypeError("fetch failed") + cause 链上的真实传输层原因
    return new TypeError('fetch failed', { cause: new Error('connect ECONNRESET 1.2.3.4:443') });
  }

  async function client() {
    return import('@/lib/github/client');
  }

  it('GET 首次传输层中断退避重试，第二次成功返回', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(transientReset())
      .mockResolvedValueOnce(jsonResponse(200, { 'x-ratelimit-remaining': '4999' }));
    vi.stubGlobal('fetch', fetchMock);
    const c = await client();

    const res = await c.githubFetch('https://api.github.com/repos/o/r', {}, { explicitToken: 'tok' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const auth = (fetchMock.mock.calls[1][1] as RequestInit).headers as Headers;
    expect(auth.get('Authorization')).toBe('Bearer tok');
  }, 15000);

  it('GET 重试耗尽抛 GithubNetworkError（准确文案），共 3 次尝试', async () => {
    const fetchMock = vi.fn().mockRejectedValue(transientReset());
    vi.stubGlobal('fetch', fetchMock);
    const c = await client();

    await expect(
      c.githubFetch('https://api.github.com/repos/o/r', {}, { explicitToken: 't' })
    ).rejects.toSatisfy((err: unknown) => {
      expect((err as Error).name).toBe('GithubNetworkError');
      expect((err as Error).message).toMatch(/连接 GitHub 失败/);
      expect((err as Error).message).toMatch(/3 次/);
      expect((err as Error).message).not.toBe('fetch failed');
      expect((err as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
      return true;
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 15000);

  it('POST（非幂等）传输层失败不重试，仅 1 次尝试', async () => {
    const fetchMock = vi.fn().mockRejectedValue(transientReset());
    vi.stubGlobal('fetch', fetchMock);
    const c = await client();

    await expect(
      c.githubFetch('https://api.github.com/repos/o/r/git/blobs', { method: 'POST', body: '{}' }, { explicitToken: 't' })
    ).rejects.toSatisfy((err: unknown) => {
      expect((err as Error).name).toBe('GithubNetworkError');
      expect((err as Error).message).toMatch(/1 次/);
      return true;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 15000);

  it('非瞬态错误原样抛出且不重试', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);
    const c = await client();

    await expect(
      c.githubFetch('https://api.github.com/repos/o/r', {}, { explicitToken: 't' })
    ).rejects.toThrow('boom');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('调用方 abort 绝不重试', async () => {
    const abortErr = new Error('This operation was aborted');
    abortErr.name = 'AbortError';
    const fetchMock = vi.fn().mockRejectedValue(abortErr);
    vi.stubGlobal('fetch', fetchMock);
    const c = await client();

    await expect(
      c.githubFetch('https://api.github.com/repos/o/r', {}, { explicitToken: 't' })
    ).rejects.toThrow('This operation was aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetchRepoMeta 网络腿失败收敛为 NETWORK ScoutPipelineError（界面不再见裸 fetch failed）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(transientReset()));
    await import('@/lib/github/client');
    const repoMeta = await import('@/lib/scout/pipeline/repo-meta');

    await expect(repoMeta.fetchRepoMeta('openclaw', 'openclaw', 'user-7777')).rejects.toSatisfy(
      (err: unknown) => {
        expect((err as { scoutStatus?: string }).scoutStatus).toBe('NETWORK');
        expect((err as { httpStatus?: number }).httpStatus).toBe(502);
        expect((err as Error).message).toMatch(/连接 GitHub 失败/);
        return true;
      },
    );
  }, 15000);
});
