import { revalidateTag } from 'next/cache';
import { ignoreBestEffort } from '@/lib/best-effort';
import { prisma } from '@/lib/db';
import { PUBLIC_HOME_CACHE_TAG } from '@/lib/home/public-home-data';
import { grantImportReward } from '@/lib/credits/import-reward';
import { invalidateWebL1Projection } from '@/lib/docs/web-outline-projection';
import { callSidecar } from '@/lib/sidecar-client';
import { resolveRuntimeEndpoints } from '@/lib/runtime-endpoints';

// Idempotent post-publish saga: relay notifications use Repository.relayNotifiedAt as a physical dedup stamp.

export type PublishFanoutReason = 'publish' | 'retry' | 'reconcile' | 'admin-approve' | 'relay-toggle';

export type FanoutStepStatus = 'ok' | 'skipped' | 'failed';

export interface PublishFanoutResult {
  repositoryId: string;
  reason: PublishFanoutReason;
  steps: Record<string, FanoutStepStatus>;
  hasFailures: boolean;
}

async function captureFanoutError(err: unknown, repositoryId: string, step: string): Promise<void> {
  const { captureError } = await import('@/lib/observability/errors');
  void captureError(err, { scope: `publish-fanout/${step}`, extra: { repositoryId } });
}

// Pushes cache/L1 invalidation across processes when internal endpoint is configured.
export async function notifyClientRevalidate(tags: string[], repositoryIds: string[] = []): Promise<void> {
  const runtime = resolveRuntimeEndpoints();
  const base = runtime?.webInternalUrl !== undefined ? runtime.webInternalUrl : process.env.WEB_INTERNAL_URL;
  const token = runtime?.internalApiToken ?? process.env.INTERNAL_API_TOKEN;
  if (!base || !token) return;
  try {
    await fetch(`${base.replace(/\/+$/, '')}/api/internal/revalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': token },
      body: JSON.stringify({ tags, repositoryIds }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.warn('[publish-fanout] client revalidate notify failed (TTL fallback applies):', err);
  }
}

async function runStep(
  repositoryId: string,
  step: string,
  fn: () => Promise<'ok' | 'skipped'>
): Promise<FanoutStepStatus> {
  try {
    return await fn();
  } catch (err) {
    await captureFanoutError(err, repositoryId, step).catch(ignoreBestEffort);
    return 'failed';
  }
}

export async function sendRelayOpenNotificationsOnce(
  repository: { id: string; owner: string; repo: string; relayNotifiedAt: Date | null }
): Promise<'ok' | 'skipped' | 'failed'> {
  return runStep(repository.id, 'relay-notify', async () => {
    if (repository.relayNotifiedAt) {
      return 'skipped';
    }
    const followers = await prisma.savedRepo.findMany({
      where: { repositoryId: repository.id, autoFollow: true },
      select: { userId: true },
    });
    if (followers.length > 0) {
      const { sendNotifications } = await import('@/lib/notifications/notification-sender');
      await sendNotifications(
        followers.map((f) => ({
          userId: f.userId,
          type: 'relay_open',
          title: `${repository.owner}/${repository.repo} 开启社区接力`,
          body: `本教程有章节待社区首译，欢迎认领共同完善文档`,
          payload: { owner: repository.owner, repo: repository.repo },
        }))
      );
    }
    await callSidecar(
      '/v1/repos/patch',
      { id: repository.id, touchRelayNotifiedAt: true },
      { label: 'publish-fanout-relay-notified' }
    );
    return 'ok';
  });
}

export async function publishFanout(
  repositoryId: string,
  reason: PublishFanoutReason = 'publish',
  opts?: { relayEnabledOverride?: boolean }
): Promise<PublishFanoutResult> {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { id: true, owner: true, repo: true, relayEnabled: true, relayNotifiedAt: true },
  });
  if (!repository) {
    return { repositoryId, reason, steps: { overall: 'skipped' }, hasFailures: false };
  }

  const steps: Record<string, FanoutStepStatus> = {};

  steps['revalidate-home'] = await runStep(repositoryId, 'revalidate-home', async () => {
    revalidateTag(PUBLIC_HOME_CACHE_TAG, 'max');
    await notifyClientRevalidate([PUBLIC_HOME_CACHE_TAG], [repositoryId]);
    return 'ok';
  });

  steps['l1-invalidate'] = await runStep(repositoryId, 'l1-invalidate', async () => {
    invalidateWebL1Projection(repositoryId);
    return 'ok';
  });

  steps['import-reward'] = await runStep(repositoryId, 'import-reward', async () => {
    await grantImportReward(repositoryId);
    return 'ok';
  });

  const relayEnabled = opts?.relayEnabledOverride ?? repository.relayEnabled;
  steps['relay-notify'] = relayEnabled
    ? await sendRelayOpenNotificationsOnce(repository)
    : 'skipped';

  const hasFailures = Object.values(steps).includes('failed');
  return { repositoryId, reason, steps, hasFailures };
}
