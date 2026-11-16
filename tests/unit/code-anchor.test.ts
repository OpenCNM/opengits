import { describe, it, expect } from 'vitest';
import {
  parseLineAnchor,
  formatLineAnchor,
  isLineInRange,
  parseCodeAnchor,
  formatCodeAnchor,
} from '@/lib/code-viewport/line-anchor';

describe('code-viewport/line-anchor', () => {
  describe('parseLineAnchor & formatLineAnchor (向后兼容)', () => {
    it('解析单行锚点 #L15', () => {
      const res = parseLineAnchor('#L15');
      expect(res).toEqual({ startLine: 15, endLine: 15 });
    });

    it('解析区间锚点 #L15-L25 与 #L15-25', () => {
      expect(parseLineAnchor('#L15-L25')).toEqual({ startLine: 15, endLine: 25 });
      expect(parseLineAnchor('#L15-25')).toEqual({ startLine: 15, endLine: 25 });
    });

    it('自动归一化倒序行号 #L25-L15', () => {
      expect(parseLineAnchor('#L25-L15')).toEqual({ startLine: 15, endLine: 25 });
    });

    it('非代码行号 hash 安全返回 null', () => {
      expect(parseLineAnchor('#heading-1')).toBeNull();
      expect(parseLineAnchor('')).toBeNull();
      expect(parseLineAnchor(null)).toBeNull();
    });

    it('格式化单行与区间', () => {
      expect(formatLineAnchor(15)).toBe('#L15');
      expect(formatLineAnchor(15, 25)).toBe('#L15-L25');
      expect(formatLineAnchor(15, 15)).toBe('#L15');
      expect(formatLineAnchor(25, 15)).toBe('#L15-L25');
    });

    it('判定行号命中区间', () => {
      const range = { startLine: 10, endLine: 20 };
      expect(isLineInRange(9, range)).toBe(false);
      expect(isLineInRange(10, range)).toBe(true);
      expect(isLineInRange(15, range)).toBe(true);
      expect(isLineInRange(20, range)).toBe(true);
      expect(isLineInRange(21, range)).toBe(false);
    });
  });

  describe('parseCodeAnchor & formatCodeAnchor (跨文件深链接)', () => {
    it('解析跨文件代码区间锚点 #code:src/lib/auth.ts:L20-L45', () => {
      const res = parseCodeAnchor('#code:src/lib/auth.ts:L20-L45');
      expect(res).toEqual({
        filePath: 'src/lib/auth.ts',
        range: { startLine: 20, endLine: 45 },
      });
    });

    it('解析跨文件单行锚点 #code:src/lib/auth.ts:L20', () => {
      const res = parseCodeAnchor('#code:src/lib/auth.ts:L20');
      expect(res).toEqual({
        filePath: 'src/lib/auth.ts',
        range: { startLine: 20, endLine: 20 },
      });
    });

    it('解析省略前缀的跨文件锚点 #code:src/lib/auth.ts:20-45', () => {
      const res = parseCodeAnchor('#code:src/lib/auth.ts:20-45');
      expect(res).toEqual({
        filePath: 'src/lib/auth.ts',
        range: { startLine: 20, endLine: 45 },
      });
    });

    it('解析仅含文件路径的锚点 #code:packages/core/src/index.ts', () => {
      const res = parseCodeAnchor('#code:packages/core/src/index.ts');
      expect(res).toEqual({
        filePath: 'packages/core/src/index.ts',
        range: { startLine: 1, endLine: 1 },
      });
    });

    it('自动清洗前导 ./ 或 /', () => {
      const res = parseCodeAnchor('#code:./src/utils/math.ts:L5-L10');
      expect(res?.filePath).toBe('src/utils/math.ts');
    });

    it('自动回退同文件普通行号 #L12-L18', () => {
      const res = parseCodeAnchor('#L12-L18');
      expect(res).toEqual({
        range: { startLine: 12, endLine: 18 },
      });
    });

    it('格式化跨文件正典深链接', () => {
      expect(
        formatCodeAnchor({
          filePath: 'src/lib/auth.ts',
          startLine: 20,
          endLine: 45,
        })
      ).toBe('#code:src/lib/auth.ts:L20-L45');

      expect(
        formatCodeAnchor({
          filePath: 'src/lib/auth.ts',
          startLine: 20,
        })
      ).toBe('#code:src/lib/auth.ts:L20');
    });

    it('格式化无文件时的同页行号', () => {
      expect(
        formatCodeAnchor({
          startLine: 15,
          endLine: 30,
        })
      ).toBe('#L15-L30');
    });
  });

  describe('useCodeDrawerStore 抽屉状态机', () => {
    it('openDrawer 与 closeDrawer 正确切换状态', async () => {
      const { useCodeDrawerStore } = await import('@/lib/stores/code-drawer-store');
      const store = useCodeDrawerStore.getState();

      store.openDrawer({
        owner: 'facebook',
        repo: 'react',
        filePath: 'packages/react/src/index.js',
        startLine: 10,
        endLine: 25,
      });

      expect(useCodeDrawerStore.getState().isOpen).toBe(true);
      expect(useCodeDrawerStore.getState().target?.filePath).toBe('packages/react/src/index.js');
      expect(useCodeDrawerStore.getState().target?.startLine).toBe(10);

      store.closeDrawer();
      expect(useCodeDrawerStore.getState().isOpen).toBe(false);
      expect(useCodeDrawerStore.getState().target).toBeNull();
    });

    it('syncFromHash 响应跨文件深链接 Hash', async () => {
      const { useCodeDrawerStore } = await import('@/lib/stores/code-drawer-store');
      const store = useCodeDrawerStore.getState();

      const synced = store.syncFromHash('#code:src/lib/auth.ts:L15-L30', {
        owner: 'my-org',
        repo: 'my-repo',
      });

      expect(synced).toBe(true);
      expect(useCodeDrawerStore.getState().isOpen).toBe(true);
      expect(useCodeDrawerStore.getState().target?.owner).toBe('my-org');
      expect(useCodeDrawerStore.getState().target?.filePath).toBe('src/lib/auth.ts');
      expect(useCodeDrawerStore.getState().target?.startLine).toBe(15);
      expect(useCodeDrawerStore.getState().target?.endLine).toBe(30);

      store.closeDrawer();
    });

    it('syncFromHash 在抽屉打开且 Hash 变为非代码锚点时自动联动关闭', async () => {
      const { useCodeDrawerStore } = await import('@/lib/stores/code-drawer-store');
      const store = useCodeDrawerStore.getState();

      store.openDrawer({
        owner: 'my-org',
        repo: 'my-repo',
        filePath: 'src/lib/auth.ts',
        startLine: 15,
        endLine: 30,
      });
      expect(useCodeDrawerStore.getState().isOpen).toBe(true);

      // 用户点击浏览器后退，Hash 变为页面普通锚点或空
      const synced = store.syncFromHash('#heading-summary', {
        owner: 'my-org',
        repo: 'my-repo',
      });

      expect(synced).toBe(false);
      expect(useCodeDrawerStore.getState().isOpen).toBe(false);
      expect(useCodeDrawerStore.getState().target).toBeNull();
    });
  });
});

