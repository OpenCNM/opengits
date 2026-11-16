import { describe, it, expect } from 'vitest';
import { remarkSafeBraces } from '@/lib/mdx/ast-sanitizer-plugins';

describe('remarkSafeBraces expression handling (Item 6)', () => {
  it('converts member expressions, call expressions, and conditional expressions to text nodes', () => {
    const expressions = ['user.name', 'foo()', 'a ? b : c', 'this'];
    const plugin: any = remarkSafeBraces;

    for (const expr of expressions) {
      const node: any = { type: 'mdxTextExpression', value: expr };
      const tree: any = { type: 'root', children: [{ type: 'paragraph', children: [node] }] };
      plugin()(tree);
      expect(node.type).toBe('text');
      expect(node.value).toBe(`{${expr}}`);
    }
  });

  it('still converts single valid identifier to DynamicVar element', () => {
    const node: any = { type: 'mdxTextExpression', value: 'API_KEY' };
    const tree: any = { type: 'root', children: [{ type: 'paragraph', children: [node] }] };
    const plugin: any = remarkSafeBraces;
    plugin()(tree);
    expect(node.type).toBe('mdxJsxTextElement');
    expect(node.name).toBe('DynamicVar');
    expect(node.attributes[0].value).toBe('API_KEY');
  });

  it('strips MDX comments instead of converting them to visible prose text', () => {
    const commentNode: any = { type: 'mdxTextExpression', value: '/* internal note */' };
    const textNode: any = { type: 'text', value: 'Hello world' };
    const tree: any = { type: 'root', children: [{ type: 'paragraph', children: [commentNode, textNode] }] };
    const plugin: any = remarkSafeBraces;
    plugin()(tree);
    expect(tree.children[0].children).toHaveLength(1);
    expect(tree.children[0].children[0].value).toBe('Hello world');
  });
});
