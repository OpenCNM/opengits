import { test, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { authenticateMcpRequest, generateApiToken, hashApiToken } from '@/lib/mcp/token-auth';

const PREFIX = `vitest-ta-${Date.now()}`;
let userId = '';

function bearerReq(token: string): NextRequest {
  return new NextRequest('http://localhost/api/mcp/test/test', {
    headers: { authorization: `Bearer ${token}` },
  });
}

afterAll(async () => {
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined); // 级联清理 tokens
});

test('有效 token：解析 userId + via=token + lastUsedAt 副作用', async () => {
  const user = await prisma.user.create({ data: { email: `${PREFIX}@test.local`, name: 'TokenAuth Test' } });
  userId = user.id;
  const plaintext = generateApiToken();
  expect(plaintext).toMatch(/^opgts_[0-9a-f]{32}$/);
  const row = await prisma.mcpApiToken.create({
    data: { userId: user.id, name: 'test', tokenHash: hashApiToken(plaintext), prefix: plaintext.slice(0, 8) },
  });
  const result = await authenticateMcpRequest(bearerReq(plaintext));
  expect(result.userId).toBe(user.id);
  expect(result.via).toBe('token');
  await new Promise((r) => setTimeout(r, 150)); // lastUsedAt fire-and-forget
  const updated = await prisma.mcpApiToken.findUnique({ where: { id: row.id } });
  expect(updated?.lastUsedAt).toBeTruthy();
});

test('已吊销 token：拒绝且不回落 Cookie 通道', async () => {
  const plaintext = generateApiToken();
  await prisma.mcpApiToken.create({
    data: {
      userId,
      name: 'revoked',
      tokenHash: hashApiToken(plaintext),
      prefix: plaintext.slice(0, 8),
      revokedAt: new Date(),
    },
  });
  const result = await authenticateMcpRequest(bearerReq(plaintext));
  expect(result.userId).toBeNull();
  expect(result.via).toBe('token');
});

test('无效 token：直接拒绝（防身份串号语义）', async () => {
  const result = await authenticateMcpRequest(bearerReq('opgts_00000000000000000000000000000000'));
  expect(result.userId).toBeNull();
  expect(result.via).toBe('token');
});
