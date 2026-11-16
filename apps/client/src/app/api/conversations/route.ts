import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

/** GET 用 query 取参；POST 复用同一字段集（body 解析，缺省字段由业务分支兜底） */
const conversationPayloadSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  title: z.string().optional(),
});

interface ConversationsListSidecarResponse {
  ok: boolean;
  conversations?: Array<{
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
  }>;
  error?: string;
  code?: string;
}

interface ConversationCreateSidecarResponse {
  ok: boolean;
  conversation?: {
    id: string;
    userId: string;
    repositoryId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
  };
  error?: string;
  code?: string;
}

export const GET = defineRoute({
  scope: 'GET /api/conversations',
  auth: 'user',
  handler: async ({ request, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();

    const { searchParams } = new URL(request.url);
    const owner = searchParams.get('owner');
    const repo = searchParams.get('repo');

    if (!owner || !repo) {
      throw ApiError.badRequest('Missing owner or repo');
    }

    const res = await callSidecar<ConversationsListSidecarResponse>(
      '/v1/conversations/list',
      { owner, repo, userId },
      { label: 'conversations /v1/conversations/list' }
    );

    if (!res.ok) {
      if (res.code === 'NOT_FOUND') {
        throw ApiError.notFound(res.error || 'Repository not found');
      }
      if (res.code === 'FORBIDDEN') {
        throw ApiError.forbidden(res.error || 'Forbidden: You do not have access to this repository');
      }
      throw ApiError.internal(res.error || 'Failed to list conversations');
    }

    return ok(res.conversations ?? []);
  },
});

export const POST = defineRoute({
  scope: 'POST /api/conversations',
  auth: 'user',
  bodySchema: conversationPayloadSchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const { owner, repo, title } = body;

    if (!owner || !repo) {
      throw ApiError.badRequest('Missing owner or repo');
    }

    const res = await callSidecar<ConversationCreateSidecarResponse>(
      '/v1/conversations/create',
      { owner, repo, userId, title },
      { label: 'conversations /v1/conversations/create' }
    );

    if (!res.ok) {
      if (res.code === 'NOT_FOUND') {
        throw ApiError.notFound(res.error || 'Repository not found');
      }
      if (res.code === 'FORBIDDEN') {
        throw ApiError.forbidden(res.error || 'Forbidden: You do not have access to this repository');
      }
      throw ApiError.internal(res.error || 'Failed to create conversation');
    }

    return ok(res.conversation);
  },
});
