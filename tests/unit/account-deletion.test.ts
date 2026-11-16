import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

const userFindUniqueMock = vi.fn();
const callSidecarMock = vi.fn();
const adminUserUpdateManyMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => userFindUniqueMock(...args),
    },
    adminUser: {
      updateMany: (...args: unknown[]) => adminUserUpdateManyMock(...args),
    },
  },
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

let mockSession: { user: { id: string; email: string } } | null = null;

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockImplementation(() => Promise.resolve(mockSession)),
}));

describe('M08 Account Deletion and Asset Isolation (Unit 8.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = null;
    userFindUniqueMock.mockResolvedValue({ id: 'user-delete-me', email: 'test@example.com' });
    callSidecarMock.mockResolvedValue({ ok: true, count: 1 });
    adminUserUpdateManyMock.mockResolvedValue({ count: 1 });
  });

  it('🧪 [8.3.1.1] 账号注销必须要求有效 Session 且请求体包含 confirm: "DELETE"（防 CSRF 误删与非法调用）', async () => {
    const { DELETE } = await import('@/app/api/account/delete/route');

    // 1. 无有效 Session 调用 -> 401 拦截
    mockSession = null;
    const unauthReq = new NextRequest('http://localhost:3000/api/account/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    const unauthRes = await DELETE(unauthReq);
    expect(unauthRes.status).toBe(401);
    expect(callSidecarMock).not.toHaveBeenCalled();

    // 2. 有 Session 但请求体未包含精确的 confirm: 'DELETE' -> 400 拦截
    mockSession = { user: { id: 'user-delete-me', email: 'test@example.com' } };
    const invalidReq1 = new NextRequest('http://localhost:3000/api/account/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'delete' }), // 小写不匹配 (第 1 次)
    });
    const invalidRes1 = await DELETE(invalidReq1);
    expect(invalidRes1.status).toBe(400);

    const invalidReqSpace = new NextRequest('http://localhost:3000/api/account/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: ' DELETE ' }), // 空格不绕过 (第 2 次)
    });
    const invalidResSpace = await DELETE(invalidReqSpace);
    expect(invalidResSpace.status).toBe(400);

    // 独立用户测试空请求体
    mockSession = { user: { id: 'user-empty-confirm', email: 'empty@example.com' } };
    const invalidReqEmpty = new NextRequest('http://localhost:3000/api/account/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const invalidResEmpty = await DELETE(invalidReqEmpty);
    expect(invalidResEmpty.status).toBe(400);
    expect(callSidecarMock).not.toHaveBeenCalled();

    // 3. 有 Session 且 confirm: 'DELETE' 匹配 -> 200 成功 (user-delete-me 第 3 次)
    mockSession = { user: { id: 'user-delete-me', email: 'test@example.com' } };
    const validReq = new NextRequest('http://localhost:3000/api/account/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    const validRes = await DELETE(validReq);
    expect(validRes.status).toBe(200);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/user/delete',
      { id: 'user-delete-me' },
      { label: 'account-delete' }
    );
    // 断言同邮箱 AdminUser 同步失活（防提权漏洞 BUG-M08-02）
    expect(adminUserUpdateManyMock).toHaveBeenCalledWith({
      where: { email: 'test@example.com' },
      data: { isActive: false },
    });
    // 断言客户端 Session Cookie 即刻过期吊销（maxAge: 0）
    expect(validRes.cookies.get('next-auth.session-token')?.value).toBe('');
    expect(validRes.cookies.get('__Secure-next-auth.session-token')?.value).toBe('');

    // 4. 操作频次限制：同用户 1 小时内第 4 次请求触发 429 Rate Limit
    const rateLimitedReq = new NextRequest('http://localhost:3000/api/account/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    const rateLimitedRes = await DELETE(rateLimitedReq);
    expect(rateLimitedRes.status).toBe(429);

    // 5. 用户在 DB 中已不存在 -> 404 拦截（使用独立 user-id 避开上述用户的限流桶）
    mockSession = { user: { id: 'user-not-found-id', email: 'nf@example.com' } };
    userFindUniqueMock.mockResolvedValueOnce(null);
    const notFoundReq = new NextRequest('http://localhost:3000/api/account/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    const notFoundRes = await DELETE(notFoundReq);
    expect(notFoundRes.status).toBe(404);
  });

  it('🧪 [8.3.2.1] 注销时级联清理 UserApiKey / UserModelProvider 密文等用户私有资产', () => {
    const schemaPath = path.join(process.cwd(), 'prisma/schema.prisma');
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

    // 验证 UserModelProvider (自备模型密钥表) 具有与 User 的 onDelete: Cascade 物理级联
    const modelProviderBlock = schemaContent.match(/model UserModelProvider\s*\{[\s\S]*?\n\}/);
    expect(modelProviderBlock).not.toBeNull();
    expect(modelProviderBlock![0]).toMatch(/user\s+User\s+@relation\(fields:\s*\[userId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);

    // 验证 McpApiToken 等私有凭据表也配置了 onDelete: Cascade
    const tokenBlock = schemaContent.match(/model McpApiToken\s*\{[\s\S]*?\n\}/);
    expect(tokenBlock).not.toBeNull();
    expect(tokenBlock![0]).toMatch(/user\s+User\s+@relation\(fields:\s*\[userId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
  });

  it('🧪 [8.3.3.1] 注销账号时公开仓库设置为 importerId = null 资产解绑，保留公共知识库', () => {
    const schemaPath = path.join(process.cwd(), 'prisma/schema.prisma');
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

    // 验证 Repository 绝无向 User 的级联删除（公共资产与个人生命周期解绑）
    const repoBlock = schemaContent.match(/model Repository\s*\{[\s\S]*?\n\}/);
    expect(repoBlock).not.toBeNull();
    expect(repoBlock![0]).not.toMatch(/User\s+@relation\([\s\S]*onDelete:\s*Cascade\)/);

    // 验证 Document 共享正典行（ownerUserId 为 null）独立于 User 存在，不随 User 级联删除
    const docBlock = schemaContent.match(/model Document\s*\{[\s\S]*?\n\}/);
    expect(docBlock).not.toBeNull();
    expect(docBlock![0]).toMatch(/ownerUserId\s+String\?/);
    expect(docBlock![0]).toMatch(/owner\s+User\?\s+@relation\("DocumentOwner",\s*fields:\s*\[ownerUserId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
  });
});
