import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureArchiveViaSidecar } from '@/engine/tarball/archive-sidecar-driver';

/**
 * archive driver（2026-09-11 收刀版）：diffArchivesViaSidecar 孤儿出口已删除
 * （A组 diff 收刀后零调用方）；ensure Fail-Closed——故障抛错，超限跳过（200
 * dir=null）是合法业务结果走网络路径。
 */

describe('archive-sidecar-driver (Fail-Closed single implementation)', () => {
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

  it('1.14.3.1 sidecar 离线时显式抛 SidecarError（Fail-Closed 架构，不再静默回落网络路径）', async () => {
    await expect(
      ensureArchiveViaSidecar('owner', 'repo', 'a'.repeat(40))
    ).rejects.toThrow(/sidecar unreachable|not configured/);
  });

  it('1.14.1.1 未带/错误 internal token 拒绝与鉴权头透传校验', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    await expect(
      ensureArchiveViaSidecar('owner', 'repo', 'a'.repeat(40))
    ).rejects.toThrow(/not configured/);

    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'unauthorized',
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      ensureArchiveViaSidecar('owner', 'repo', 'a'.repeat(40))
    ).rejects.toThrow();
  });

  it('1.14.2.2 超限跳过（200 + dir=null）是合法业务结果透传', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ dir: null, fromCache: false }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const got = await ensureArchiveViaSidecar('owner', 'repo', 'a'.repeat(40), { sizeHintBytes: 1 });
    expect(got).toEqual({ dir: null, fromCache: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/v1/archive/ensure');
    expect(init.headers).toMatchObject({ 'x-internal-token': 'test-internal-token' });
  });

  it('1.14.3.2 归档就绪时透传 fromCache 与业务路径重算', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ dir: '/storage/repos/owner/repo/sha', fromCache: true }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const got = await ensureArchiveViaSidecar('owner', 'repo', 'a'.repeat(40));
    expect(got.dir).toBe('/storage/repos/owner/repo/sha');
    expect(got.fromCache).toBe(true);
  });
});
