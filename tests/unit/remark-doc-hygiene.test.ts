import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import {
  remarkGfmAlerts,
  remarkGfmAlertsPlain,
  remarkStripLeadingTitle,
  normalizeTitleForMatch,
} from '@/lib/mdx/remark-doc-hygiene';

/** 解析 markdown → 应用插件 → 返回 mdast（不序列化，纯 AST 断言） */
function transform(md: string, plugin: () => (tree: any) => void) {
  const tree = unified().use(remarkParse).parse(md);
  plugin()(tree);
  return tree;
}

function attr(node: any, name: string): string | undefined {
  return node.attributes?.find((a: any) => a.name === name)?.value;
}

describe('remarkGfmAlerts（GFM alert → Callout JSX 节点）', () => {
  it('五类 alert 全量映射：NOTE/TIP/IMPORTANT/WARNING/CAUTION', () => {
    const cases: Array<[string, string]> = [
      ['NOTE', 'note'],
      ['TIP', 'tip'],
      ['IMPORTANT', 'important'],
      ['WARNING', 'warning'],
      ['CAUTION', 'danger'],
    ];
    for (const [marker, wantType] of cases) {
      const tree = transform(`> [!${marker}] Title\n> body`, remarkGfmAlerts);
      const node = tree.children[0];
      expect(node.type, marker).toBe('mdxJsxFlowElement');
      expect(node.name, marker).toBe('Callout');
      expect(attr(node, 'type'), marker).toBe(wantType);
      expect(attr(node, 'title'), marker).toBe('Title');
    }
  });

  it('标记行大小写不敏感 + 标记行后续文本并入正文首段', () => {
    const tree = transform('> [!note] T\n> first\n> second', remarkGfmAlerts);
    const node = tree.children[0];
    expect(attr(node, 'type')).toBe('note');
    // 标记行紧跟的换行归一为空格；段内软换行（\n）按 mdast 语义保留
    const para = node.children.find((c: any) => c.type === 'paragraph');
    expect(para.children[0].value).toBe(' first\nsecond');
  });

  it('成对引号标题剥壳 + 孤立尾引号清理（“[!X] …”形态）', () => {
    const wrapped = transform('> [!IMPORTANT] “Design Decision”', remarkGfmAlerts);
    expect(attr(wrapped.children[0], 'title')).toBe('Design Decision');

    // 引号开在标记之前（截图实证形态）：> “[!IMPORTANT] …适配层”
    const leading = transform('> “[!IMPORTANT] Design Decision: 输入适配层”', remarkGfmAlerts);
    const node = leading.children[0];
    expect(node.type).toBe('mdxJsxFlowElement');
    expect(attr(node, 'type')).toBe('important');
    expect(attr(node, 'title')).toBe('Design Decision: 输入适配层');
  });

  it('仅标记无标题：不产出 title 属性，正文完整保留', () => {
    const tree = transform('> [!WARNING]\n> body only', remarkGfmAlerts);
    const node = tree.children[0];
    expect(attr(node, 'type')).toBe('warning');
    expect(attr(node, 'title')).toBeUndefined();
    expect(node.children.some((c: any) => c.type === 'paragraph')).toBe(true);
  });

  it('多段正文：Callout children 保留全部段落', () => {
    const tree = transform('> [!NOTE] T\n> p1\n>\n> p2', remarkGfmAlerts);
    const paras = tree.children[0].children.filter((c: any) => c.type === 'paragraph');
    expect(paras).toHaveLength(2);
  });

  it('普通 blockquote 与未知标记不动 + 代码围栏内标记免疫', () => {
    const normal = transform('> just a quote', remarkGfmAlerts);
    expect(normal.children[0].type).toBe('blockquote');

    const unknown = transform('> [!CUSTOM] x', remarkGfmAlerts);
    expect(unknown.children[0].type).toBe('blockquote');

    const fenced = transform('```\n[!NOTE] inside code\n```', remarkGfmAlerts);
    expect(fenced.children[0].type).toBe('code');
  });
});

describe('remarkGfmAlertsPlain（react-markdown 降级路径变体）', () => {
  it('剥标记 + 标题升格 strong + className 注入', () => {
    const tree = transform('> [!IMPORTANT] 设计决策\n> 正文', remarkGfmAlertsPlain);
    const node = tree.children[0];
    expect(node.type).toBe('blockquote');
    expect(node.data.hProperties.className).toEqual(['gfm-alert', 'gfm-alert-important']);
    const para = node.children[0];
    expect(para.children[0].type).toBe('strong');
    expect(para.children[0].children[0].value).toBe('设计决策');
  });
});

describe('remarkStripLeadingTitle（正文首 H1 剔除）', () => {
  it('首节点为 H1 时剔除，其余 H1 保留', () => {
    const tree = transform('# Chapter Title\n\n## A\n\n# Later', remarkStripLeadingTitle);
    expect(tree.children.map((c: any) => c.depth)).toEqual([2, 1]);
  });

  it('首个内容节点非 H1（H2 开头/围栏开头）时不做任何剔除', () => {
    const h2first = transform('## Start\n\n# Deep', remarkStripLeadingTitle);
    expect(h2first.children).toHaveLength(2);

    const fenceFirst = transform('```\ncode\n```\n\n# Title', remarkStripLeadingTitle);
    expect(fenceFirst.children).toHaveLength(2);
    expect(fenceFirst.children[1].type).toBe('heading');
  });
});

describe('normalizeTitleForMatch（标题归一化比对）', () => {
  it('引号/强调残迹剥除 + 空白全删（CJK 排版空格免疫）+ casefold', () => {
    expect(normalizeTitleForMatch('第 2 章: 数据预处理')).toBe(normalizeTitleForMatch('第2章:数据预处理'));
    expect(normalizeTitleForMatch('# **Hello** World')).toBe('helloworld');
    expect(normalizeTitleForMatch('“引用标题”')).toBe('引用标题');
    expect(normalizeTitleForMatch(null)).toBe('');
    expect(normalizeTitleForMatch('')).toBe('');
  });
});
