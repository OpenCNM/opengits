import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { enqueueTranscription } from '@/lib/transcription-queue';

export const POST = defineRoute<{ documentId: string }>({
  scope: 'POST /api/transcription/[documentId]/resume',
  auth: 'user',
  handler: async ({ params, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const doc = await prisma.document.findUnique({
      where: { id: params.documentId },
      select: { id: true },
    });
    if (!doc) throw ApiError.notFound('Document not found', { code: 'DOCUMENT_NOT_FOUND' });

    const result = await enqueueTranscription(doc.id, userId);
    return ok({ result });
  },
});
