import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  job: vi.fn(), repo: vi.fn(), clear: vi.fn(), grant: vi.fn(), publish: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: {
  importJob: { findUnique: mocks.job }, repository: { findUnique: mocks.repo }, $executeRaw: mocks.clear,
} }));
vi.mock('@/lib/credits/import-reward', () => ({ grantImportReward: mocks.grant }));
vi.mock('@/lib/review/publish-repository', () => ({ publishRepository: mocks.publish }));
import { completeImportRewardCallback } from '@/lib/jobs/import-job-reward';
const repository = { id: 'r', owner: 'o', repo: 'r', branch: 'main', edition: '', isPublic: false, reviewStatus: 'NONE' };
const job = { id: 'j', userId: 'u', status: 'COMPLETED', owner: 'o', repo: 'r', branch: 'main', edition: '', result: { repositoryId: 'r' }, params: { kind: 'web-doc', publishRequested: true } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.job.mockResolvedValue(job);
  mocks.repo.mockResolvedValue(repository);
  mocks.grant.mockResolvedValue(0);
  mocks.publish.mockResolvedValue({ submitted: true, reviewStatus: 'PENDING' });
});
describe('durable import reward callback', () => {
  it('completed public web intent goes through publication safety gate', async () => {
    await completeImportRewardCallback('j');
    expect(mocks.publish).toHaveBeenCalledWith('u', { repoId: 'r' });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalledOnce();
  });
  it('failed publication leaves durable pending flag for retry', async () => {
    mocks.publish.mockRejectedValueOnce(new Error('offline'));
    await expect(completeImportRewardCallback('j')).rejects.toThrow('offline');
    expect(mocks.clear).not.toHaveBeenCalled();
  });
  it.each(['FAILED', 'RUNNING'])('non-completed job %s cannot publish or earn', async (status) => {
    mocks.job.mockResolvedValue({ ...job, status });
    await completeImportRewardCallback('j');
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it.each(['PENDING', 'REJECTED'])('callback cannot override safety state %s', async (reviewStatus) => {
    mocks.repo.mockResolvedValue({ ...repository, reviewStatus });
    await completeImportRewardCallback('j');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('approved retry uses idempotent grant without rerunning review', async () => {
    mocks.repo.mockResolvedValue({ ...repository, isPublic: true, reviewStatus: 'APPROVED' });
    await completeImportRewardCallback('j');
    expect(mocks.grant).toHaveBeenCalledWith('r');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('GitHub intent alone does not publish', async () => {
    mocks.job.mockResolvedValue({ ...job, params: { publishRequested: true } });
    await completeImportRewardCallback('j');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('private web import does not publish', async () => {
    mocks.job.mockResolvedValue({ ...job, params: { kind: 'web-doc', publishRequested: false } });
    await completeImportRewardCallback('j');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
