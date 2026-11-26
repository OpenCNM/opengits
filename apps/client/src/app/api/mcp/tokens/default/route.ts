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
