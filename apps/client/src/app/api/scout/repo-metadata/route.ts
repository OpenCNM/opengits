/**
 * POST /api/scout/repo-metadata
 *
 * 仓库领域/标签分类的懒取端点（消费点拉取）：大纲生成响应不再携带 metadata
 * 伴生产出（思考类模型整链分钟级，曾把树大纲响应扣死），客户端在大纲就绪后
 * fire-and-forget 调本端点预填 WorkbenchMetadataBar；晚到/超时 fail-open
 * 维持 Others 兜底，用户手动选择优先（MetadataBar 预填守卫语义不变）。
 */

import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { classifyRepoMetadata } from '@/lib/scout/pipeline/repo-metadata-classifier';

export const maxDuration = 60;

/** 分类证据截止：非关键路径离线化后只需封病理悬挂，30s 容纳低档思考链 */
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
