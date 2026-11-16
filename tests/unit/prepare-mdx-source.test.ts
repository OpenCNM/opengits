import { describe, it, expect } from 'vitest';
import { prepareMdxSource, normalizeVoidTags } from '@/lib/mdx/prepareMdxSource';

describe('prepareMdxSource & normalizeVoidTags (第一性原理自闭合与代码保护)', () => {
  it('表格与正文中的未闭合 <br> 规范化为 <br />', () => {
    const input = '| Col 1 | Col 2 |\n|---|---|\n| 配置项 | 说明1：<br>• 条目A<br>• 条目B |';
    const expected = '| Col 1 | Col 2 |\n|---|---|\n| 配置项 | 说明1：<br />• 条目A<br />• 条目B |';
    expect(normalizeVoidTags(input)).toBe(expected);
  });

  it('HTML void 元素 (<hr>, <wbr>, <img ...>) 自动规整为自闭合', () => {
    const input = '段落一<hr>段落二\n<img src="/test.png" alt="测试">\n<wbr>';
    const expected = '段落一<hr />段落二\n<img src="/test.png" alt="测试" />\n<wbr />';
    expect(normalizeVoidTags(input)).toBe(expected);
  });

  it('围栏代码块内部的 <br> 严格保持原样（零语法破坏不变式）', () => {
    const input = '```html\n<br>\n<hr>\n<img src="foo.png">\n```\n\n正文中的 <br>';
    const expected = '```html\n<br>\n<hr>\n<img src="foo.png">\n```\n\n正文中的 <br />';
    expect(normalizeVoidTags(input)).toBe(expected);
  });

  it('行内代码反引号中的 `<br>` 严格保持原样', () => {
    const input = '正文使用 `<br>` 进行换行，而外部的 <br> 会被自闭合';
    const expected = '正文使用 `<br>` 进行换行，而外部的 <br /> 会被自闭合';
    expect(normalizeVoidTags(input)).toBe(expected);
  });

  it('prepareMdxSource 完整管线：剥离哨兵、概念清单并规整 void 标签', () => {
    const raw = '===CONTENT_BEGIN===\n# 标题\n\n<Summary title="要点">\n- 点1<br>点2\n</Summary>\n\n<concept_manifest>\n[{"name":"foo"}]\n</concept_manifest>\n===CONTENT_END===';
    const processed = prepareMdxSource(raw);
    expect(processed).not.toContain('===CONTENT_BEGIN===');
    expect(processed).not.toContain('===CONTENT_END===');
    expect(processed).not.toContain('<concept_manifest>');
    expect(processed).toContain('- 点1<br />点2');
    expect(processed).toContain('<Summary title="要点">');
  });
});
