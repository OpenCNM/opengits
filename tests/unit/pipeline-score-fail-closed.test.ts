import { describe, expect, it, vi, beforeEach } from 'vitest';

const callSidecarMock = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

const { computePipelineScore } = await import('@/lib/review/pipeline-score');

describe('computePipelineScore (Fail-Closed 与 Sidecar 集成)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Sidecar 可达且返回有效评分：正确透出分数与五维 AST 明细', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      score: 85,
      floor: 70,
      dims: {
        coverage: 90,
        practicality: 80,
        pedagogy: 85,
        modernity: 80,
        production: 90,
      },
    });

    const res = await computePipelineScore('repo-healthy');
    expect(res.total).toBe(85);
    expect(res.passed).toBe(true);
    expect(res.unavailable).toBeUndefined();
    expect(res.dimensions).toHaveLength(5);
    expect(res.dimensions[0].detail).toContain('AST 真语法节点口径');
  });

  it('Sidecar 不可达/超时异常：Fail-Closed 返回 unavailable: true, passed: false, total: 0（严禁降级正则）', async () => {
    callSidecarMock.mockRejectedValueOnce(new Error('connection refused: 127.0.0.1:8080'));

    const res = await computePipelineScore('repo-sidecar-down');
    expect(res.total).toBe(0);
    expect(res.passed).toBe(false);
    expect(res.unavailable).toBe(true);
    expect(res.dimensions).toEqual([]);
  });

  it('Sidecar 返回 ok: false：Fail-Closed 返回 unavailable: true', async () => {
    callSidecarMock.mockResolvedValueOnce({ ok: false });

    const res = await computePipelineScore('repo-sidecar-error');
    expect(res.total).toBe(0);
    expect(res.passed).toBe(false);
    expect(res.unavailable).toBe(true);
    expect(res.dimensions).toEqual([]);
  });

  it('Sidecar 正常返回但分数未达门禁（50 < 70）：passed: false 且 unavailable 为 undefined', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      score: 50,
      floor: 70,
      dims: {
        coverage: 50,
        practicality: 50,
        pedagogy: 50,
        modernity: 50,
        production: 50,
      },
    });

    const res = await computePipelineScore('repo-subpar');
    expect(res.total).toBe(50);
    expect(res.passed).toBe(false);
    expect(res.unavailable).toBeUndefined();
    expect(res.dimensions).toHaveLength(5);
  });
});
