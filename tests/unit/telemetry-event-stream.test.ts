import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

const callSidecarMock = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue({ user: { id: 'u-123' } }),
}));

const checkRateLimitMock = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

describe('M03 [3.4] 交互式测验生成与行为事件流埋点', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitMock.mockResolvedValue(true);
    callSidecarMock.mockResolvedValue({ ok: true, count: 5 });
  });

  // 🧪 [3.4.2.1 · HIGH] 恶意脚本秒级刷发 10 万条行为埋点打爆数据库
  // AntiPattern: 埋点接口无速率限制且单条直接写库
  // DefenseAssertion: 客户端防抖聚合 (Debounce 5s) + 服务端 RateLimit 限制
  it('3.4.2.1 批量上报与限流护栏：单批超 50 条截断 + 频率超限 429 拒绝', async () => {
    const { POST } = await import('@/app/api/telemetry/route');

    // 1. 测试超上限 60 条截断为 50 条
    const hugeBatch = Array.from({ length: 60 }, (_, i) => ({
      eventType: 'PAGE_VIEW',
      pageUrl: `/docs/intro#${i}`,
      duration: 1000,
    }));

    const req = new NextRequest('http://localhost/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: hugeBatch }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/telemetry/events',
      expect.objectContaining({
        userId: 'u-123',
        events: expect.arrayContaining([
          expect.objectContaining({ eventType: 'PAGE_VIEW' }),
        ]),
      }),
      expect.objectContaining({ label: 'telemetry /v1/telemetry/events' })
    );
    const passedData = (callSidecarMock.mock.calls[0][1] as any).events;
    expect(passedData.length).toBe(50); // 强截断至 MAX_EVENTS_PER_BATCH = 50

    // 2. 测试频率超限返回 429
    checkRateLimitMock.mockResolvedValueOnce(false);
    const rateLimitedReq = new NextRequest('http://localhost/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ eventType: 'PAGE_VIEW', pageUrl: '/docs/intro' }] }),
    });
    const resRateLimited = await POST(rateLimitedReq);
    expect(resRateLimited.status).toBe(429);
  });

  // 🧪 [3.4.3.1 · MEDIUM] 删除仓库时残留百万条孤儿 EpisodicEvent 记录
  // AntiPattern: 无物理外键约束导致脏数据永久积压
  // DefenseAssertion: 通过 onDelete: SetNull 级联断开外键关联，保障数据一致性
  it('3.4.3.1 仓库级联置空与孤儿容错：物理 schema 锁定 onDelete: SetNull，孤儿事件安全写入', async () => {
    // 1. 物理数据库 Schema 级联契约硬化核验
    const schemaContent = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf-8');
    const episodicEventBlock = schemaContent.match(/model EpisodicEvent\s*\{[\s\S]*?\n\}/)?.[0] || '';
    expect(episodicEventBlock).toContain('repositoryId String?');
    expect(episodicEventBlock).toMatch(/repository\s+Repository\?\s+@relation\(fields:\s*\[repositoryId\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull\)/);

    // 2. 服务端 API 写入时对孤儿事件安全写入（repositoryId: null）
    const { POST } = await import('@/app/api/telemetry/route');
    const orphanEvent = [
      { eventType: 'PAGE_VIEW', pageUrl: '/docs/unknown/orphan', repositoryId: null },
    ];

    const req = new NextRequest('http://localhost/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: orphanEvent }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const passedData = (callSidecarMock.mock.calls[0][1] as any).events;
    expect(passedData[0].repositoryId).toBeNull();
  });
});
