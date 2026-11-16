import { z } from 'zod';
import { generateApiToken, hashApiToken } from '@/lib/mcp/token-auth';
import { encryptApiKey } from '@/lib/crypto/api-key-cipher';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

/**
 * MCP API Token 管理端点（面向 Web 用户设置页，走登录会话，不面向智能体）。
 * - GET    列出当前用户的 Token 元数据（绝不返回明文/摘要，已下沉 Go sidecar）
 * - POST   创建新 Token（明文仅此一次随 201 返回，服务端只存 sha256 摘要，已下沉 Go sidecar）
 * - DELETE 吊销并删除指定 Token（软撤销，已下沉 Go sidecar）
 */

/** 每用户 Token 数量上限（防无限刷行；超出需先删除旧 Token） */
const MAX_TOKENS_PER_USER = 20;

const createTokenSchema = z.object({
  name: z.string().trim().min(1, 'Token name is required').max(50, 'Token name must be <= 50 chars'),
});

interface McpTokensListSidecarResponse {
  ok: boolean;
  tokens?: Array<{
    id: string;
    name: string;
    prefix: string;
    lastUsedAt?: string | null;
    createdAt: string;
    revokedAt?: string | null;
  }>;
  error?: string;
}

interface McpTokenCreateSidecarResponse {
  ok: boolean;
  token?: {
    id: string;
    name: string;
    prefix: string;
    createdAt: string;
  };
  error?: string;
  code?: string;
}

interface McpTokenRevokeSidecarResponse {
  ok: boolean;
  revoked?: boolean;
  error?: string;
  code?: string;
}

export const GET = defineRoute({
  scope: 'GET /api/mcp/tokens',
  auth: 'user',
  handler: async ({ userId }) => {
    const res = await callSidecar<McpTokensListSidecarResponse>(
      '/v1/mcp/tokens/list',
      { userId: userId! },
      { label: 'mcp /v1/mcp/tokens/list' }
    );

    if (!res.ok) {
      throw ApiError.internal(res.error || 'Failed to list MCP tokens');
    }

    return ok({ tokens: res.tokens ?? [] });
  },
});

export const POST = defineRoute<Record<string, string>, z.infer<typeof createTokenSchema>>({
  scope: 'POST /api/mcp/tokens',
  auth: 'user',
  bodySchema: createTokenSchema,
  handler: async ({ userId, body }) => {
    const plainToken = generateApiToken();
    const res = await callSidecar<McpTokenCreateSidecarResponse>(
      '/v1/mcp/tokens/create',
      {
        userId: userId!,
        name: body.name,
        tokenHash: hashApiToken(plainToken),
        encryptedToken: encryptApiKey(plainToken),
        prefix: plainToken.slice(0, 8),
      },
      { label: 'mcp /v1/mcp/tokens/create' }
    );

    if (!res.ok) {
      if (res.code === 'MAX_TOKENS_EXCEEDED') {
        throw ApiError.conflict(
          res.error || `Maximum active tokens limit reached (${MAX_TOKENS_PER_USER}). Please revoke unused tokens first.`,
          { code: 'MAX_TOKENS_EXCEEDED' }
        );
      }
      throw ApiError.internal(res.error || 'Failed to create MCP token');
    }

    // 明文仅此一次返回（不存库、不再出现在任何列表接口）
    return ok({ token: { ...res.token, plainToken } }, 201);
  },
});

export const DELETE = defineRoute({
  scope: 'DELETE /api/mcp/tokens',
  auth: 'user',
  handler: async ({ userId, request }) => {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id || id.length > 64) {
      throw ApiError.badRequest('Invalid token id', { code: 'INVALID_TOKEN_ID' });
    }

    // 软撤销：置 revokedAt，保留历史调用记录与安全审计日志，鉴权通道即时过滤失效
    const res = await callSidecar<McpTokenRevokeSidecarResponse>(
      '/v1/mcp/tokens/revoke',
      { id, userId: userId! },
      { label: 'mcp /v1/mcp/tokens/revoke' }
    );

    if (!res.ok) {
      if (res.code === 'TOKEN_NOT_FOUND') {
        throw ApiError.notFound(res.error || 'Token not found or already revoked', { code: 'TOKEN_NOT_FOUND' });
      }
      throw ApiError.internal(res.error || 'Failed to revoke MCP token');
    }

    return ok({ revoked: true });
  },
});
