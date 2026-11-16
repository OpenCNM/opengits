import { revalidateTag } from 'next/cache';
import { prisma } from '@/lib/db';
import { PUBLIC_HOME_CACHE_TAG } from '@/lib/home/public-home-data';
import { grantImportReward } from '@/lib/credits/import-reward';
import { invalidateWebL1Projection } from '@/lib/docs/web-outline-projection';
import { callSidecar } from '@/lib/sidecar-client';

/**
 * 发布扇出（Saga 式对账补偿）——发布事务提交后的跨系统尾部写的唯一实现。
 *
 * 设计公理（lib/state/README.md §四 受控例外 #1）：
 * - 尾部五步中四步天然可安全重放（revalidateTag 声明式 stale / L1 进程内 Map 删除 /
 *   发奖双层防重），因此本函数
 *   **全量可重放**：重试（already-public）、对账（reconcile）、admin 审核通过
 *   共用同一入口，单步失败仅记观测、绝不级联跳过后续步骤。
 * - 唯一非幂等步骤（接力通知，Notification 无去重键）以 Repository.relayNotifiedAt
 *   物理事实戳防重：查戳 → 发送 → 落戳；已知接缝：发送成功但落戳失败的窄窗口会
 *   重发一次（README §六登记）。
 */

export type PublishFanoutReason = 'publish' | 'retry' | 'reconcile' | 'admin-approve' | 'relay-toggle';

export type FanoutStepStatus = 'ok' | 'skipped' | 'failed';

export interface PublishFanoutResult {
  repositoryId: string;
  reason: PublishFanoutReason;
  steps: Record<string, FanoutStepStatus>;
  /** 任一步失败时为 true（调用方据此观测，不影响发布成功语义） */
  hasFailures: boolean;
}

async function captureFanoutError(err: unknown, repositoryId: string, step: string): Promise<void> {
  const { captureError } = await import('@/lib/observability/errors');
  void captureError(err, { scope: `publish-fanout/${step}`, extra: { repositoryId } });
}

/**
 * 跨进程缓存失效：client 的 unstable_cache tag 存活在其自身进程内，
 * admin 或 worker 侧 revalidateTag 摸不到——经内部端点通知 client 失效。
 * repositoryIds 同时清退 client 进程的 L1 大纲投影（isPublic 翻转即时生效）。
 * WEB_INTERNAL_URL/INTERNAL_API_TOKEN 未配置时静默跳过（60s TTL 兜底）。
 */
export async function notifyClientRevalidate(tags: string[], repositoryIds: string[] = []): Promise<void> {
  const base = process.env.WEB_INTERNAL_URL;
  const token = process.env.INTERNAL_API_TOKEN;
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

/** 单步隔离执行：失败记观测并标记 failed，绝不传染后续步骤 */
async function runStep(
  repositoryId: string,
  step: string,
  fn: () => Promise<'ok' | 'skipped'>
): Promise<FanoutStepStatus> {
  try {
    return await fn();
  } catch (err) {
    await captureFanoutError(err, repositoryId, step).catch(() => undefined);
    return 'failed';
  }
}

/** 接力通知一次性发送（查戳 → 发送 → 落戳；relay-toggle 与发布扇出共用） */
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
    // 落物理事实戳（经 Go patch——Repository 写权归 Go，Node 只读）：
    // 此后一切重放（重试/对账）对本仓的通知步骤均为 no-op
    await callSidecar(
      '/v1/repos/patch',
      { id: repository.id, touchRelayNotifiedAt: true },
      { label: 'publish-fanout-relay-notified' }
    );
    return 'ok';
  });
}

/**
 * 发布扇出全量重放。步骤原序保留：
 * 1. 首页公共缓存 stale 标记（幂等）
 * 2. L1 进程内投影清退（幂等；多实例部署为已知不做项）
 * 3. 导入奖励（Node 快路径 + Go advisory lock 双层防重）
 * 4. 接力通知（relayNotifiedAt 事实戳防重，唯一非幂等步骤）
 */
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
