import { beforeEach, describe, expect, it, vi } from 'vitest';

const repoFindUniqueMock = vi.fn();
const userFindUniqueMock = vi.fn();
const importRecordFindManyMock = vi.fn();
const importRecordFindFirstMock = vi.fn();
const callSidecarMock = vi.fn();
const revalidateTagMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findUnique: (...args: unknown[]) => repoFindUniqueMock(...args),
      findFirst: (...args: unknown[]) => repoFindUniqueMock(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => userFindUniqueMock(...args),
    },
    importRecord: {
      findMany: (...args: unknown[]) => importRecordFindManyMock(...args),
      findFirst: (...args: unknown[]) => importRecordFindFirstMock(...args),
    },
  },
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('next/cache', () => ({
  revalidateTag: (...args: unknown[]) => revalidateTagMock(...args),
}));

describe('publishRepository withdraw 提审撤回机制', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindUniqueMock.mockResolvedValue({ role: 'USER' });
    importRecordFindFirstMock.mockResolvedValue({
      userId: 'user-maintainer',
      createdAt: new Date(),
    });
  });

  it('非维护者且非管理员尝试撤回：抛出 403 Forbidden', async () => {
    const { publishRepository } = await import('@/lib/review/publish-repository');
    repoFindUniqueMock.mockResolvedValue({
      id: 'repo-1',
      reviewStatus: 'PENDING',
      isPublic: false,
    });

    await expect(
      publishRepository('user-stranger', { repoId: 'repo-1', withdraw: true })
    ).rejects.toThrow('权限不足');
  });

  it('非 PENDING 状态尝试撤回：抛出 400 BadRequest', async () => {
    const { publishRepository } = await import('@/lib/review/publish-repository');
    repoFindUniqueMock.mockResolvedValue({
      id: 'repo-1',
      reviewStatus: 'NONE',
      isPublic: false,
    });

    await expect(
      publishRepository('user-maintainer', { repoId: 'repo-1', withdraw: true })
    ).rejects.toThrow('当前教程不处于审核中状态');
  });

  it('维护者成功撤回提审：调用 sidecar 恢复为 NONE 并清空驳回理由', async () => {
    const { publishRepository } = await import('@/lib/review/publish-repository');
    repoFindUniqueMock.mockResolvedValue({
      id: 'repo-1',
      owner: 'org',
      repo: 'my-repo',
      reviewStatus: 'PENDING',
      isPublic: false,
    });
    callSidecarMock.mockResolvedValue({ success: true });

    const result = await publishRepository('user-maintainer', {
      repoId: 'repo-1',
      withdraw: true,
    });

    expect(result.withdrawn).toBe(true);
    expect(result.reviewStatus).toBe('NONE');
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/repos/patch',
      {
        id: 'repo-1',
        reviewStatus: 'NONE',
        clearRejectionReason: true,
      },
      expect.anything()
    );
    expect(revalidateTagMock).toHaveBeenCalled();
  });
});
