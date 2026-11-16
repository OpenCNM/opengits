import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAPTER_UPDATE_JOB_TRANSITIONS,
  canTransitionChapterUpdateJob,
  isTerminalChapterUpdateJob,
  projectChapterUpdateLifecycle,
  projectClaimTranscribePoll,
  deriveRelayTaskPhase,
} from '@/lib/state/chapter-update-state-projector';

const GO_STATES_PATH = join(
  __dirname,
  '../../services/worker-sidecar/internal/market/states.go'
);

/** 解析 Go SSOT：常量表 + 迁移 map → 可对拍结构 */
function parseGoSsot(): {
  values: Record<string, string>;
  transitions: Record<string, string[]>;
} {
  const src = readFileSync(GO_STATES_PATH, 'utf8');

  const values: Record<string, string> = {};
  const constRe = /MarketStatus(\w+)\s+ChapterUpdateJobStatus\s*=\s*"([A-Z]+)"/g;
  for (const [, name, value] of src.matchAll(constRe)) {
    values[name] = value;
  }

  const transitions: Record<string, string[]> = {};
  const mapMatch = src.match(
    /chapterUpdateJobTransitions\s*=\s*map\[ChapterUpdateJobStatus\]map\[ChapterUpdateJobStatus\]bool\{([\s\S]*?)\n\}/
  );
  if (!mapMatch) throw new Error('Go 迁移表解析失败：未找到 chapterUpdateJobTransitions');
  for (const [, fromName, targetsBlock] of mapMatch[1].matchAll(
    /MarketStatus(\w+):\s*\{([\s\S]*?)\},/g
  )) {
    const targets = [...targetsBlock.matchAll(/MarketStatus(\w+):\s*true/g)].map(
      ([, t]) => values[t]
    );
    transitions[values[fromName]] = targets;
  }
  return { values, transitions };
}

describe('章节更新市场生命周期（Go SSOT 逐字镜像）', () => {
  it('同步锁：TS 迁移表与 Go states.go 逐边对拍（Go 变更必须显式同步 TS）', () => {
    const { values, transitions } = parseGoSsot();
    expect(Object.values(values).sort()).toEqual(
      ['CANCELLED', 'CLAIMED', 'FAILED', 'PENDING', 'REJECTED', 'SWAPPED', 'TRIAL'].sort()
    );
    for (const [from, targets] of Object.entries(transitions)) {
      expect(
        [...CHAPTER_UPDATE_JOB_TRANSITIONS[from as keyof typeof CHAPTER_UPDATE_JOB_TRANSITIONS]].sort(),
        `TS 缺少/多出 ${from} 的出边`
      ).toEqual([...targets].sort());
    }
    // TS 不得私增 Go 之外的态
    expect(Object.keys(CHAPTER_UPDATE_JOB_TRANSITIONS).sort()).toEqual(
      Object.keys(transitions).sort()
    );
  });

  it('canTransition：合法边放行、非法边拒绝、未知态拒绝', () => {
    expect(canTransitionChapterUpdateJob('PENDING', 'CLAIMED')).toBe(true);
    expect(canTransitionChapterUpdateJob('CLAIMED', 'PENDING')).toBe(true); // 租约回池
    expect(canTransitionChapterUpdateJob('CLAIMED', 'SWAPPED')).toBe(true); // RELAY 桩直换
    expect(canTransitionChapterUpdateJob('TRIAL', 'SWAPPED')).toBe(true);
    expect(canTransitionChapterUpdateJob('PENDING', 'SWAPPED')).toBe(false);
    expect(canTransitionChapterUpdateJob('SWAPPED', 'PENDING')).toBe(false); // 终态无出边
    expect(canTransitionChapterUpdateJob('NOT_A_STATUS', 'PENDING')).toBe(false);
  });

  it('isTerminal：SWAPPED/REJECTED/FAILED/CANCELLED 终态，活跃三态非终态', () => {
    for (const s of ['SWAPPED', 'REJECTED', 'FAILED', 'CANCELLED']) {
      expect(isTerminalChapterUpdateJob(s)).toBe(true);
    }
    for (const s of ['PENDING', 'CLAIMED', 'TRIAL']) {
      expect(isTerminalChapterUpdateJob(s)).toBe(false);
    }
  });

  it('生命周期投影：租约过期 → CLAIMED_STALE（客户端可感知回池）', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const active = projectChapterUpdateLifecycle({
      status: 'CLAIMED',
      claimedUntil: new Date('2026-10-19T13:00:00Z'),
      now,
    });
    expect(active.phase).toBe('CLAIMED_ACTIVE');
    expect(active.leaseStale).toBe(false);
    expect(active.isActive).toBe(true);

    const stale = projectChapterUpdateLifecycle({
      status: 'CLAIMED',
      claimedUntil: new Date('2026-10-19T11:00:00Z'),
      now,
    });
    expect(stale.phase).toBe('CLAIMED_STALE');
    expect(stale.leaseStale).toBe(true);
    expect(stale.isActive).toBe(true);
  });

  it('生命周期投影：TRIAL 存量排水归 TRIAL_LEGACY；APPLIED 遗留归并 SWAPPED', () => {
    expect(projectChapterUpdateLifecycle({ status: 'TRIAL' }).phase).toBe('TRIAL_LEGACY');
    expect(projectChapterUpdateLifecycle({ status: 'APPLIED' }).phase).toBe('SWAPPED');
    expect(projectChapterUpdateLifecycle({ status: 'WHATEVER' }).phase).toBe('UNKNOWN');
  });
});

describe('claim-transcribe 轮询投影（API 文案兼容）', () => {
  it('doc PROCESSED 或 job SWAPPED/APPLIED → completed', () => {
    expect(projectClaimTranscribePoll({ docProcessed: true, jobStatus: 'CLAIMED' })).toEqual({
      status: 'completed',
    });
    expect(projectClaimTranscribePoll({ docProcessed: false, jobStatus: 'SWAPPED' })).toEqual({
      status: 'completed',
    });
    expect(projectClaimTranscribePoll({ docProcessed: false, jobStatus: 'APPLIED' })).toEqual({
      status: 'completed',
    });
  });

  it('有效租约 CLAIMED → running；租约过期 → failed 回池文案', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    expect(
      projectClaimTranscribePoll({
        docProcessed: false,
        jobStatus: 'CLAIMED',
        claimedUntil: new Date('2026-10-19T13:00:00Z'),
        now,
      })
    ).toEqual({ status: 'running' });

    expect(
      projectClaimTranscribePoll({
        docProcessed: false,
        jobStatus: 'CLAIMED',
        claimedUntil: new Date('2026-10-19T11:00:00Z'),
        now,
      })
    ).toEqual({ status: 'failed', error: '认领超时，任务已回池' });
  });

  it('FAILED → 失败文案透传；无 job → 任务不存在；异常态 → 状态异常', () => {
    expect(
      projectClaimTranscribePoll({ docProcessed: false, jobStatus: 'FAILED', errorMessage: 'LLM 超时' })
    ).toEqual({ status: 'failed', error: 'LLM 超时' });
    expect(
      projectClaimTranscribePoll({ docProcessed: false, jobStatus: 'FAILED', errorMessage: null })
    ).toEqual({ status: 'failed', error: '转录失败' });
    expect(projectClaimTranscribePoll({ docProcessed: false, jobStatus: null })).toEqual({
      status: 'failed',
      error: '任务不存在或已失效',
    });
    expect(projectClaimTranscribePoll({ docProcessed: false, jobStatus: 'PENDING' })).toEqual({
      status: 'failed',
      error: '任务状态异常',
    });
  });
});

describe('deriveRelayTaskPhase（接力任务相位从事实推导）', () => {
  it('result 已落 → completed；error 已落 → failed；两者皆空 → running', () => {
    expect(deriveRelayTaskPhase({ result: { nodeId: 'n1' }, error: null })).toBe('completed');
    expect(deriveRelayTaskPhase({ result: null, error: 'x' })).toBe('failed');
    expect(deriveRelayTaskPhase({ result: null, error: null })).toBe('running');
    expect(deriveRelayTaskPhase({})).toBe('running');
  });

  it('事实优先于持久化中可能陈旧的 status 字段', () => {
    // 旧数据：status 误写 running 但 result 已存在 → 读取端以派生为准
    expect(deriveRelayTaskPhase({ result: { ok: true }, error: null })).toBe('completed');
  });
});
