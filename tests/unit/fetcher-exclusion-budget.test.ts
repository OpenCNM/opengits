import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Fetcher } from '@/engine/fetcher';
import { ENGINE_CONFIG } from '@/lib/config';
import { deriveScopedExclusionReport } from '@/components/ImportWizard/hooks/useScoutVersionSelection';

/**
 * 排除明细认知预算（Cognitive Budget）：
 * 计数器（totalExcludedCount / byCategory）全量精确；明细数组按
 * exclusionDetailBudget 封顶——百万文件级大仓的 excluded 明细无界 push
 * 会在 V8 堆堆积数百 MB。下游（deriveScopedExclusionReport）无前缀时
 * 必须采信计数器，不得从抽样明细重算。
 */

function zipNode(i: number) {
  return {
    path: `packages/lib${Math.floor(i / 50)}/asset-${i}.zip`,
    mode: '100644',
    type: 'blob' as const,
    sha: `b${i}`,
    size: 1024,
    url: '',
  };
}

function mdNode(path: string) {
  return {
    path,
    mode: '100644',
    type: 'blob' as const,
    sha: 'm1',
    size: 100,
    url: '',
  };
}

describe('Fetcher exclusion detail budget (fetcher.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps counters exact while detail list is hard-capped at the budget', async () => {
    const budget = ENGINE_CONFIG.fetcher.exclusionDetailBudget;
    const total = budget + 50; // 明确越过封顶线
    const tree = Array.from({ length: total }, (_, i) => zipNode(i));
    tree.push(mdNode('README.md'));

    const fetcher = new Fetcher('owner', 'mega-repo', 'main');
    vi.spyOn(fetcher as any, 'gh').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tree, truncated: false }),
    });

    const result = await fetcher.getRepoTree(1);
    const report = result.exclusionReport!;

    expect(report.totalExcludedCount).toBe(total);
    expect(report.byCategory.archive).toBe(total);
    expect(report.allExcludedFiles!.length).toBe(budget);
    expect(report.sampleExcludedFiles.length).toBe(15);
    // 非排除文件不受预算影响，仍在过滤结果中
    expect(result.some((n: any) => n.path === 'README.md')).toBe(true);
  });

  it('below the budget the detail list stays complete', async () => {
    const tree = Array.from({ length: 3 }, (_, i) => zipNode(i));
    const fetcher = new Fetcher('owner', 'small-repo', 'main');
    vi.spyOn(fetcher as any, 'gh').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tree, truncated: false }),
    });

    const report = (await fetcher.getRepoTree(1)).exclusionReport!;
    expect(report.totalExcludedCount).toBe(3);
    expect(report.allExcludedFiles!.length).toBe(3);
  });
});

describe('deriveScopedExclusionReport consumer contract', () => {
  it('no prefix: trusts exact report counters instead of recomputing from detail', () => {
    // Go 主路径形态：计数器精确 + 明细为空数组（truthy！旧的 `|| 短路会采到空表）
    const goPathReport = {
      totalExcludedCount: 9000,
      byCategory: { archive: 8000, oversized: 1000 },
      sampleExcludedFiles: [{ path: 'a.zip', category: 'archive' }],
      allExcludedFiles: [],
    };
    const derived = deriveScopedExclusionReport(goPathReport, '')!;
    expect(derived.totalExcludedCount).toBe(9000);
    expect(derived.byCategory).toEqual({ archive: 8000, oversized: 1000 });
    expect(derived.sampleExcludedFiles.length).toBe(1);
  });

  it('no prefix + capped Node detail: counters stay exact, detail passthrough', () => {
    const nodePathReport = {
      totalExcludedCount: 9000,
      byCategory: { archive: 9000 },
      sampleExcludedFiles: [],
      allExcludedFiles: Array.from({ length: 200 }, (_, i) => ({
        path: `f-${i}.zip`,
        category: 'archive',
      })),
    };
    const derived = deriveScopedExclusionReport(nodePathReport, '')!;
    expect(derived.totalExcludedCount).toBe(9000);
    expect(derived.allExcludedFiles.length).toBe(200);
  });

  it('prefix scope: recomputes scoped counts from available detail (display-grade)', () => {
    const report = {
      totalExcludedCount: 10,
      byCategory: { archive: 10 },
      sampleExcludedFiles: [],
      allExcludedFiles: [
        { path: 'apps/web/vendor-1.zip', category: 'archive' },
        { path: 'apps/web/vendor-2.zip', category: 'archive' },
        { path: 'apps/api/vendor-3.zip', category: 'archive' },
      ],
    };
    const derived = deriveScopedExclusionReport(report, 'apps/web')!;
    expect(derived.totalExcludedCount).toBe(2);
    expect(derived.byCategory.archive).toBe(2);
  });

  it('missing report yields null', () => {
    expect(deriveScopedExclusionReport(undefined, '')).toBeNull();
    expect(deriveScopedExclusionReport(null, 'x')).toBeNull();
  });
});
