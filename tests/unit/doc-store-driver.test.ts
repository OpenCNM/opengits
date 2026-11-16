import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { executeSidecarDocStoreChunks } from '@/engine/doc-store-driver';

/**
 * doc-store driver：覆盖 executeSidecarDocStoreChunks（finalize 封装已随 Node 执行器退役）
 * 的 Fail-Closed 语义、路径、参数透传与鉴权头。
 */

describe('doc-store-driver', () => {
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

  describe('executeSidecarDocStoreChunks', () => {
    it('sidecar 离线时显式抛 SidecarError', async () => {
      await expect(
        executeSidecarDocStoreChunks({ docId: 'doc-1', content: '# 内容' })
      ).rejects.toThrow(/sidecar unreachable|not configured/);
    });

    it('sidecar 在线时透传 store-chunks 请求并携带参数与鉴权头', async () => {
      process.env.INTERNAL_API_TOKEN = 'test-internal-token';
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const res = await executeSidecarDocStoreChunks({
        docId: 'doc-code-1',
        content: '# 模块内容',
        moduleName: 'Core Module',
        sourceFiles: ['src/index.ts'],
      });
      expect(res.ok).toBe(true);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toContain('/v1/doc/store-chunks');
      expect(init.headers).toMatchObject({ 'x-internal-token': 'test-internal-token' });
      expect(JSON.parse(String(init.body))).toMatchObject({
        docId: 'doc-code-1',
        content: '# 模块内容',
        moduleName: 'Core Module',
        sourceFiles: ['src/index.ts'],
      });
    });
  });
});

