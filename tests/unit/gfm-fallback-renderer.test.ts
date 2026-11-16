import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import GfmFallbackRenderer from '@/components/mdx/GfmFallbackRenderer';

describe('GfmFallbackRenderer (Fail-Closed styling & code block isolation)', () => {
  it('pre 容器包含硬性样式覆盖 [&_code]:!bg-transparent [&_code]:!border-none [&_code]:!p-0 [&_code]:!text-stone-100', () => {
    const markdown = '```bash\npip install torchtune\n```';
    const html = renderToString(React.createElement(GfmFallbackRenderer, { content: markdown }));

    expect(html).toContain('[&amp;_code]:!bg-transparent');
    expect(html).toContain('[&amp;_code]:!border-none');
    expect(html).toContain('[&amp;_code]:!p-0');
    expect(html).toContain('[&amp;_code]:!text-stone-100');
  });

  it('行内代码渲染带有行内徽章样式 bg-theme-bg', () => {
    const markdown = 'Run `pip install` to start.';
    const html = renderToString(React.createElement(GfmFallbackRenderer, { content: markdown }));

    expect(html).toContain('bg-theme-bg');
    expect(html).toContain('border-theme-border');
    expect(html).toContain('text-theme-primary');
    expect(html).toContain('pip install');
  });

  it('无语言标识的代码块(含换行)不会被误判为行内代码,不会附加 bg-theme-bg', () => {
    const markdown = '```\necho "no language specified"\necho "second line"\n```';
    const html = renderToString(React.createElement(GfmFallbackRenderer, { content: markdown }));

    const codeTagMatch = html.match(/<code\b[^>]*class="([^"]*)"/);
    expect(codeTagMatch).not.toBeNull();
    const classList = codeTagMatch![1];
    expect(classList).not.toContain('bg-theme-bg');
    expect(classList).toContain('text-stone-100');
  });

  it('缩进代码块(4空格缩进)正确识别为块级代码,不泄露行内徽章样式', () => {
    const markdown = 'Here is code:\n\n    def test():\n        return True\n';
    const html = renderToString(React.createElement(GfmFallbackRenderer, { content: markdown }));

    const codeTagMatch = html.match(/<pre[^>]*><code\b[^>]*class="([^"]*)"/);
    expect(codeTagMatch).not.toBeNull();
    const classList = codeTagMatch![1];
    expect(classList).not.toContain('bg-theme-bg');
    expect(classList).toContain('text-stone-100');
  });

  it('单行无语言标识代码块与单行缩进代码块均通过 PreContext 准确识别为块级代码', () => {
    const fencedSingleLine = '```\necho single\n```';
    const fencedHtml = renderToString(React.createElement(GfmFallbackRenderer, { content: fencedSingleLine }));
    const fencedMatch = fencedHtml.match(/<pre[^>]*><code\b[^>]*class="([^"]*)"/);
    expect(fencedMatch).not.toBeNull();
    expect(fencedMatch![1]).not.toContain('bg-theme-bg');
    expect(fencedMatch![1]).toContain('text-stone-100');

    const indentedSingleLine = '    echo indented';
    const indentedHtml = renderToString(React.createElement(GfmFallbackRenderer, { content: indentedSingleLine }));
    const indentedMatch = indentedHtml.match(/<pre[^>]*><code\b[^>]*class="([^"]*)"/);
    expect(indentedMatch).not.toBeNull();
    expect(indentedMatch![1]).not.toContain('bg-theme-bg');
    expect(indentedMatch![1]).toContain('text-stone-100');
  });

  it('段落内换行的多行行内代码不会被误判为块级代码,保持行内徽章样式', () => {
    const multilineInline = 'Inline `code\nwith newline` inside paragraph.';
    const html = renderToString(React.createElement(GfmFallbackRenderer, { content: multilineInline }));
    expect(html).toContain('bg-theme-bg');
    expect(html).toContain('border-theme-border');
    expect(html).toContain('text-theme-primary');
    expect(html).not.toContain('<pre');
  });

  it('正确清理 <name> 与 <repo-url> 等非标准伪 HTML 标签，杜绝 React 未识别标签异常并保留语义', () => {
    const rawContent = `
# Tutorial Chapter

Here is an example: \`func(<name>)\`

And a raw placeholder: <name>

And a hyphenated CLI placeholder: git clone <repo-url>

And paired pseudo tags: <name>John Doe</name>

And invalid attributes: <name attr="val" style="color:red">Sample</name>
`;

    const html = renderToString(
      React.createElement(GfmFallbackRenderer, {
        content: rawContent,
        owner: 'test-owner',
        repo: 'test-repo',
      })
    );

    // 杜绝渲染出原始非法 DOM 标签 <name> 或 <repo-url>
    expect(html).not.toContain('<name>');
    expect(html).not.toContain('</name>');
    expect(html).not.toContain('<name ');
    expect(html).not.toContain('<repo-url>');
    expect(html).not.toContain('</repo-url>');
    // 但正文内容与占位符必须得到安全保留，且回填符号语义
    expect(html).toContain('John Doe');
    expect(html).toContain('Sample');
    expect(html).toMatch(/(?:&lt;|&#x3C;)repo-url(?:&gt;|>)/);
    expect(html).toMatch(/(?:&lt;|&#x3C;)name(?:&gt;|>)/);
  });

  it('保留合法 HTML 文档标签（summary, table, b 等）', () => {
    const rawContent = `
<details>
  <summary>Click to expand</summary>
  <p>Hidden body</p>
</details>
`;

    const html = renderToString(
      React.createElement(GfmFallbackRenderer, {
        content: rawContent,
        owner: 'test-owner',
        repo: 'test-repo',
      })
    );

    expect(html).toContain('Click to expand');
    expect(html).toContain('Hidden body');
  });
});
