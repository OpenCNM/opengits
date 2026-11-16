import { test, expect, describe, vi } from 'vitest';
import { codeChapterPath, clusterChapterNo, isCodeChapterPath, buildUpdateCandidateSet } from '@/engine/update-candidate-set';

/**
 * update-candidate-set（2026-09-11 收刀版）：本地确定性规则层已物理删除
 * （全量下沉 Go /v1/update/candidate-set，冻结夹具 update-candidate.golden.json
 * 锁定规则语义）——本文件仅回归存续的命名规约纯函数与 Fail-Closed 透传。
 */

describe('update-candidate-set（命名规约 + Fail-Closed 透传）', () => {
  test('codeChapterPath 与 isCodeChapterPath 命名规范', () => {
    expect(codeChapterPath(3)).toBe('chapters/03.mdx');
    expect(isCodeChapterPath('chapters/03.mdx')).toBe(true);
    expect(isCodeChapterPath('docs/intro.md')).toBe(false);
    expect(clusterChapterNo({ teachingOrder: 5 })).toBe(5);
    expect(clusterChapterNo({ chapterNo: 7, teachingOrder: 1 })).toBe(7);
  });

  test('buildUpdateCandidateSet 透传 Go 裁决（Fail-Closed 单实现）', async () => {
    const { executeSidecarCandidateSet } = await import('@/engine/update-candidate-driver');
    const canned = {
      chapters: [{ path: 'chapters/01.mdx', action: 'update' as const, affectedFiles: [] }],
      unmatchedFiles: [],
      structuralAdds: [],
      structuralRemoves: [],
      diffStats: { added: 0, modified: 1, removed: 0 },
    };
    const spy = vi.spyOn(await import('@/engine/update-candidate-driver'), 'executeSidecarCandidateSet')
      .mockResolvedValueOnce(canned as never);
    vi.mocked(executeSidecarCandidateSet);
    const got = await buildUpdateCandidateSet({
      owner: 'o', repo: 'r', branch: 'main',
      fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40),
      repositoryId: 'rid',
    });
    expect(got).toEqual(canned);
    spy.mockRestore();
  });

  test('sidecar 离线时显式抛错（无本地回退）', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    delete process.env.WORKER_SIDECAR_URL;
    await expect(
      buildUpdateCandidateSet({
        owner: 'o', repo: 'r', branch: 'main',
        fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40),
        repositoryId: 'rid',
      })
    ).rejects.toThrow(/sidecar unreachable|not configured/);
  });
});
