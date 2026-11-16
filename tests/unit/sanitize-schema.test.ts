import { test, expect } from 'vitest';
import { mdxSanitizeSchema } from '@/lib/mdx/sanitize-schema';
import { defaultSchema } from 'hast-util-sanitize';

test('补充标签合并进白名单（figure/details/iframe 等），不替换默认', () => {
  for (const tag of ['figure', 'figcaption', 'details', 'summary', 'kbd', 'mark', 'iframe']) {
    expect(mdxSanitizeSchema.tagNames).toContain(tag);
  }
  // 回归锚：初版曾整体替换数组——默认标签（table/img/code）必须保留
  for (const tag of ['table', 'thead', 'tbody', 'tr', 'td', 'img', 'code', 'pre', 'blockquote']) {
    expect(mdxSanitizeSchema.tagNames).toContain(tag);
  }
  expect((mdxSanitizeSchema.tagNames ?? []).length).toBeGreaterThan((defaultSchema.tagNames ?? []).length);
});

test('通配属性：className/id/data*/aria*/role 合并且保留默认 href 等', () => {
  const wildcard = (mdxSanitizeSchema.attributes as Record<string, any>)['*'] ?? [];
  const serialized = JSON.stringify(wildcard);
  expect(serialized).toContain('className');
  expect(serialized).toContain('"data*"'); // hast-util-sanitize 的前缀条目约定
  expect(serialized).toContain('role');
  // 默认 a[href] 不被顶掉
  const aAttrs = (mdxSanitizeSchema.attributes as Record<string, any>)['a'] ?? [];
  expect(JSON.stringify(aAttrs)).toContain('href');
  expect(JSON.stringify(aAttrs)).toContain('target');
});

test('src 协议：默认 http/https 之外追加 data（Mermaid/内联图依赖）', () => {
  const src = (mdxSanitizeSchema.protocols as Record<string, any>)?.src ?? [];
  expect(src).toContain('http');
  expect(src).toContain('https');
  expect(src).toContain('data');
});

test('特定标签属性：input[disabled]（GFM 任务列表）、code[language]', () => {
  expect(JSON.stringify((mdxSanitizeSchema.attributes as Record<string, any>)['input'])).toContain('disabled');
  expect(JSON.stringify((mdxSanitizeSchema.attributes as Record<string, any>)['code'])).toContain('language');
});
