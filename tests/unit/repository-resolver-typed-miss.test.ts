import { test, expect, describe, vi, afterEach } from 'vitest';
import { resolveRepository } from '@/lib/repository-resolver';
import { prisma } from '@/lib/db';

/**
 * 类型化讲法未命中（editionMiss）契约：
 * 纯推导标记——级联走到回退点即证明该 edition 无任何行。
 * 变更类端点据此 fail-closed；展示类端点 redirect/横幅各自取舍。
 */
describe('resolveRepository 类型化 edition miss', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    spies.length = 0;
  });

  function mockFindFirst(
    dispatch: (where: Record<string, unknown>) => Record<string, unknown> | null
  ) {
    const impl = async (args: unknown) => {
      const where = ((args as { where?: Record<string, unknown> })?.where ?? {}) as Record<string, unknown>;
      return dispatch(where);
    };
    const spy = vi.spyOn(prisma.repository, 'findFirst').mockImplementation(impl as never);
    spies.push(spy);
  }

  const baseRow = {
    id: 'repo-base-id',
    owner: 'facebook',
    repo: 'react',
    branch: 'main',
    edition: '',
    semVerLabel: null,
  };
  const liveRow = { ...baseRow, id: 'repo-live-id', edition: 'ed_live' };

  test('显式 edition 存在 → 精确命中行且无 editionMiss', async () => {
    mockFindFirst((w) => (w.edition === 'ed_live' ? liveRow : null));

    const resolved = await resolveRepository('facebook', 'react', undefined, 'ed_live');
    expect(resolved).not.toBeNull();
    expect(resolved?.repository.id).toBe('repo-live-id');
    expect(resolved?.resolvedEdition).toBe('ed_live');
    expect(resolved?.isFallback).toBe(false);
    expect(resolved?.editionMiss).toBeUndefined();
  });

  test('显式 edition 不存在（无版本路径）→ 基础行 + isFallback + editionMiss', async () => {
    mockFindFirst((w) => (w.edition === '' ? baseRow : null));

    const resolved = await resolveRepository('facebook', 'react', undefined, 'ed_ghost');
    expect(resolved).not.toBeNull();
    expect(resolved?.repository.id).toBe('repo-base-id');
    expect(resolved?.resolvedEdition).toBe('');
    expect(resolved?.isFallback).toBe(true);
    expect(resolved?.editionMiss).toEqual({ requested: 'ed_ghost' });
  });

  test('显式 edition + 版本路径 miss → 归一化 isFallback 必为 true 且携带 editionMiss', async () => {
    // 版本维度全部 miss；递归回退后基础行经 Step 4 命中（其本征 isFallback 已为 true，
    // 外层再归一化——契约上两处都不得出现 isFallback:false）
    mockFindFirst((w) =>
      w.edition === '' && (w.branch === undefined || w.branch != null) ? baseRow : null
    );

    const resolved = await resolveRepository('facebook', 'react', 'v9.9', 'ed_ghost');
    expect(resolved).not.toBeNull();
    expect(resolved?.repository.id).toBe('repo-base-id');
    expect(resolved?.isFallback).toBe(true);
    expect(resolved?.editionMiss).toEqual({ requested: 'ed_ghost' });
  });

  test('未显式传 edition → 永无 editionMiss（Step 8 行为不变）', async () => {
    mockFindFirst(() => baseRow);

    const resolved = await resolveRepository('facebook', 'react', undefined, '');
    expect(resolved).not.toBeNull();
    expect(resolved?.repository.id).toBe('repo-base-id');
    expect(resolved?.editionMiss).toBeUndefined();
    expect(resolved?.isFallback).toBe(false);
  });
});
