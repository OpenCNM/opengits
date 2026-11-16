"use server";

// Sync 回放（2026-09-17 Node 管线收刀迁移）：不再 exec CLI 子进程，
// 改为创建 ImportJob 走统一队列（Go sidecar 单一执行体）。
// 复用导入时持久化的目录前缀（repoProfile.ingestPrefix），保持与原 CLI
// 语义一致：同仓库同范围重放；保留既有 isPublic/category/tags 不回退默认值。

import { revalidatePath, revalidateTag } from 'next/cache';
import { getServerSession } from "next-auth/next";
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { PUBLIC_HOME_CACHE_TAG } from '@/lib/home/public-home-data';
import { createImportJob, scheduleImportJob } from '@/lib/jobs/import-job-store';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';

/** 从 Repository.repoProfile JSON 中读取导入时实际转录的目录前缀 */
function readIngestPrefix(profile: unknown): string | null {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const value = (profile as Record<string, unknown>).ingestPrefix;
  return typeof value === 'string' ? value : null;
}

export async function runIngestion(owner: string, repo: string) {
  try {
    const isDev = process.env.NODE_ENV === 'development';
    const session = await getServerSession();
    if (!isDev && (!session || !session.user)) {
      return { success: false as const, error: 'Unauthorized' };
    }
    const userId = (session?.user as { id?: string } | undefined)?.id;
    if (!userId) {
      return { success: false as const, error: 'Unauthorized' };
    }

    const repository = await prisma.repository.findFirst({
      where: { owner, repo, branch: ENGINE_CONFIG.defaultBranch },
      orderBy: { edition: 'asc' },
      select: {
        id: true,
        isPublic: true,
        category: true,
        tags: true,
        edition: true,
        repoProfile: true,
      },
    });
    if (!repository) {
      return { success: false as const, error: 'Repository not found' };
    }

    if (!repository.isPublic && !(await verifyRepoAccessDirect(repository, userId))) {
      return { success: false as const, error: 'Unauthorized' };
    }

    // 复用导入时实际转录的目录前缀（如 translations/zh-CN/）；无记录则转录根目录
    let prefix = readIngestPrefix(repository.repoProfile) ?? '';
    if (prefix && !/^[a-zA-Z0-9_./,-]+$/.test(prefix)) {
      prefix = '';
    }

    const branch = ENGINE_CONFIG.defaultBranch;
    const { jobId } = await createImportJob({
      userId,
      owner,
      repo,
      branch,
      edition: repository.edition ?? '',
      params: {
        kind: '',
        userId,
        branch,
        edition: repository.edition ?? '',
        frozenCredits: 0,
        publishRequested: false,
        // 回滚守卫：重建的仓已存在 → 失败绝不清理既有教程行
        preExistingRepo: { id: repository.id, isPublic: repository.isPublic },
        options: {
          prefixFilter: prefix,
          isPublic: repository.isPublic,
          category: repository.category ?? undefined,
          tags: repository.tags ?? [],
          useAi: false,
        },
      },
    });
    await scheduleImportJob(jobId);

    revalidatePath(`/docs/${owner}/${repo}`, 'layout');
    revalidateTag(PUBLIC_HOME_CACHE_TAG, 'max');

    return { success: true as const, jobId };
  } catch (error: any) {
    console.error('[Server Action] Ingestion failed:', error);
    return { success: false as const, error: error?.message ?? String(error) };
  }
}
