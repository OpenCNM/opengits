import { test, expect } from 'vitest';
import {
  buildSectionAddress,
  parseSectionAddress,
  buildCleanSectionAddress,
} from '@/lib/mcp/section-address';

test('build/parse round-trip：含 headingPath 与裸路径', () => {
  const address = buildSectionAddress('docs/getting-started.md', 'core > overview');
  expect(address).toBe('docs/getting-started.md#core > overview');
  const parsed = parseSectionAddress(address);
  expect(parsed.docPath).toBe('docs/getting-started.md');
  expect(parsed.headingPath).toBe('core > overview');
  const bare = parseSectionAddress('docs/a.md');
  expect(bare.headingPath).toBe('');
});

test('buildCleanSectionAddress：剥离 headingPath 自带的 docPath# 前缀（双#回归锚）', () => {
  // markdown chunk 落库的 headingPath 带 "docs/foo.md#标题" 前缀（chunker 兜底合成）
  expect(buildCleanSectionAddress('docs/foo.md', 'docs/foo.md#上下文设计')).toBe('docs/foo.md#上下文设计');
  // 代码课程 chunk 的 headingPath 无前缀 → 原样拼接
  expect(buildCleanSectionAddress('code/intro.ts', 'cluster > overview')).toBe('code/intro.ts#cluster > overview');
  // 空 headingPath → 裸 path#（read_section 兜底读整篇）
  expect(buildCleanSectionAddress('docs/a.md', '  ')).toBe('docs/a.md#');
});
