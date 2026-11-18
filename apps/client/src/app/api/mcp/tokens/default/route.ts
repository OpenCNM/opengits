import { prisma } from '@/lib/db';
import { generateApiToken, hashApiToken } from '@/lib/mcp/token-auth';
import { encryptApiKey, tryDecryptApiKey } from '@/lib/crypto/api-key-cipher';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

interface ActiveDecryptableToken {
  id: string;
  token: string;
  name: string;
  prefix: string;
}

async function findActiveDecryptableToken(userId: string): Promise<ActiveDecryptableToken | null> {
  const activeTokens = await prisma.mcpApiToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
  });

  for (const t of activeTokens) {
    if (t.encryptedToken) {
      const decrypted = tryDecryptApiKey(t.encryptedToken);
      if (decrypted) {
        return { id: t.id, token: decrypted, name: t.name, prefix: t.prefix };
      }
    }
  }

  return null;
}

/**
 * 只读获取当前用户的默认 MCP API Token。
 * - 若已有带加密密文的活跃 Token，直接解密返回，供向导一键带入；
 * - 若无可用 Token，返回 null（不产生写入副作用，由用户点击创建时通过 POST 生成）。
 */
export const GET = defineRoute({
  scope: 'GET /api/mcp/tokens/default',
  auth: 'user',
  handler: async ({ userId }) => {
    const existing = await findActiveDecryptableToken(userId!);
    if (existing) {
      return ok(existing);
    }

    return ok({ id: null, token: null, name: null, prefix: null });
  },
});

/**
 * 按需初始化默认 MCP API Token（幂等）：
 * - 若已有可解密的活跃 Token，直接返回（created: false），避免重复建 key；
 * - 若无可用 Token，为用户创建名为 "Default" 的初始 Token 并返回（created: true）。
 */
export const POST = defineRoute({
  scope: 'POST /api/mcp/tokens/default',
  auth: 'user',
  handler: async ({ userId }) => {
    const existing = await findActiveDecryptableToken(userId!);
    if (existing) {
      return ok({ ...existing, created: false });
    }

    const plainToken = generateApiToken();
    const defaultName = 'Default';
    const res = await callSidecar<{
      ok: boolean;
      token?: { id: string; name: string; prefix: string };
      error?: string;
      code?: string;
    }>(
      '/v1/mcp/tokens/create',
      {
        userId: userId!,
        name: defaultName,
        tokenHash: hashApiToken(plainToken),
        encryptedToken: encryptApiKey(plainToken),
        prefix: plainToken.slice(0, 8),
      },
      { label: 'mcp /v1/mcp/tokens/create default' }
    );

    if (!res.ok || !res.token) {
      if (res.code === 'MAX_TOKENS_EXCEEDED') {
        throw ApiError.conflict(
          res.error || 'Maximum active tokens limit reached. Please revoke unused tokens first.',
          { code: 'MAX_TOKENS_EXCEEDED' }
        );
      }
      throw ApiError.internal(res.error || 'Failed to create default MCP token');
    }

    return ok(
      {
        id: res.token.id,
        token: plainToken,
        name: res.token.name,
        prefix: res.token.prefix,
        created: true,
      },
      201
    );
  },
});
