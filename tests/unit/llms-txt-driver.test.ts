import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSidecarLlmsTxt } from '@/engine/llms-txt-driver';

/**
 * llms-txt driver（2026-09-11 收刀版）：本地 generateLlmsTxt（DB+计算混合）
 * 已物理删除（Go pgx store 同位自查），契约由 Go llms_txt_test.go 锁定——
 * 本文件仅覆盖 Fail-Closed 语义与透传。
 */

describe('llms-txt-driver (Fail-Closed single implementation)', () => {
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

  it('sidecar 离线时显式抛 SidecarError（无本地回退）', async () => {
    await expect(
      executeSidecarLlmsTxt({
        repositoryId: 'rid', owner: 'o', repo: 'r', baseUrl: 'https://x.dev',
      })
    ).rejects.toThrow(/sidecar unreachable|not configured/);
  });

  it('sidecar 在线时透传生成结果并携带鉴权头', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const result = {
      content: '# llms.txt\n- [Doc](https://x.dev/doc)',
      estimatedTokens: 42,
      downgradedCount: 0,
      targetVersion: 'main',
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => result,
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const got = await executeSidecarLlmsTxt({
      repositoryId: 'rid', owner: 'o', repo: 'r', baseUrl: 'https://x.dev', full: true,
    });
    expect(got.content).toContain('llms.txt');
    expect(got.estimatedTokens).toBe(42);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/v1/llms-txt/generate');
    expect(init.headers).toMatchObject({ 'x-internal-token': 'test-internal-token' });
  });
});
