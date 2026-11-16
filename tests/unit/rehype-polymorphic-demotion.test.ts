import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import { toHtml } from 'hast-util-to-html';
import { h } from 'hastscript';
import {
  rehypePolymorphicDemotion,
  FORBIDDEN_DEMOTION_TAGS,
} from '@/lib/mdx/rehype-polymorphic-demotion';

describe('rehypePolymorphicDemotion (First-Principles Resilience)', () => {
  function processHast(node: any, options?: any) {
    const tree = { type: 'root', children: Array.isArray(node) ? node : [node] };
    const plugin = rehypePolymorphicDemotion(options);
    plugin(tree as any);
    return toHtml(tree as any);
  }

  it('单标签/空伪标签 <name>, <type>, <T>, <target_dir> 自动转为 span.syntax-placeholder-token 且符号文本完备', () => {
    // 模拟 HAST 中解析出的空/自闭合非法标签
    const nameNode = h('name', {});
    const typeNode = h('type', {});
    const tNode = h('T', {});
    const targetDirNode = h('target_dir', {});

    const html = processHast([nameNode, typeNode, tNode, targetDirNode]);

    // 杜绝非法 DOM 标签残留在产物中
    expect(html).not.toContain('<name>');
    expect(html).not.toContain('<type>');
    expect(html).not.toContain('<T>');
    expect(html).not.toContain('<target_dir>');

    // 转换为标准 span 并带有 semantic 占位令牌类与属性
    expect(html).toContain('<span data-syntax-role="placeholder-token"');
    expect(html).toContain('syntax-placeholder-token');
    expect(html).toContain('font-mono');

    // 严格保留技术符号语义（避免空元素），HTML 序列化还原
    expect(html).toMatch(/(?:&lt;|&#x3C;)name(?:&gt;|>)/);
    expect(html).toMatch(/(?:&lt;|&#x3C;)type(?:&gt;|>)/);
    expect(html).toMatch(/(?:&lt;|&#x3C;)t(?:&gt;|>)/);
    expect(html).toMatch(/(?:&lt;|&#x3C;)target_dir(?:&gt;|>)/);

    // 显式测试大写泛型 <T> 保留大小写
    const directGenericNode = { type: 'element', tagName: 'T', properties: {}, children: [] };
    const genericHtml = processHast(directGenericNode);
    expect(genericHtml).toMatch(/(?:&lt;|&#x3C;)T(?:&gt;|>)/);
  });

  it('带内容的未知标签 <custom>inner text</custom> 降级为 span 并严格保留其子节点内容', () => {
    const customNode = h('custom', ['inner text']);
    const html = processHast(customNode);

    expect(html).not.toContain('<custom>');
    expect(html).not.toContain('</custom>');
    expect(html).toContain('<span data-syntax-role="placeholder-token"');
    expect(html).toContain('inner text');
  });

  it('高危渗透标签（script, iframe, style, object, embed 等）被严密封闭与剥除', () => {
    const scriptNode = h('script', ['alert("XSS")']);
    const iframeNode = h('iframe', { src: 'https://malicious.com' });
    const styleNode = h('style', ['body { display: none; }']);
    const objectNode = h('object', { data: 'exploit.swf' });

    const html = processHast([scriptNode, iframeNode, styleNode, objectNode]);

    expect(html).not.toContain('script');
    expect(html).not.toContain('iframe');
    expect(html).not.toContain('style');
    expect(html).not.toContain('object');
    expect(html).not.toContain('alert("XSS")');
    expect(html).not.toContain('exploit.swf');
    expect(html).not.toContain('syntax-placeholder-token'); // 绝不能降级保留为文本令牌
  });

  it('合法标准 HTML/SVG 元素（div, span, code, table, p, h1 等）不受影响并原样保留', () => {
    const divNode = h('div', { id: 'container' }, [
      h('p', ['Paragraph text']),
      h('code', ['const x = 1;']),
      h('table', [h('tbody', [h('tr', [h('td', ['cell'])])])]),
    ]);

    const html = processHast(divNode);

    expect(html).toContain('<div id="container">');
    expect(html).toContain('<p>Paragraph text</p>');
    expect(html).toContain('<code>const x = 1;</code>');
    expect(html).toContain('<table><tbody><tr><td>cell</td></tr></tbody></table>');
    expect(html).not.toContain('syntax-placeholder-token');
    expect(html).not.toContain('data-syntax-role="placeholder-token"');
  });

  it('带连字符的 Custom Elements（如 web-component）符合标准定义并保留原样', () => {
    const customElem = h('my-web-component', { 'data-mode': 'test' }, ['Component child']);
    const html = processHast(customElem);

    expect(html).toContain('<my-web-component');
    expect(html).toContain('Component child');
    expect(html).not.toContain('syntax-placeholder-token');
  });

  it('空或自闭合的连字符伪标签（如 <repo-url>, <target-dir>）作为命令行占位符多态降级并回填文本', () => {
    const repoUrlNode = h('repo-url', {});
    const targetDirNode = h('target-dir', {});
    const html = processHast([repoUrlNode, targetDirNode]);

    expect(html).not.toContain('<repo-url>');
    expect(html).not.toContain('<target-dir>');
    expect(html).toContain('data-syntax-role="placeholder-token"');
    expect(html).toMatch(/(?:&lt;|&#x3C;)repo-url(?:&gt;|>)/);
    expect(html).toMatch(/(?:&lt;|&#x3C;)target-dir(?:&gt;|>)/);
  });

  it('属性安全净化：过滤字符串 style、onclick 事件与非法属性，保留安全属性（id, title, role, data-*, aria-*）', () => {
    const unsafeNode = h('token', {
      id: 'token-1',
      title: 'Token Hint',
      role: 'term',
      'data-testid': 'token-test',
      'aria-label': 'token label',
      style: 'color: red',
      onclick: 'alert(1)',
      invalidProp: 'bad-value',
      className: ['custom-token'],
    });

    const html = processHast(unsafeNode);

    // 保留安全属性
    expect(html).toContain('id="token-1"');
    expect(html).toContain('title="Token Hint"');
    expect(html).toContain('role="term"');
    expect(html).toContain('data-testid="token-test"');
    expect(html).toContain('aria-label="token label"');
    expect(html).toContain('custom-token');
    expect(html).toContain('syntax-placeholder-token');

    // 严密封闭与剔除危险/非标准属性
    expect(html).not.toContain('color: red');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('invalidProp');
    expect(html).not.toContain('bad-value');
  });

  it('仅包含 HTML 注释的伪标签视为无意义内容，回填符号文本', () => {
    const commentOnlyNode = {
      type: 'element',
      tagName: 'unknown_param',
      properties: {},
      children: [{ type: 'comment', value: 'some comment' }],
    };
    const html = processHast(commentOnlyNode);

    expect(html).toContain('data-syntax-role="placeholder-token"');
    expect(html).toMatch(/(?:&lt;|&#x3C;)unknown_param(?:&gt;|>)/);
  });

  it('XML 命名空间标签（如 <custom:element>）安全降级', () => {
    const nsNode = h('custom:element', ['payload']);
    const html = processHast(nsNode);

    expect(html).not.toContain('<custom:element>');
    expect(html).toContain('data-syntax-role="placeholder-token"');
    expect(html).toContain('payload');
  });
});
