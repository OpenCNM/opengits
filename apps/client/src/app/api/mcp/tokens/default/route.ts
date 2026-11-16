import { prisma } from '@/lib/db';
import { generateApiToken, hashApiToken } from '@/lib/mcp/token-auth';
import { encryptApiKey, tryDecryptApiKey } from '@/lib/crypto/api-key-cipher';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

/**
 * 获取当前用户的默认 MCP API Token。
 * - 若已有带加密密文的活跃 Token，直接解密返回，供向导一键带入；
 * - 若无任何可用 Token，自动为用户创建名为 "Default" 的初始 Token 并返回。
 */
export const GET = defineRoute({
  scope: 'GET /api/mcp/tokens/default',
  auth: 'user',
  handler: async ({ userId }) => {
    const activeTokens = await prisma.mcpApiToken.findMany({
      where: { userId, revokedAt: null },
      orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
    });

    for (const t of activeTokens) {
      if (t.encryptedToken) {
        const decrypted = tryDecryptApiKey(t.encryptedToken);
        if (decrypted) {
          return ok({ token: decrypted, name: t.name, prefix: t.prefix });
        }
      }
    }

    // 若无任何可解密的活跃 Token（新用户或存量旧 Token），创建默认 Token
    const plainToken = generateApiToken();
    const defaultName = 'Default';
    const res = await callSidecar<{
      ok: boolean;
      token?: { id: string; name: string; prefix: string };
      error?: string;
    }>(
      '/v1/mcp/tokens/create',
      {
        userId,
        name: defaultName,
        tokenHash: hashApiToken(plainToken),
        encryptedToken: encryptApiKey(plainToken),
        prefix: plainToken.slice(0, 8),
      },
      { label: 'mcp /v1/mcp/tokens/create default' }
    );

    if (!res.ok || !res.token) {
      throw ApiError.internal(res.error || 'Failed to create default MCP token');
    }

    return ok({ token: plainToken, name: res.token.name, prefix: res.token.prefix });
  },
});
