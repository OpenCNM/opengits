import { describe, expect, it } from 'vitest';
import { toHtml } from 'hast-util-to-html';
import { h } from 'hastscript';
import {
  rehypeParagraphContentModel,
  HTML_BLOCK_TAGS,
} from '@/lib/mdx/rehype-paragraph-content-model';
import { mdxCompiler } from '@/lib/mdx/compile-cache';

describe('rehypeParagraphContentModel (HTML5 内容模型 AST 规范化与解包)', () => {
  function processHast(node: any) {
    const tree = { type: 'root', children: Array.isArray(node) ? node : [node] };
    const plugin = rehypeParagraphContentModel();
    plugin(tree as any);
    return toHtml(tree as any);
  }

  it('🧪 [Case 1] 单子段落居中解包：解除内层多余 <p>，100% 保留外层 <p align="center"> 语义与属性', () => {
    // 模拟外层 <p align="center"><p>The open source coding agent...</p></p>
    const innerP = h('p', ['The open source coding agent in your IDE, terminal, & desktop.']);
    const outerP = h('p', { align: 'center' }, [innerP]);

    const html = processHast(outerP);

    // 杜绝非法 <p> 嵌套 <p>
    expect(html).not.toMatch(/<p[^>]*>\s*<p/);
    // 严格保留外层 <p align="center"> 语义与原生段落
    expect(html).toContain('<p align="center">The open source coding agent in your IDE, terminal, &#x26; desktop.</p>');
  });

  it('🧪 [Case 2] 内联富文本解包：保留内层 <a>, <img>, <strong>, <code> 等行内流内容完整性', () => {
    const innerP = h('p', [
      'Welcome to ',
      h('strong', ['Cline']),
      ': see ',
      h('a', { href: 'https://docs.cline.bot' }, ['Docs']),
      ' or use ',
      h('code', ['npm install']),
    ]);
    const outerP = h('p', { className: 'hero-lead' }, [innerP]);

    const html = processHast(outerP);

    expect(html).not.toMatch(/<p[^>]*>\s*<p/);
    expect(html).toContain('<p class="hero-lead">Welcome to <strong>Cline</strong>: see <a href="https://docs.cline.bot">Docs</a> or use <code>npm install</code></p>');
  });

  it('🧪 [Case 3] 多段落容器保护：包含多个独立段落时外层规范化为 <div>，杜绝段落文本生硬粘连', () => {
    const p1 = h('p', ['段落一内容']);
    const p2 = h('p', ['段落二内容']);
    const outerP = h('p', { align: 'center' }, [p1, p2]);

    const html = processHast(outerP);

    // 外层转为具有相同属性的 div 容器
    expect(html).toContain('<div align="center">');
    // 两个子段落保持独立，保留垂直段落排版间距
    expect(html).toContain('<p>段落一内容</p>');
    expect(html).toContain('<p>段落二内容</p>');
    expect(html).toContain('</div>');
  });

  it('🧪 [Case 4] 块级元素保护：内含 <h1>, <table> 等块级标签时外层规范化为 <div>，杜绝水合冲突', () => {
    const heading = h('h1', { align: 'center' }, ['Turbopack']);
    const outerP = h('p', { align: 'center' }, [heading]);

    const html = processHast(outerP);

    expect(html).toContain('<div align="center">');
    expect(html).toContain('<h1 align="center">Turbopack</h1>');
    expect(html).not.toMatch(/<p[^>]*>\s*<h1/);
  });

  it('🧪 [Case 5] MDX JSX Flow/Text 节点支持：兼容 mdxJsxFlowElement 的 name="p" 节点', () => {
    const mdxTree: any = {
      type: 'root',
      children: [
        {
          type: 'mdxJsxFlowElement',
          name: 'p',
          attributes: [{ type: 'mdxJsxAttribute', name: 'align', value: 'center' }],
          children: [
            {
              type: 'element',
              tagName: 'p',
              properties: {},
              children: [{ type: 'text', value: 'JSX 段落文本' }],
            },
          ],
        },
      ],
    };

    const plugin = rehypeParagraphContentModel();
    plugin(mdxTree);

    // 外层 JSX 保持 p，内层被解包提升
    expect(mdxTree.children[0].name).toBe('p');
    expect(mdxTree.children[0].children[0].type).toBe('text');
    expect(mdxTree.children[0].children[0].value).toBe('JSX 段落文本');
  });

  it('🧪 [Case 6] 常规普通 Markdown 正文段落完全不受影响', () => {
    const normalP = h('p', ['这是普通正文段落，不含子段落或块级元素。']);
    const html = processHast(normalP);

    expect(html).toBe('<p>这是普通正文段落，不含子段落或块级元素。</p>');
  });

  it('🧪 [Case 7 · 端到端真实编译] 编译 cline/cline README 真实场景，确保生成的 JSX 干净且零嵌套 <p>', async () => {
    const source = `<p align="center">
The open source coding agent in your IDE, terminal, & desktop.
</p>`;

    const res = await mdxCompiler.compile({ source, filePath: 'test-readme.mdx' });

    // 编译产物应当直接是 _jsx("p", { align: "center", children: "..." })
    expect(res.compiled).toContain('_jsx("p"');
    expect(res.compiled).toContain('align: "center"');
    expect(res.compiled).toContain('The open source coding agent in your IDE, terminal, & desktop.');
    // 杜绝产生内部 _components.p 嵌套
    expect(res.compiled).not.toContain('_jsx(_components.p');
  });

  it('🧪 [Case 8 · 端到端真实编译] 编译多段落与带 H1 容器场景，验证 div 降级保真性', async () => {
    const multiParaSource = `<p align="center">
段落1

段落2
</p>`;

    const multiRes = await mdxCompiler.compile({ source: multiParaSource, filePath: 'test-multi.mdx' });
    expect(multiRes.compiled).toContain('_jsxs("div"');
    expect(multiRes.compiled).toContain('align: "center"');

    const h1Source = `<p align="center">
<h1 align="center">Title</h1>
</p>`;

    const h1Res = await mdxCompiler.compile({ source: h1Source, filePath: 'test-h1.mdx' });
    expect(h1Res.compiled).toContain('_jsx("div"');
    expect(h1Res.compiled).toContain('_jsx("h1"');
  });

  it('🧪 [Case 9 · 表格内容模型] 修复 tbody > td 缺失 tr：自动补齐 tr 包裹，彻底解决 <td> cannot be a child of <tbody>', async () => {
    const rawTable = `<table>
<tbody>
<td align="center"><a href="https://cline.bot">Docs</a></td>
<td align="center"><a href="https://discord.gg">Discord</a></td>
</tbody>
</table>`;

    const res = await mdxCompiler.compile({ source: rawTable, filePath: 'test-tbody.mdx' });
    // 必须通过 tr 包装为直接子节点
    expect(res.compiled).toContain('_components.tr');
    // tbody 的直接子节点是 _components.tr，而非 td
    expect(res.compiled).toMatch(/_jsx\("tbody",\s*\{\s*children:\s*_jsxs?\(_components\.tr/);
  });

  it('🧪 [Case 10 · 表格内容模型] 修复 table > tr 缺失 tbody：自动补齐 tbody 包裹，彻底解决 <tr> cannot be a child of <table>', async () => {
    const rawTable = `<table>
<tr>
<td>CLI Tool</td>
</tr>
</table>`;

    const res = await mdxCompiler.compile({ source: rawTable, filePath: 'test-table-tr.mdx' });
    // table 的直接子节点必须是 _components.tbody，而非 tr
    expect(res.compiled).toContain('_components.tbody');
    expect(res.compiled).toMatch(/_jsx\("table",\s*\{\s*children:\s*_jsx\(_components\.tbody/);
  });

  it('🧪 [Case 11 · 图片内容模型] 修复 Raw HTML <img ...> 绕过 components.img 问题：自动规范化为 HAST element', async () => {
    const rawImg = `<p align="center">
  <img src="assets/icons/icon.png" width="80" alt="Cline" />
</p>`;

    const res = await mdxCompiler.compile({ source: rawImg, filePath: 'test-img.mdx' });
    // 必须编译为 _components.img，确保平台相对路径解析与 WhiteboardImage 能够拦截
    expect(res.compiled).toContain('_components.img');
    expect(res.compiled).toContain('src: "assets/icons/icon.png"');
    expect(res.compiled).toContain('width: "80"');
    expect(res.compiled).toContain('alt: "Cline"');
    // 杜绝产生原始原生 JSX _jsx("img"
    expect(res.compiled).not.toMatch(/_jsx\("img",/);
  });

  it('🧪 [Case 12 · 代码块末尾空行修复] 单行代码块杜绝多余末尾换行符，确保只有 1 行代码', async () => {
    const rawCode = '```bash\ncline config\n```';
    const res = await mdxCompiler.compile({ source: rawCode, filePath: 'test-code.mdx' });

    // data-code 与 children 中绝不能带末尾 \n
    expect(res.compiled).toContain('"data-code": "cline config"');
    expect(res.compiled).not.toContain('"data-code": "cline config\\n"');
    expect(res.compiled).toContain('children: "cline config"');
    expect(res.compiled).not.toContain('children: "cline config\\n"');

    // 生成的 HTML 高亮中只允许有 1 个 line 且没有 L2
    expect(res.compiled).toContain('id=\\"L1\\"');
    expect(res.compiled).not.toContain('id=\\"L2\\"');
  });
});
