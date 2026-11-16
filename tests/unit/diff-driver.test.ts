import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeArchiveDiff } from '@/engine/diff-driver';

/**
 * 归档差异 driver（2026-09-11 收刀版）：
 * 本地 Myers/哈希树实现已物理删除，契约由冻结夹具 diff-unified.golden.json
 * 在 Go 端锁定——本文件仅覆盖 Fail-Closed 语义与 404 业务 null 的区分。
 */

describe('diff-driver (Fail-Closed single implementation)', () => {
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
      executeArchiveDiff('owner', 'repo', 'a'.repeat(40), 'b'.repeat(40))
    ).rejects.toThrow(/sidecar unreachable|not configured/);
  });

  it('归档缺失（HTTP 404）返回 null（业务结果，非故障）', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: 'archive not found' }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const got = await executeArchiveDiff('owner', 'repo', 'a'.repeat(40), 'b'.repeat(40));
    expect(got).toBeNull();
  });

  it('1.14.3.3 sidecar 在线时透传归档差异集合并携带鉴权头（行级 Myers Diff 与就地比对下沉 Go）', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        added: ['b.md'],
        modified: ['a.md'],
        removed: [],
        renamed: [{ from: 'c.md', to: 'd.md' }],
      }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const got = await executeArchiveDiff('owner', 'repo', 'a'.repeat(40), 'b'.repeat(40));
    expect(got).not.toBeNull();
    expect([...got!.added]).toEqual(['b.md']);
    expect([...got!.modified]).toEqual(['a.md']);
    expect(got!.renamed).toEqual([{ from: 'c.md', to: 'd.md' }]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/v1/archive/diff');
    expect(init.headers).toMatchObject({ 'x-internal-token': 'test-internal-token' });
  });

  it('畸形载荷显式抛错而非回退', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ foo: 'bar' }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(executeArchiveDiff('owner', 'repo', 'a'.repeat(40), 'b'.repeat(40))).rejects.toThrow(
      /malformed archive diff payload/
    );
  });
});
