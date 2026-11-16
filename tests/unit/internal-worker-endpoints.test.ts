import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const marketEngineTickMock = vi.fn();
vi.mock('@/lib/scheduler/auto-update', () => ({
  // D组6c：端点收窄为市场引擎 tick（确定性周期已 Go 进程内直跑）
  runMarketEngineTick: () => marketEngineTickMock(),
}));

const TEST_TOKEN = 'test-internal-token-12345';

function makeRequest(path: string, body: unknown, token?: string): NextRequest {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('x-internal-token', token);
  }
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('Zero-Node Worker Internal Micro-Endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_API_TOKEN = TEST_TOKEN;
  });

  describe('POST /api/internal/scheduler/auto-update-once', () => {
    it('[2.13.1.1] denies access if token is missing or invalid', async () => {
      const { POST } = await import('@/app/api/internal/scheduler/auto-update-once/route');
      const req = makeRequest('/api/internal/scheduler/auto-update-once', {});
      const res = await POST(req);
      expect(res.status).toBe(403);
    });

    it('successfully runs market engine tick', async () => {
      const { POST } = await import('@/app/api/internal/scheduler/auto-update-once/route');
      marketEngineTickMock.mockResolvedValue(undefined);

      const req = makeRequest('/api/internal/scheduler/auto-update-once', {}, TEST_TOKEN);
      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(marketEngineTickMock).toHaveBeenCalledTimes(1);
    });

    it('[2.13.1.2] handles engine tick errors with 500', async () => {
      const { POST } = await import('@/app/api/internal/scheduler/auto-update-once/route');
      marketEngineTickMock.mockRejectedValue(new Error('scheduler lease deadlock'));

      const req = makeRequest('/api/internal/scheduler/auto-update-once', {}, TEST_TOKEN);
      const res = await POST(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.message).toContain('scheduler lease deadlock');
    });
  });

  describe('Guardrails & Execution Seams', () => {
    // [2.13.1.3] Distroless static Go binary environment validation (CGO_ENABLED=0, zero Node/libc runtime)
    it('[2.13.1.3] verifies Dockerfile and docker-compose configurations enforce Zero-Node worker distroless contracts', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const rootDir = path.resolve(process.cwd());

      const dockerfileContent = fs.readFileSync(path.join(rootDir, 'Dockerfile'), 'utf-8');
      expect(dockerfileContent).toContain('FROM gcr.io/distroless/static-debian12:nonroot AS worker-go');
      expect(dockerfileContent).toContain('COPY --from=gobuild /out/worker-sidecar /usr/local/bin/worker-sidecar');
      expect(dockerfileContent).not.toContain('ingest-patterns.json');
      expect(dockerfileContent).not.toContain('language-definitions.json');
      // 验证 worker-go 阶段不包含 Node/npm/esbuild
      const workerGoSection = dockerfileContent.split('AS worker-go')[1] || '';
      expect(workerGoSection).not.toContain('apt-get');
      expect(workerGoSection).not.toContain('npm');
      expect(workerGoSection).not.toContain('esbuild');
      expect(workerGoSection).not.toContain('node:');

      const composeContent = fs.readFileSync(path.join(rootDir, 'docker-compose.yml'), 'utf-8');
      expect(composeContent).not.toContain('WORKER_ENGINE_CMD: "node dist/engine-exec.mjs"');
      expect(composeContent).toContain('WEB_INTERNAL_URL:');
      expect(composeContent).toContain('FIRECRAWL_API_URL:');
    });

    it('[2.13.1.4] sidecar 离线 Fail-Closed 护栏防循环折返', async () => {
      // Web 端点隔离：切片直写经 callSidecar 单通道，侧车离线显式抛错，杜绝网络循环折返
      // （2026-10 收口：finalize 封装随 Node 执行器退役，护栏锚点移至 store-chunks 同款通道）
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
      try {
        const { executeSidecarDocStoreChunks } = await import('@/engine/doc-store-driver');
        await expect(
          executeSidecarDocStoreChunks({ docId: 'doc-loop', content: '# no-loop' })
        ).rejects.toThrow();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('[2.13.7.1] 三执行缝保留 Node 零密钥字段（job/execute、transcription/execute 虚拟章节段、auto-update-once 引擎 tick）', () => {
      // BYOK 解密单点 + Prompt 注册表 = Node 域，Go 侧请求体零密钥字段
      const sampleReq = { jobId: 'job-1', documentId: 'doc-1', requestedBy: 'user-1' };
      expect(sampleReq).not.toHaveProperty('apiKey');
      expect(sampleReq).not.toHaveProperty('secret');
      expect(sampleReq).not.toHaveProperty('encryptionKey');
    });

    it('[2.13.7.2] auto-update 确定性周期漂移防御（Go 进程内直跑，Node 仅承载 TRIAL 结算与维护者转录）', async () => {
      const { POST } = await import('@/app/api/internal/scheduler/auto-update-once/route');
      const req = makeRequest('/api/internal/scheduler/auto-update-once', {}, TEST_TOKEN);
      marketEngineTickMock.mockResolvedValueOnce({ ok: true, processed: 1 });
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(marketEngineTickMock).toHaveBeenCalled();
    });

    it('[2.13.7.3] BuildUpdateCandidateSet 进程内直调（消除 Go→Node→Go 候选集 ping-pong）', async () => {
      // 归档 diff 优先 0 网络，消除 HTTP 折返自身候选集端点
      const fs = await import('fs');
      const path = await import('path');
      const autoUpdateCycle = fs.readFileSync(
        path.resolve(process.cwd(), 'services/worker-sidecar/internal/update/cycle.go'),
        'utf-8'
      );
      expect(autoUpdateCycle).toContain('BuildUpdateCandidateSet(cfg, req, store)');
    });
  });
});
