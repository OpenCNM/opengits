import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

interface ConversationMessagesSidecarResponse {
  ok: boolean;
  messages?: Array<{
    id: string;
    role: string;
    content: any;
    toolInvocations?: any;
    createdAt: string;
  }>;
  error?: string;
  code?: string;
}

interface ConversationUpdateSidecarResponse {
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

interface ConversationDeleteSidecarResponse {
  ok: boolean;
  message?: string;
  error?: string;
  code?: string;
}

export const GET = defineRoute<{ id: string }>({
  scope: 'GET /api/conversations/[id]',
  auth: 'user',
  handler: async ({ params, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const { id } = params;

    const res = await callSidecar<ConversationMessagesSidecarResponse>(
      '/v1/conversations/messages',
      { conversationId: id, userId },
      { label: 'conversations /v1/conversations/messages' }
    );

    if (!res.ok) {
      if (res.code === 'NOT_FOUND') {
        throw ApiError.notFound(res.error || 'Conversation not found');
      }
      throw ApiError.internal(res.error || 'Failed to get conversation messages');
    }

    return ok(res.messages ?? []);
  },
});

export const PUT = defineRoute<{ id: string }, { title?: string }>({
  scope: 'PUT /api/conversations/[id]',
  auth: 'user',
  bodySchema: z.object({
    title: z.string().optional(),
  }),
  handler: async ({ params, body, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const { id } = params;
    const { title } = body;

    if (!title || !title.trim()) {
      throw ApiError.badRequest('Title cannot be empty');
    }

    const res = await callSidecar<ConversationUpdateSidecarResponse>(
      '/v1/conversations/update',
      { id, userId, title: title.trim() },
      { label: 'conversations /v1/conversations/update' }
    );

    if (!res.ok) {
      if (res.code === 'NOT_FOUND') {
        throw ApiError.notFound(res.error || 'Conversation not found');
      }
      throw ApiError.internal(res.error || 'Failed to update conversation');
    }

    return ok(res.conversation);
  },
});

export const DELETE = defineRoute<{ id: string }>({
  scope: 'DELETE /api/conversations/[id]',
  auth: 'user',
  handler: async ({ params, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const { id } = params;

    const res = await callSidecar<ConversationDeleteSidecarResponse>(
      '/v1/conversations/delete',
      { id, userId },
      { label: 'conversations /v1/conversations/delete' }
    );

    if (!res.ok) {
      if (res.code === 'NOT_FOUND') {
        throw ApiError.notFound(res.error || 'Conversation not found');
      }
      throw ApiError.internal(res.error || 'Failed to delete conversation');
    }

    return ok({ message: res.message || 'Conversation deleted' });
  },
});
