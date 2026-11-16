import { test, expect, describe, vi, beforeEach } from 'vitest';
import { findVisibleDoc } from '@/lib/docs-fetch';
import { prisma } from '@/lib/db';

vi.mock('@/lib/db', () => ({
  prisma: {
    document: {
      findFirst: vi.fn(),
    },
  },
}));

describe('findVisibleDoc 私有优先两步查找（真冻结读取语义）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('登录用户：私有行命中则不再查共享行', async () => {
    (prisma.document.findFirst as any).mockResolvedValueOnce({
      id: 'private-doc',
      ownerUserId: 'u1',
      path: 'docs/a.md',
    });

    const doc = await findVisibleDoc({ id: 'repo-1' }, ['docs/a.md', 'docs/a'], 'u1');

    expect(doc?.id).toBe('private-doc');
    expect(prisma.document.findFirst).toHaveBeenCalledTimes(1);
    expect((prisma.document.findFirst as any).mock.calls[0][0].where).toMatchObject({
      ownerUserId: 'u1',
    });
  });

  test('登录用户：私有未命中回落共享行（path 候选以 OR 展开）', async () => {
    (prisma.document.findFirst as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'shared-doc', ownerUserId: null, path: 'docs/a.md' });

    const doc = await findVisibleDoc({ id: 'repo-1' }, ['docs/a.md', 'docs/a'], 'u1');

    expect(doc?.id).toBe('shared-doc');
    expect(prisma.document.findFirst).toHaveBeenCalledTimes(2);
    const secondWhere = (prisma.document.findFirst as any).mock.calls[1][0].where;
    expect(secondWhere).toMatchObject({ ownerUserId: null });
    expect(secondWhere.OR).toEqual([{ path: 'docs/a.md' }, { path: 'docs/a' }]);
  });

  test('游客：仅查共享行', async () => {
    (prisma.document.findFirst as any).mockResolvedValueOnce({
      id: 'shared-doc',
      ownerUserId: null,
    });

    const doc = await findVisibleDoc({ id: 'repo-1' }, ['docs/a.md'], undefined);

    expect(doc?.id).toBe('shared-doc');
    expect(prisma.document.findFirst).toHaveBeenCalledTimes(1);
    expect((prisma.document.findFirst as any).mock.calls[0][0].where).toMatchObject({
      ownerUserId: null,
    });
  });

  test('空 path 候选直接返回 null（不发查询）', async () => {
    expect(await findVisibleDoc({ id: 'repo-1' }, [''], 'u1')).toBeNull();
    expect(prisma.document.findFirst).not.toHaveBeenCalled();
  });
});
