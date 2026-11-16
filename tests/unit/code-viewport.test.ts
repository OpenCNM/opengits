import { describe, expect, it } from 'vitest';
import {
  parseLineAnchor,
  formatLineAnchor,
  isLineInRange,
  isCodeAnchorFileMatch,
} from '@/lib/code-viewport/line-anchor';

describe('Zero-Materialization Code Viewport (Line Anchor Projection)', () => {
  describe('parseLineAnchor', () => {
    it('parses single line anchors correctly with or without hash prefix', () => {
      expect(parseLineAnchor('#L15')).toEqual({ startLine: 15, endLine: 15 });
      expect(parseLineAnchor('L15')).toEqual({ startLine: 15, endLine: 15 });
      expect(parseLineAnchor('#l42')).toEqual({ startLine: 42, endLine: 42 });
    });

    it('parses multi-line range anchors with standard syntax #L10-L20', () => {
      expect(parseLineAnchor('#L10-L20')).toEqual({ startLine: 10, endLine: 20 });
      expect(parseLineAnchor('L5-L15')).toEqual({ startLine: 5, endLine: 15 });
    });

    it('parses abbreviated multi-line range anchors like #L10-20', () => {
      expect(parseLineAnchor('#L10-20')).toEqual({ startLine: 10, endLine: 20 });
    });

    it('automatically normalizes inverted ranges to prevent out-of-order bounds', () => {
      expect(parseLineAnchor('#L25-L10')).toEqual({ startLine: 10, endLine: 25 });
      expect(parseLineAnchor('#L50-20')).toEqual({ startLine: 20, endLine: 50 });
    });

    it('safely returns null for non-line hashes, headings, and malformed anchors', () => {
      expect(parseLineAnchor(null)).toBeNull();
      expect(parseLineAnchor(undefined)).toBeNull();
      expect(parseLineAnchor('')).toBeNull();
      expect(parseLineAnchor('#heading-summary')).toBeNull();
      expect(parseLineAnchor('#overview')).toBeNull();
      expect(parseLineAnchor('#L0')).toBeNull();
      expect(parseLineAnchor('#L-5')).toBeNull();
      expect(parseLineAnchor('#Labc')).toBeNull();
    });
  });

  describe('formatLineAnchor', () => {
    it('formats a single line number as #L{n}', () => {
      expect(formatLineAnchor(15)).toBe('#L15');
      expect(formatLineAnchor(1)).toBe('#L1');
    });

    it('formats a line range as #L{min}-L{max}', () => {
      expect(formatLineAnchor(10, 20)).toBe('#L10-L20');
      expect(formatLineAnchor(25, 15)).toBe('#L15-L25');
    });

    it('simplifies identical start and end lines to a single #L{n}', () => {
      expect(formatLineAnchor(15, 15)).toBe('#L15');
    });

    it('returns empty string for invalid or zero line numbers', () => {
      expect(formatLineAnchor(0)).toBe('');
      expect(formatLineAnchor(-10)).toBe('');
    });
  });

  describe('isLineInRange', () => {
    const range = { startLine: 10, endLine: 20 };

    it('returns true for lines strictly inside the closed interval [start, end]', () => {
      expect(isLineInRange(10, range)).toBe(true);
      expect(isLineInRange(15, range)).toBe(true);
      expect(isLineInRange(20, range)).toBe(true);
    });

    it('returns false for lines outside the interval', () => {
      expect(isLineInRange(9, range)).toBe(false);
      expect(isLineInRange(21, range)).toBe(false);
      expect(isLineInRange(1, range)).toBe(false);
      expect(isLineInRange(100, range)).toBe(false);
    });

    it('returns false when range is null or line number is non-positive', () => {
      expect(isLineInRange(15, null)).toBe(false);
      expect(isLineInRange(0, range)).toBe(false);
      expect(isLineInRange(-5, range)).toBe(false);
    });
  });

  describe('isCodeAnchorFileMatch (幽灵高亮防御)', () => {
    it('目标未指定文件路径时，允许任何代码块或匿名代码块匹配', () => {
      expect(isCodeAnchorFileMatch(undefined, undefined)).toBe(true);
      expect(isCodeAnchorFileMatch(null, 'src/auth.ts')).toBe(true);
      expect(isCodeAnchorFileMatch('', 'src/auth.ts')).toBe(true);
    });

    it('目标指定文件路径时，匿名代码块坚决返回 false 拒绝幽灵高亮', () => {
      expect(isCodeAnchorFileMatch('src/auth.ts', undefined)).toBe(false);
      expect(isCodeAnchorFileMatch('src/auth.ts', null)).toBe(false);
      expect(isCodeAnchorFileMatch('src/auth.ts', '')).toBe(false);
    });

    it('目标指定文件路径时，准确匹配相对路径与归一化路径', () => {
      expect(isCodeAnchorFileMatch('src/auth.ts', 'src/auth.ts')).toBe(true);
      expect(isCodeAnchorFileMatch('src/auth.ts', './src/auth.ts')).toBe(true);
      expect(isCodeAnchorFileMatch('auth.ts', 'src/auth.ts')).toBe(true);
      expect(isCodeAnchorFileMatch('src/auth.ts', 'auth.ts')).toBe(true);
    });

    it('目标指定文件路径时，不同文件坚决返回 false', () => {
      expect(isCodeAnchorFileMatch('src/auth.ts', 'src/user.ts')).toBe(false);
      expect(isCodeAnchorFileMatch('src/server.ts', 'src/client.ts')).toBe(false);
    });
  });
});
