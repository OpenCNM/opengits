import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * DELETE /api/repos 全局删除授权判定矩阵（审计矩阵 BUG-GEN-01 + 红队 GAP-1 回归锁）。
 *
 * 语义矩阵：
 * - 管理员/ENTERPRISE：全量放行
 * - 公开仓：非特权一律拒绝（社区资产，防单人删除）
 * - 私有仓属主（持有 ownerUserId 归属文档）：可删自己的仓
 * - 私有仓非属主：拒绝
 */

const userFindUniqueMock = vi.hoisted(() => vi.fn());
const documentFindFirstMock = vi.hoisted(() => vi.fn());
const importRecordFindFirstMock = vi.hoisted(() => vi.fn());
const savedRepoFindFirstMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock },
    document: { findFirst: documentFindFirstMock },
    importRecord: { findFirst: importRecordFindFirstMock },
    savedRepo: { findFirst: savedRepoFindFirstMock },
  },
}));

import {
  canGloballyDeleteRepo,
  userOwnsPrivateDocs,
} from '@/lib/repo-delete-auth';

describe('canGloballyDeleteRepo（全局删除授权矩阵）', () => {
  const base = {
    actor: { role: 'USER', tier: 'FREE' } as { role: string; tier: string } | null,
    isPrivileged: false,
    repoIsPublic: false,
    ownsPrivateDocs: true,
    globalDelete: false,
  };

  it('私有仓属主：可删除自己的仓', () => {
    expect(canGloballyDeleteRepo({ ...base })).toBe(true);
  });

  it('私有仓非属主：拒绝（封堵原越权删除漏洞）', () => {
    expect(canGloballyDeleteRepo({ ...base, ownsPrivateDocs: false })).toBe(false);
  });

  it('公开仓：即使主张属主身份也拒绝（社区资产保护）', () => {
    expect(canGloballyDeleteRepo({ ...base, repoIsPublic: true })).toBe(false);
    expect(
      canGloballyDeleteRepo({ ...base, repoIsPublic: true, globalDelete: true })
    ).toBe(false);
  });

  it('管理员/ENTERPRISE：全量放行（含公开仓与 global 删除）', () => {
    expect(
      canGloballyDeleteRepo({ ...base, repoIsPublic: true, globalDelete: true, isPrivileged: true })
    ).toBe(true);
    expect(canGloballyDeleteRepo({ ...base, ownsPrivateDocs: false, isPrivileged: true })).toBe(true);
  });

  it('无 actor（未登录态防御）+ 私有仓：拒绝', () => {
    expect(
      canGloballyDeleteRepo({ ...base, actor: null, isPrivileged: false, ownsPrivateDocs: true })
    ).toBe(false);
  });
});

describe('userOwnsPrivateDocs（私有文档归属证据查询）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('存在 ownerUserId 归属文档 → true', async () => {
    documentFindFirstMock.mockResolvedValueOnce({ id: 'doc-1' });
    const { prisma } = await import('@/lib/db');
    void prisma;
    const owned = await userOwnsPrivateDocs('repo-1', 'user-1');
    expect(owned).toBe(true);
    expect(documentFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { repositoryId: 'repo-1', ownerUserId: 'user-1' },
      })
    );
  });

  it('无归属文档 → false', async () => {
    documentFindFirstMock.mockResolvedValueOnce(null);
    importRecordFindFirstMock.mockResolvedValueOnce(null);
    savedRepoFindFirstMock.mockResolvedValueOnce(null);
    expect(await userOwnsPrivateDocs('repo-1', 'user-1')).toBe(false);
  });
});
