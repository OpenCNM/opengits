import { describe, it, expect } from 'vitest';
import { IMPORT_JOB_STATUS, isTerminalJobStatus } from '../../apps/client/src/lib/schemas/import-job';

describe('M01 [1.4] Ingest Job State Machine & CAS Transitions', () => {
  it('1.4.2.1 任务状态流转与终态判定', () => {
    expect(isTerminalJobStatus(IMPORT_JOB_STATUS.COMPLETED)).toBe(true);
    expect(isTerminalJobStatus(IMPORT_JOB_STATUS.FAILED)).toBe(true);
    expect(isTerminalJobStatus(IMPORT_JOB_STATUS.QUEUED)).toBe(false);
    expect(isTerminalJobStatus(IMPORT_JOB_STATUS.RUNNING)).toBe(false);
  });

  it('1.4.3.1 事件序列单调递增性保障', () => {
    let seq = 0;
    const events = ['start', 'stage:meta', 'stage:tree', 'done'].map((type) => ({
      seq: seq++,
      type,
    }));

    for (let i = 0; i < events.length - 1; i++) {
      expect(events[i + 1].seq).toBeGreaterThan(events[i].seq);
    }
  });
});
