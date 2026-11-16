import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * 紧急只读熔断执行点单元测试。
 * 契约（向量 11.3.x）：
 * - 🧪 ImportJob 认领单点：熔断开启时不认领任何任务（一处停掉全部导入/转录执行）
 * - 🧪 更新市场认领：熔断开启抛 EMERGENCY_READONLY，路由层映射 503
 * - 🧪 scout 入口：熔断开启返回 503（同步与 SSE 共用入口）
 * - 🧪 策略库故障 fail-open：isEmergencyReadOnly 抛错/降级 false 时不阻断任务
 */

const emergencyRef = vi.hoisted(() => ({ value: false, reject: false }));

vi.mock('@/lib/db', () => ({ prisma: {} }));

vi.mock('@/lib/gateway/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gateway/policy')>();
  return {
    ...actual,
    isEmergencyReadOnly: vi.fn(async () => {
      if (emergencyRef.reject) throw new Error('db down');
      return emergencyRef.value;
    }),
  };
});

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn(),
}));

vi.mock('@/lib/scout/pipeline', () => ({
  getRepoImportQuotaError: vi.fn(),
  isScoutPipelineError: vi.fn(() => false),
  runScoutPipeline: vi.fn(),
  SCOUT_RATE_LIMIT_PER_MINUTE: 10,
  SCOUT_RATE_LIMIT_WINDOW_MS: 60_000,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => true),
  clientIpFromRequest: vi.fn(() => '203.0.113.4'),
}));

describe('紧急只读熔断执行点', () => {
  // [11.3.1.1] claimNextQueuedJobs 熔断短路用例已随 Node 认领链退役删除（2026-10 收口）：
  // 认领 SSOT 在 Go jobs Runner（runner.go pump 内 isEmergencyReadOnly 探针）。
  beforeEach(() => {
    vi.clearAllMocks();
    emergencyRef.value = false;
    emergencyRef.reject = false;
  });


  it('🧪 [11.3.2.1] 熔断开启时更新市场认领抛 EMERGENCY_READONLY', async () => {
    emergencyRef.value = true;
    const { claimJob, UpdateMarketError } = await import('@/lib/update-market/jobs');
    await expect(claimJob('job-1', 'user-1')).rejects.toMatchObject({
      code: 'EMERGENCY_READONLY',
    });
    expect(new UpdateMarketError('x', 'EMERGENCY_READONLY').code).toBe('EMERGENCY_READONLY');
  });

  it('熔断开启时按需接力建单被阻断，不生成接力任务', async () => {
    emergencyRef.value = true;
    const { ensureRelayJobForDocument } = await import('@/lib/update-market/jobs');
    await expect(ensureRelayJobForDocument('doc-1')).rejects.toMatchObject({
      code: 'EMERGENCY_READONLY',
    });
  });

  it('🧪 [11.3.3.1] 熔断开启时 scout 入口 503（登录态之后、限流之前）', async () => {
    emergencyRef.value = true;
    const { getSessionHelper } = await import('@/lib/auth-helper');
    vi.mocked(getSessionHelper).mockResolvedValue({
      user: { id: 'user-1', email: 'a@b.c' },
    } as never);

    const { POST } = await import('@/app/api/scout/route');
    const res = await POST(
      new NextRequest('http://localhost/api/scout', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://github.com/a/b' }),
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe('EMERGENCY_READONLY');
  });
});
