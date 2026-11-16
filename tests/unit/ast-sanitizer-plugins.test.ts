import { test, expect } from 'vitest';
import { remarkStripEsm, remarkTagNormalizer, remarkSafeBraces, rehypeStripStyle } from '@/lib/mdx/ast-sanitizer-plugins';
import { unified } from 'unified';
import { toHtml } from 'hast-util-to-html';
import { h } from 'hastscript';

// remark 系列是 CJS/ESM 双格式包，vitest 解析形态不稳定：
// 命名空间导入后同时兼容 default（CJS 互操作）与具名导出（ESM 构建）
import * as remarkParseNs from 'remark-parse';
import * as remarkStringifyNs from 'remark-stringify';
import * as remarkMdxNs from 'remark-mdx';

function resolvePlugin(ns: any, named: string): any {
  return ns?.[named] ?? ns?.default ?? ns;
}
const remarkParse = resolvePlugin(remarkParseNs, 'remarkParse');
const remarkStringify = resolvePlugin(remarkStringifyNs, 'remarkStringify');
const remarkMdx = resolvePlugin(remarkMdxNs, 'remarkMdx');

/** 用真实 unified 管线驱动插件（remark-mdx 解析 MDX 扩展节点） */
async function runRemark(source: string, plugins: Array<() => any>): Promise<string> {
  const processor = unified();
  processor.use(remarkParse);
  processor.use(remarkMdx);
  for (const p of plugins) processor.use(p as any);
  processor.use(remarkStringify);
  const file = await processor.process(source);
  return String(file);
}

test('remarkStripEsm：import 剥离、export 保留', async () => {
  const out = await runRemark(`import Foo from 'bar';\n\nexport const meta = { title: 'x' };\n\n# 正文\n`, [remarkStripEsm as any]);
  expect(out).not.toContain('import Foo');
  expect(out).toContain('export const meta');
});

test('remarkTagNormalizer：kebab/lowercase 别名 → PascalCase 组件', async () => {
  const out = await runRemark(`<card-group>\n<card>内容</card>\n</card-group>\n`, [remarkTagNormalizer as any]);
  expect(out).toContain('<CardGroup>');
  expect(out).toContain('<Card>');
});

test('remarkSafeBraces：单标识符 → DynamicVar', async () => {
  const out = await runRemark(`变量 {now} 与 {API_URL} 并存\n`, [remarkSafeBraces as any]);
  expect(out).toContain('DynamicVar');
});

test('remarkSafeBraces：多词纯文本表达式 → 原文转文本节点（直接驱动 AST）', () => {
  // 注：{Context Engineering} 不是合法 JS，remark-mdx 解析期即被 acorn 拒绝；
  // 该形态节点来自 LLM 改写等旁路，此处手工构造 AST 驱动插件
  const node: any = { type: 'mdxTextExpression', value: 'Context Engineering' };
  const tree: any = { type: 'root', children: [{ type: 'paragraph', children: [node] }] };
  const plugin: any = remarkSafeBraces;
  plugin()(tree);
  expect(node.type).toBe('text');
  expect(node.value).toBe('{Context Engineering}');
});

test('remarkSafeBraces：JS 保留字不转 DynamicVar', async () => {
  const out = await runRemark(`{this}\n`, [remarkSafeBraces as any]);
  expect(out).not.toContain('DynamicVar');
});

test('rehypeStripStyle：style 属性删除，其他属性保留', () => {
  const tree = h('div', { style: 'color:red', className: ['keep'] }, [h('span', 'text')]);
  const plugin: any = rehypeStripStyle;
  plugin()(tree);
  const html = toHtml(tree as any);
  expect(html).not.toContain('style');
  expect(html).toContain('keep');
});
