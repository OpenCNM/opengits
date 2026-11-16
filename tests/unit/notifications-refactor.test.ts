import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 站内信体系重构与闭环治理（346 准则）深度回归单测：
 * 1. 契约三层同步（Prisma Schema ↔ Zod NOTIFICATION_TYPES ↔ i18n 字典 ↔ Go）
 * 2. 统一发送咽喉单写者契约（sendNotifications ➔ /v1/notifications/create）
 * 3.（已退役）转录完成/中断通知闭环随 Node 消费循环删除（2026-10 收口）：
 *    单写者收敛到 Go queries/transcription.sql（内置 10 分钟防抖）
 * 4. 前端消费端与历史兼容性回归（NotificationBell: getNotificationMeta / notificationHref；
 *    含存量 chapter_trial_open 历史行的渲染兼容）
 * 5. 教程公开审核驳回失败通知闭环（admin/review/route，随 admin 拆分迁至私有仓
 *    tests/unit/notifications-refactor.admin.test.ts）
 */

const callSidecarMock = vi.fn();

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

describe('1. 契约三层同步与词表收敛', () => {
  it('NOTIFICATION_TYPES 必须严格包含 9 大受支持业务类型', async () => {
    const { NOTIFICATION_TYPES } = await import('@/lib/schemas/notification');
    expect(NOTIFICATION_TYPES).toEqual({
      TRANSCRIPTION_DONE: 'transcription_done',
      TRANSCRIPTION_FAILED: 'transcription_failed',
      TUTORIAL_PUBLISHED: 'tutorial_published',
      TUTORIAL_REJECTED: 'tutorial_rejected',
      TRANSCRIPTION_REWARD: 'transcription_reward',
      VERSION_WON: 'version_won',
      RELAY_OPEN: 'relay_open',
      CHAPTER_TRIAL_OPEN: 'chapter_trial_open',
      AUTO_SYNC_APPLIED: 'auto_sync_applied',
    });
  });

  it('已退役类型 publish_gift 与 version_displaced 禁止出现在 NOTIFICATION_TYPES 中', async () => {
    const { NOTIFICATION_TYPES } = await import('@/lib/schemas/notification');
    const values = Object.values(NOTIFICATION_TYPES);
    expect(values).not.toContain('publish_gift');
    expect(values).not.toContain('version_displaced');
  });

  it('Prisma Schema 注释必须声明三层同步的所有通知类型', () => {
    const schemaPath = path.resolve(__dirname, '../../prisma/schema.prisma');
    const schemaContent = fs.readFileSync(schemaPath, 'utf8');

    expect(schemaContent).toContain('transcription_done');
    expect(schemaContent).toContain('transcription_failed');
    expect(schemaContent).toContain('tutorial_published');
    expect(schemaContent).toContain('tutorial_rejected');
    expect(schemaContent).toContain('transcription_reward');
    expect(schemaContent).toContain('version_won');
    expect(schemaContent).toContain('relay_open');
    expect(schemaContent).toContain('chapter_trial_open');
    expect(schemaContent).toContain('auto_sync_applied');
  });

  it('中英国际化字典必须对齐新增通知类型', () => {
    const zhPath = path.resolve(__dirname, '../../apps/client/messages/zh-CN.json');
    const enPath = path.resolve(__dirname, '../../apps/client/messages/en.json');
    const zh = JSON.parse(fs.readFileSync(zhPath, 'utf8'));
    const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));

    const requiredKeys = [
      'notification_type_transcription_failed',
      'notification_type_tutorial_rejected',
      'notification_type_tutorial_published',
      'notification_type_tutorial_transcription_done',
      'notification_type_version_won',
      'notification_type_chapter_trial_open',
      'notification_type_relay_open',
    ];

    for (const key of requiredKeys) {
      expect(zh[key], `zh-CN missing ${key}`).toBeDefined();
      expect(en[key], `en missing ${key}`).toBeDefined();
    }

    expect(zh.notification_type_transcription_failed).toBe('转录中断');
    expect(en.notification_type_transcription_failed).toBe('Transcription Interrupted');
    expect(zh.notification_type_tutorial_rejected).toBe('审核未通过');
    expect(en.notification_type_tutorial_rejected).toBe('Review Rejected');
  });
});

describe('2. 统一发送咽喉单写者契约 (notification-sender)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sendNotifications 将单条通知正确序列化并提交 Go Sidecar', async () => {
    callSidecarMock.mockResolvedValue({ ok: true, count: 1 });
    const { sendNotifications } = await import('@/lib/notifications/notification-sender');

    await sendNotifications({
      userId: 'usr-1',
      type: 'transcription_failed',
      title: '教程转录中断',
      body: 'owner/repo · 遇到异常已暂停',
      payload: { owner: 'owner', repo: 'repo', error: 'LLM timeout' },
    });

    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/notifications/create',
      {
        notifications: [
          {
            userId: 'usr-1',
            type: 'transcription_failed',
            title: '教程转录中断',
            body: 'owner/repo · 遇到异常已暂停',
            payload: { owner: 'owner', repo: 'repo', error: 'LLM timeout' },
          },
        ],
      },
      expect.objectContaining({ label: 'notifications-create' })
    );
  });

  it('sendNotifications 批量发送且支持空通知列表静默安全返回', async () => {
    callSidecarMock.mockResolvedValue({ ok: true, count: 2 });
    const { sendNotifications } = await import('@/lib/notifications/notification-sender');

    await sendNotifications([]);
    expect(callSidecarMock).not.toHaveBeenCalled();

    await sendNotifications([
      { userId: 'u1', type: 'tutorial_rejected', title: '驳回 1' },
      { userId: 'u2', type: 'tutorial_rejected', title: '驳回 2' },
    ]);
    expect(callSidecarMock).toHaveBeenCalledTimes(1);
  });

  it('Sidecar 异常时 fire-and-forget 降级，不抛出异常阻断业务', async () => {
    callSidecarMock.mockRejectedValue(new Error('sidecar down'));
    const { sendNotifications } = await import('@/lib/notifications/notification-sender');

    await expect(
      sendNotifications({
        userId: 'u1',
        type: 'transcription_failed',
        title: '失败',
      })
    ).resolves.toBeUndefined();
  });
});

// 第 4 节（transcription-queue 通知闭环）已随 Node 消费循环退役删除（2026-10 收口）：
// 完成/中断通知的单写者收敛到 Go 侧 queries/transcription.sql（SQL 内置
// 10 分钟防抖窗口）与 FailTranscriptionJobExhausted 终态分支。
describe('5. 前端消费端与历史兼容性回归 (NotificationBell)', () => {
  it('notificationHref：正确处理发布、转录中断、审核驳回及章节深链', async () => {
    const { notificationHref } = await import('@/components/notifications/NotificationBell');

    // 1. tutorial_published 跳转广场高亮
    const pubHref = notificationHref({
      id: 'n1',
      type: 'tutorial_published',
      title: '上线',
      body: '',
      payload: { owner: 'facebook', repo: 'react' },
      readAt: null,
      createdAt: new Date(),
    });
    expect(pubHref).toBe('/?q=react&highlight=facebook%2Freact');

    // 2. transcription_failed 带章节 path 深链至具体章节
    const failHref = notificationHref({
      id: 'n2',
      type: 'transcription_failed',
      title: '转录中断',
      body: '',
      payload: { owner: 'vuejs', repo: 'core', path: 'chapters/01-reactivity.mdx' },
      readAt: null,
      createdAt: new Date(),
    });
    expect(failHref).toBe('/docs/vuejs/core/chapters/01-reactivity');

    // 3. tutorial_rejected 无章节 path 跳转教程首页
    const rejHref = notificationHref({
      id: 'n3',
      type: 'tutorial_rejected',
      title: '审核未通过',
      body: '',
      payload: { owner: 'vercel', repo: 'next.js', reason: '需要补充版权声明' },
      readAt: null,
      createdAt: new Date(),
    });
    expect(rejHref).toBe('/docs/vercel/next.js');

    // 4. payload 缺少 owner/repo 返回 null
    const nullHref = notificationHref({
      id: 'n4',
      type: 'transcription_failed',
      title: '转录中断',
      body: '',
      payload: {},
      readAt: null,
      createdAt: new Date(),
    });
    expect(nullHref).toBeNull();
  });

  it('getNotificationMeta：对新失败类型与历史退役类型均能优雅回退解析', async () => {
    const { getNotificationMeta } = await import('@/components/notifications/NotificationBell');

    // 失败告警类型
    const failMeta = getNotificationMeta('transcription_failed');
    expect(failMeta.label).toBeTruthy();
    expect(failMeta.icon).toBeDefined();

    const rejMeta = getNotificationMeta('tutorial_rejected');
    expect(rejMeta.label).toBeTruthy();
    expect(rejMeta.icon).toBeDefined();

    // 历史退役类型优雅兼容（不抛异常且有专门元数据）
    const legacyGiftMeta = getNotificationMeta('publish_gift');
    expect(legacyGiftMeta.label).toBeTruthy();
    expect(legacyGiftMeta.icon).toBeDefined();

    const legacyDisplacedMeta = getNotificationMeta('version_displaced');
    expect(legacyDisplacedMeta.label).toBeTruthy();
    expect(legacyDisplacedMeta.icon).toBeDefined();

    // 兜底未知类型
    const defaultMeta = getNotificationMeta('some_unknown_type');
    expect(defaultMeta.label).toBeTruthy();
    expect(defaultMeta.icon).toBeDefined();
  });
});
