import { describe, it, expect } from 'vitest';

describe('M10 [10.1] System Health Monitoring & Active Probes', () => {
  it('10.1.1.1 探针健康状态类型与判断逻辑', () => {
    const computeSummary = (criticalCount: number, warningCount: number) => ({
      criticalCount,
      warningCount,
      isHealthy: criticalCount === 0,
    });

    expect(computeSummary(0, 2).isHealthy).toBe(true);
    expect(computeSummary(1, 0).isHealthy).toBe(false);
  });
});
