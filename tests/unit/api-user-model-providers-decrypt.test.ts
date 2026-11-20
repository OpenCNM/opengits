import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { encryptApiKey } from '@/lib/crypto/api-key-cipher';

/**
 * ─────────────────────────────────────────────────────────────
 * GET /api/user/model-providers 解密真值复核（round-2 承重点补测）。
 *
 * 该分支是客户端 hasConfiguredApiKey 云端 SSOT 的数据源：密文损坏行被
 * 改写为 hasApiKey=false + healthStatus='unhealthy' + lastError（本地化文案）；
 * Node 侧 DB 异常时降级保留 sidecar 原样。此路径坏了守卫会误放行。
 * ─────────────────────────────────────────────────────────────
 */
const callSidecarMock = vi.fn();
vi.mock('@/lib/sidecar-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sidecar-client')>('@/lib/sidecar-client');
  return {
    ...actual,
    callSidecar: (...args: unknown[]) => callSidecarMock(...args),
  };
});

const getSessionHelperMock = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: (...args: unknown[]) => getSessionHelperMock(...args),
  getAdminUserHelper: (...args: unknown[]) => getSessionHelperMock(...args),
}));

const findManyMock = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    userModelProvider: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

const sidecarProvider = (overrides: Record<string, unknown> = {}) => ({
  id: 'p-1',
  providerKey: 'zhipu',
  name: 'Zhipu',
  baseUrl: 'https://open.bigmodel.cn',
  maskedApiKey: 'sk-te••••••1234',
  hasApiKey: true,
  apiFormat: 'openai',
  models: ['glm-4.7'],
  selectedModel: 'glm-4.7',
  isActive: true,
  healthStatus: 'unknown',
  latencyMs: null,
  lastError: null,
  lastTestedAt: null,
  createdAt: '2026-11-20T00:00:00Z',
  updatedAt: '2026-11-20T00:00:00Z',
  ...overrides,
});

async function callGet() {
  const { GET } = await import('@/app/api/user/model-providers/route');
  const req = new NextRequest('http://localhost/api/user/model-providers', { method: 'GET' });
  return GET(req);
}

describe('GET /api/user/model-providers 解密真值复核（批次 B）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({ user: { id: 'usr-123' }, expires: '2099-01-01' });
  });

  it('密文损坏行：改写 hasApiKey=false + unhealthy + lastError（本地化非空）', async () => {
    callSidecarMock.mockResolvedValueOnce({ ok: true, providers: [sidecarProvider()] });
    // 畸形加密密文（带 enc:v1: 前缀但段错误）：decryptApiKey 抛错 → tryDecryptApiKey
    // 确定性返回 null。注意非前缀明文会被"历史明文兼容"原样返回，不构成损坏态
    findManyMock.mockResolvedValueOnce([{ providerKey: 'zhipu', apiKey: 'enc:v1:broken:segments' }]);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    const p = body.data.providers[0];
    expect(p.hasApiKey).toBe(false);
    expect(p.healthStatus).toBe('unhealthy');
    expect(p.lastError).toBeTruthy();
    expect(p.maskedApiKey).toBe('');
  });

  it('密文完好行：保持 sidecar 返回原样（不误伤健康配置）', async () => {
    callSidecarMock.mockResolvedValueOnce({ ok: true, providers: [sidecarProvider()] });
    findManyMock.mockResolvedValueOnce([{ providerKey: 'zhipu', apiKey: await encryptApiKey('sk-live-key') }]);

    const res = await callGet();
    const body = await res.json();
    const p = body.data.providers[0];
    expect(p.hasApiKey).toBe(true);
    expect(p.healthStatus).toBe('unknown');
    expect(p.lastError).toBeNull();
  });

  it('Node 侧 DB 异常：降级保留 sidecar 原样（不炸请求）', async () => {
    callSidecarMock.mockResolvedValueOnce({ ok: true, providers: [sidecarProvider()] });
    findManyMock.mockRejectedValueOnce(new Error('db unreachable'));

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    const p = body.data.providers[0];
    expect(p.hasApiKey).toBe(true);
    expect(p.healthStatus).toBe('unknown');
  });
});
