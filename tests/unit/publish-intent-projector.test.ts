import { describe, expect, it } from 'vitest';
import { projectPublishIntent } from '@/lib/state/publish-intent-projector';

describe('发布意图投影器（自动发布单一仲裁点）', () => {
  it('READY_TO_SUBMIT：意图明确 + 全部就绪 + 未公开 + 无审核记录 —— 自动触发唯一条件', () => {
    for (const reviewStatus of ['NONE', null, undefined]) {
      expect(
        projectPublishIntent({
          publishRequested: true,
          isPublic: false,
          reviewStatus,
          allProcessed: true,
        })
      ).toBe('READY_TO_SUBMIT');
    }
  });

  it('转录未完成 → IDLE（意图延期，绝不提前触发）', () => {
    expect(
      projectPublishIntent({ publishRequested: true, isPublic: false, reviewStatus: 'NONE', allProcessed: false })
    ).toBe('IDLE');
  });

  it('无公开意图 → IDLE（私有是主动选择）', () => {
    expect(
      projectPublishIntent({ publishRequested: false, isPublic: false, reviewStatus: 'NONE', allProcessed: true })
    ).toBe('IDLE');
  });

  it('已公开为最强事实 → PUBLISHED（吞掉其余一切信号）', () => {
    expect(
      projectPublishIntent({ publishRequested: false, isPublic: true, reviewStatus: 'REJECTED', allProcessed: false })
    ).toBe('PUBLISHED');
  });

  it('审核状态优先于自动触发：PENDING/REJECTED 阻断 READY_TO_SUBMIT', () => {
    expect(
      projectPublishIntent({ publishRequested: true, isPublic: false, reviewStatus: 'PENDING', allProcessed: true })
    ).toBe('PENDING_REVIEW');
    expect(
      projectPublishIntent({ publishRequested: true, isPublic: false, reviewStatus: 'REJECTED', allProcessed: true })
    ).toBe('REJECTED');
  });

  it('APPROVED 但未公开 → INELIGIBLE（事务不一致，禁止自动动作）', () => {
    expect(
      projectPublishIntent({ publishRequested: true, isPublic: false, reviewStatus: 'APPROVED', allProcessed: true })
    ).toBe('INELIGIBLE');
  });
});
