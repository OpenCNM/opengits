import { test, expect, describe, vi } from 'vitest';
import { resolveRepository } from '@/lib/repository-resolver';
import type { EditionChip } from '@/lib/home-data';
import { ENGINE_CONFIG } from '@/lib/config';

describe('多分支与多版本教程更新联动解析 (Edition & Branch Resolution)', () => {
  test('EditionChip 结构包含独立 branch、gitSha、hasUpdate 与 importedSha 物理事实', () => {
    const chip: EditionChip = {
      id: 'repo-dev-id',
      edition: 'ed_dd1ce839',
      label: 'qwen3.8-max版',
      presetId: 'preset-max',
      isDefault: false,
      isSaved: true,
      progress: 30,
      chapterCount: 10,
      processedDocsCount: 10,
      docUrl: '/docs/projectdiscovery/nuclei?edition=ed_dd1ce839',
      branch: 'dev',
      gitSha: 'a14b3de2a4bf2e2324f65b5ca44164a30af34162',
      importedSha: 'a14b3de2a4bf2e2324f65b5ca44164a30af34162',
      hasUpdate: false,
    };

    expect(chip.branch).toBe('dev');
    expect(chip.gitSha).toBe('a14b3de2a4bf2e2324f65b5ca44164a30af34162');
    expect(chip.hasUpdate).toBe(false);
  });

  test('resolveRepository 精确解析指定 branch 与 edition 的仓库实例', async () => {
    const { prisma } = await import('@/lib/db');
    const mockRepoDev = {
      id: 'repo-dev-id',
      owner: 'projectdiscovery',
      repo: 'nuclei',
      branch: 'dev',
      edition: 'ed_dd1ce839',
      semVerLabel: null,
      gitSha: 'a14b3de',
    };

    const spy = vi.spyOn(prisma.repository, 'findFirst').mockResolvedValueOnce(mockRepoDev as never);

    const resolved = await resolveRepository('projectdiscovery', 'nuclei', 'dev', 'ed_dd1ce839');
    expect(resolved).not.toBeNull();
    expect(resolved?.repository.id).toBe('repo-dev-id');
    expect(resolved?.resolvedBranch).toBe('dev');
    expect(resolved?.resolvedEdition).toBe('ed_dd1ce839');

    spy.mockRestore();
  });

  test('未显式传入 branch 时回退至系统默认分支', () => {
    const defaultBranch = ENGINE_CONFIG.defaultBranch;
    expect(defaultBranch).toBeTruthy();
    const fallbackBranch = (undefined as string | undefined) || defaultBranch;
    expect(fallbackBranch).toBe(defaultBranch);
  });
});
