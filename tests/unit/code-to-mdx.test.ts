import { describe, it, expect } from 'vitest';
import { wrapCodeAsMdx } from '@/engine/code-to-mdx';

describe('wrapCodeAsMdx dynamic fence length', () => {
  it('uses standard 3 backticks for ordinary code files', () => {
    const code = 'const a = 1;\nconsole.log(a);';
    const mdx = wrapCodeAsMdx('src/index.ts', code);
    expect(mdx).toContain('```typescript\nconst a = 1;');
    expect(mdx).toContain('\n```\n');
  });

  it('uses 4 backticks when rawContent contains triple backticks', () => {
    const code = '# Markdown Guide\n```json\n{"foo": "bar"}\n```';
    const mdx = wrapCodeAsMdx('docs/readme.md', code);
    expect(mdx).toContain('````markdown\n# Markdown Guide');
    expect(mdx).toContain('\n````\n');
  });

  it('uses 5 backticks when rawContent contains quadruple backticks', () => {
    const code = '````ts\nconst x = 1;\n````';
    const mdx = wrapCodeAsMdx('snippet.ts', code);
    expect(mdx).toContain('`````typescript\n````ts');
    expect(mdx).toContain('\n`````\n');
  });
});
