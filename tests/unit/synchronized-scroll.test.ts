import { describe, it, expect } from 'vitest';

describe('M03 [3.5] Side-by-Side Review & Synchronized Scroll Math', () => {
  it('3.5.1.1 滚动比例换算与除零保护', () => {
    const calculateSyncScrollTop = (
      srcScrollTop: number,
      srcScrollHeight: number,
      srcClientHeight: number,
      tgtScrollHeight: number,
      tgtClientHeight: number
    ) => {
      const maxSrc = srcScrollHeight - srcClientHeight;
      const maxTgt = tgtScrollHeight - tgtClientHeight;
      if (maxSrc <= 0 || maxTgt <= 0) return 0;
      const ratio = srcScrollTop / maxSrc;
      return ratio * maxTgt;
    };

    expect(calculateSyncScrollTop(50, 200, 100, 300, 100)).toBe(100);
    expect(calculateSyncScrollTop(10, 100, 100, 200, 100)).toBe(0);
    expect(calculateSyncScrollTop(0, 200, 100, 200, 100)).toBe(0);
  });
});
