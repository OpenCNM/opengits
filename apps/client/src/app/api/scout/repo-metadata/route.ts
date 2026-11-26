import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { classifyRepoMetadata } from '@/lib/scout/pipeline/repo-metadata-classifier';

export const maxDuration = 60;

const CLASSIFY_DEADLINE_MS = 30_000;

const chapterEvidenceSchema = z.object({
  name: z.string().max(120).optional(),
  title: z.string().max(120).optional(),
  summary: z.string().max(400).optional(),
  files: z
    .array(z.union([z.string().max(400), z.object({ path: z.string().max(400).optional() })]))
    .max(8)
    .optional(),
});

export const POST = defineRoute({
  scope: 'POST /api/scout/repo-metadata',
  auth: 'user',
  bodySchema: z.object({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    chapters: z.array(chapterEvidenceSchema).min(1).max(30),
    stats: z.object({ files: z.number().int().optional(), allFiles: z.number().int().optional() }).optional(),
  }),
  handler: async ({ body, userId }) => {
    const metadata = await classifyRepoMetadata({
      owner: body.owner,
      repo: body.repo,
      chapters: body.chapters,
      stats: body.stats,
      userId,
      signal: AbortSignal.timeout(CLASSIFY_DEADLINE_MS),
    });
    return ok({ metadata });
  },
});
