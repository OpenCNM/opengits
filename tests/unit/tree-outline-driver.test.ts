import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * tree-outline driver：/v1/outline/tree 透传 Fail-Closed 契约与 SSE 流式语义。
 * （旧 outline-driver 四函数面已于 2026-11 盲区清算随死岛文件拆除——
 *  功能下沉 Go sidecar，SSOT 为本驱动。）
 */


function mockSidecar(routes: Record<string, unknown>) {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    for (const key of Object.keys(routes)) {
      if (u.includes(key)) {
        return { ok: true, status: 200, json: async () => routes[key] };
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
}

describe('tree-outline-driver (Fail-Closed single implementation)', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const nodes = [{ path: 'README.md', type: 'blob' }] as never[];

  beforeEach(() => {
    delete process.env.INTERNAL_API_TOKEN;
    delete process.env.WORKER_SIDECAR_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('tree-outline 冷启动 202 preparing 契约：preparing 载荷直接透传（跳过深度校验），畸形深度仍抛错', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    globalThis.fetch = mockSidecar({
      '/v1/outline/tree': { preparing: true, status: 'running', detail: '后台准备中', retryAfterMs: 8000 },
    }) as unknown as typeof fetch;

    const { executeSidecarTreeOutline } = await import('@/engine/tree-outline-driver');
    const prep = await executeSidecarTreeOutline({ owner: 'o', repo: 'r', sha: 'abc' });
    expect(prep.preparing).toBe(true);
    expect(prep.retryAfterMs).toBe(8000);

    // 非 preparing 载荷仍受深度校验约束（防畸形深度静默穿透）
    globalThis.fetch = mockSidecar({ '/v1/outline/tree': { ok: true } }) as unknown as typeof fetch;
    await expect(executeSidecarTreeOutline({ owner: 'o', repo: 'r', sha: 'abc' })).rejects.toThrow(/malformed depth/);
  });

  it('tree-outline SSE 流式长连接与阶段推进事件 (onProgress) 回调与心跳忽略', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const sseChunks = [
      ': ping\n\n',
      'event: step\ndata: {"stage":"tree","title":"代码树提取","detail":"10 files"}\n\n',
      ': ping\n\n',
      'event: step\ndata: {"stage":"plan","title":"宏观规划","detail":"5 chapters"}\n\n',
      'event: complete\ndata: {"ok":true,"depth":1,"repo":"r","chapters":[{"name":"C1","summary":"","files":[{"path":"README.md","shortTitle":"s"}]}]}\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    globalThis.fetch = vi.fn(async () => {
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    const { executeSidecarTreeOutline } = await import('@/engine/tree-outline-driver');
    const steps: Array<{ stage: string; title: string }> = [];
    const res = await executeSidecarTreeOutline(
      { owner: 'o', repo: 'r', sha: 'abc', userId: 'u1' },
      {
        stream: true,
        onProgress: (step) => {
          steps.push({ stage: step.stage, title: step.title });
        },
      }
    );

    expect(steps).toEqual([
      { stage: 'tree', title: '代码树提取' },
      { stage: 'plan', title: '宏观规划' },
    ]);
    expect(res.ok).toBe(true);
    expect(res.depth).toBe(1);
    expect(res.chapters?.[0].name).toBe('C1');
  });

  it('tree-outline SSE 流式错误帧直接 reject', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const sseChunks = [
      'event: error\ndata: {"message":"Sidecar timeout during planning"}\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    globalThis.fetch = vi.fn(async () => {
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    const { executeSidecarTreeOutline } = await import('@/engine/tree-outline-driver');
    await expect(
      executeSidecarTreeOutline(
        { owner: 'o', repo: 'r', sha: 'abc', userId: 'u1' },
        { stream: true }
      )
    ).rejects.toThrow(/Sidecar timeout during planning/);
  });
});
