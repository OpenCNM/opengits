import { test, expect, describe, afterAll, beforeAll } from 'vitest';
import { prisma } from '@/lib/db';
import { touchMcpClientHeartbeat } from '@/lib/mcp/mcp-heartbeat';

describe('mcp-heartbeat DB 级活跃会话与名称归一化集成测试', () => {
  const testUserId = `heartbeat-user-${Date.now()}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: testUserId,
        email: `${testUserId}@example.com`,
        name: 'Heartbeat Test User',
      },
    });
  });

  afterAll(async () => {
    await prisma.mcpActiveSession.deleteMany({ where: { userId: testUserId } }).catch(() => {});
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  });

  test('客户端名称自动归一化映射', async () => {
    const s1 = await touchMcpClientHeartbeat({
      userId: testUserId,
      clientName: 'Cursor/0.45.1 (darwin-arm64)',
      clientVer: '0.45.1',
    });
    expect(s1?.clientName).toBe('Cursor IDE');

    const s2 = await touchMcpClientHeartbeat({
      userId: testUserId,
      clientName: 'Claude Desktop App v1.2',
      clientVer: '1.2.0',
    });
    expect(s2?.clientName).toBe('Claude Desktop');

    const s3 = await touchMcpClientHeartbeat({
      userId: testUserId,
      clientName: 'Windsurf-Pro',
      clientVer: '1.0.0',
    });
    expect(s3?.clientName).toBe('Windsurf');

    const s4 = await touchMcpClientHeartbeat({
      userId: testUserId,
      clientName: 'Cline Assistant Extension',
      clientVer: '2.0.0',
    });
    expect(s4?.clientName).toBe('Cline');

    const s5 = await touchMcpClientHeartbeat({
      userId: testUserId,
      clientName: '  MyCustomAgent  ',
      clientVer: '3.0.0',
    });
    expect(s5?.clientName).toBe('MyCustomAgent');
  });

  test('心跳 Upsert 幂等性与时间戳更新', async () => {
    // 首次心跳
    const first = await touchMcpClientHeartbeat({
      userId: testUserId,
      clientName: 'Cursor IDE',
      clientVer: '1.0.0',
      ipAddress: '127.0.0.1',
    });
    expect(first?.status).toBe('ACTIVE');
    expect(first?.clientVer).toBe('1.0.0');

    // 等待短暂时间后发送第二次心跳
    await new Promise((r) => setTimeout(r, 50));

    const second = await touchMcpClientHeartbeat({
      userId: testUserId,
      clientName: 'Cursor IDE',
      clientVer: '1.0.1',
      ipAddress: '127.0.0.2',
    });

    expect(second?.id).toBe(first?.id); // 保证同一行
    expect(second?.clientVer).toBe('1.0.1');
    expect(second?.ipAddress).toBe('127.0.0.2');
    expect(new Date(second!.lastSeenAt).getTime()).toBeGreaterThanOrEqual(new Date(first!.lastSeenAt).getTime());

    // 数据库中针对 (userId, clientName) 仅存在 1 行记录
    const count = await prisma.mcpActiveSession.count({
      where: { userId: testUserId, clientName: 'Cursor IDE' },
    });
    expect(count).toBe(1);
  });

  test('缺少必要参数时安全返回 null', async () => {
    const res1 = await touchMcpClientHeartbeat({ userId: '', clientName: 'Cursor' });
    expect(res1).toBeNull();

    const res2 = await touchMcpClientHeartbeat({ userId: testUserId, clientName: '' });
    expect(res2).toBeNull();
  });
});
