import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 认知脚手架 grounding 的 sha 键不可变缓存：
 * 同 (owner/repo, sha, concept) 只打一次 sidecar；不同 sha 各自打；失败不缓存。
 */
const callSidecarMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sidecar-client', () => ({ callSidecar: callSidecarMock }));

import {
  executeSidecarConceptGrounding,
  clearConceptGroundingCacheForTest,
} from '@/engine/symbols-driver';

const okResponse = (path: string) => ({
  ok: true,
  backboneFiles: [{ path, role: 'core_contract', pageRank: 0.9 }],
  goldenSymbols: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  clearConceptGroundingCacheForTest();
});

describe('executeSidecarConceptGrounding sha 键不可变缓存', () => {
  it('同参数二次调用命中缓存——sidecar 只打一次', async () => {
    callSidecarMock.mockResolvedValue(okResponse('core/engine.ts'));

    const a = await executeSidecarConceptGrounding({ owner: 'o', repo: 'r', sha: 'sha-1', conceptName: 'engine' });
    const b = await executeSidecarConceptGrounding({ owner: 'o', repo: 'r', sha: 'sha-1', conceptName: 'engine' });

    expect(callSidecarMock).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(b.backboneFiles[0].path).toBe('core/engine.ts');
  });

  it('不同 sha / 不同 concept 各自穿透（key 完整性）', async () => {
    callSidecarMock.mockResolvedValue(okResponse('x.ts'));

    await executeSidecarConceptGrounding({ owner: 'o', repo: 'r', sha: 'sha-1', conceptName: 'engine' });
    await executeSidecarConceptGrounding({ owner: 'o', repo: 'r', sha: 'sha-2', conceptName: 'engine' });
    await executeSidecarConceptGrounding({ owner: 'o', repo: 'r', sha: 'sha-1', conceptName: 'parser' });

    expect(callSidecarMock).toHaveBeenCalledTimes(3);
  });

  it('scopeFiles 参与键：不同 scope 不互吞', async () => {
    callSidecarMock.mockResolvedValue(okResponse('x.ts'));

    await executeSidecarConceptGrounding({ owner: 'o', repo: 'r', sha: 'sha-1', conceptName: 'engine', scopeFiles: ['a.ts'] });
    await executeSidecarConceptGrounding({ owner: 'o', repo: 'r', sha: 'sha-1', conceptName: 'engine', scopeFiles: ['b.ts'] });

    expect(callSidecarMock).toHaveBeenCalledTimes(2);
  });

  it('失败（ok:false）不缓存——下一次调用重试 sidecar', async () => {
    callSidecarMock
      .mockResolvedValueOnce({ ok: false, error: 'timeout' })
      .mockResolvedValueOnce(okResponse('ok.ts'));

    await expect(
      executeSidecarConceptGrounding({ owner: 'o', repo: 'r', sha: 'sha-1', conceptName: 'engine' })
    ).rejects.toThrow();

    const result = await executeSidecarConceptGrounding({ owner: 'o', repo: 'r', sha: 'sha-1', conceptName: 'engine' });
    expect(result.backboneFiles[0].path).toBe('ok.ts');
    expect(callSidecarMock).toHaveBeenCalledTimes(2);
  });

  it('scopeFiles 顺序无关：不同顺序的相同 scopeFiles 集合命中同一缓存条目', async () => {
    callSidecarMock.mockResolvedValue(okResponse('shared.ts'));

    const a = await executeSidecarConceptGrounding({
      owner: 'o', repo: 'r', sha: 'sha-1', conceptName: 'engine', scopeFiles: ['b.ts', 'a.ts']
    });
    const b = await executeSidecarConceptGrounding({
      owner: 'o', repo: 'r', sha: 'sha-1', conceptName: 'engine', scopeFiles: ['a.ts', 'b.ts']
    });
    const c = await executeSidecarConceptGrounding({
      owner: 'o', repo: 'r', sha: 'sha-1', conceptName: 'engine', scopeFiles: ['a.ts', 'b.ts', 'a.ts']
    });

    expect(callSidecarMock).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});
