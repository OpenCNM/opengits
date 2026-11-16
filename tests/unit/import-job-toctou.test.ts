import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createImportJob } from '@/lib/jobs/import-job-store';
import { prisma } from '@/lib/db';

const { callSidecarMock } = vi.hoisted(() => ({
  callSidecarMock: vi.fn(),
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: vi.fn(),
  },
}));

describe('import-job single-writer convergence & dedup delegation (First-Principles)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to sidecar and returns existing jobId with deduped: true when active job exists', async () => {
    callSidecarMock.mockResolvedValueOnce({ id: 'existing-job-456', deduped: true });

    const result = await createImportJob({
      userId: 'user-1',
      owner: 'testowner',
      repo: 'testrepo',
      branch: 'main',
      edition: '',
      params: { userId: 'user-1', frozenCredits: 0 },
    });

    expect(result).toEqual({ jobId: 'existing-job-456', deduped: true });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/jobs/create',
      expect.objectContaining({
        owner: 'testowner',
        repo: 'testrepo',
        branch: 'main',
        edition: '',
        userId: 'user-1',
        // params 原样透传（含调用方冻结值）——入场不再有任何 Node 侧改写
        params: { userId: 'user-1', frozenCredits: 0 },
      }),
      expect.anything()
    );
    // Node DB transaction must NOT be held across RPC
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('delegates to sidecar and returns new jobId with deduped: false when no active job exists', async () => {
    callSidecarMock.mockResolvedValueOnce({ id: 'new-job-123', deduped: false });

    const result = await createImportJob({
      userId: 'user-1',
      owner: 'testowner',
      repo: 'testrepo',
      branch: 'main',
      edition: '',
      params: { userId: 'user-1' },
    });

    expect(result).toEqual({ jobId: 'new-job-123', deduped: false });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/jobs/create',
      expect.objectContaining({
        owner: 'testowner',
        repo: 'testrepo',
        branch: 'main',
        edition: '',
        userId: 'user-1',
      }),
      expect.anything()
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
