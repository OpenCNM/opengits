import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MDX JSX 占位保护回归（审计矩阵 2.3 T1 裁定的修复）。
 * 历史缺陷：rehype-sanitize 把 mdxJsx 系列与表达式节点当未知类型整段丢弃——
 * <Card>/<Steps>/提示组件连同子内容静默消失（转录提示词在大量产出这些组件）。
 * 修复：rehypeSanitizePreservingMdx 占位保护 + mdxJsx 属性轻过滤 + 未注册组件改写。
 */

vi.mock('next/cache', () => ({
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

import { mdxCompiler } from '@/lib/mdx/compile-cache';

async function compile(source: string): Promise<string> {
  const compiled = await mdxCompiler.compile({ source });
  return String(compiled.compiled ?? '');
}

describe('MDX JSX 占位保护（T1 修复回归）', () => {
  it('自定义组件 <Card> 连同属性与子内容完整存活', async () => {
    const code = await compile('<Card title="hello">body text</Card>');
    expect(code).toContain('Card');
    expect(code).toContain('hello');
    expect(code).toContain('body text');
  });

  it('<Steps>/<Step> 组件存活', async () => {
    const code = await compile('<Steps>\n  <Step title="one">do it</Step>\n</Steps>');
    expect(code).toContain('Steps');
    expect(code).toContain('Step');
    expect(code).toContain('do it');
  });

  it('未注册组件 <BogusWidget> 改写为 UnknownMdxComponent（渲染 children 的兜底）', async () => {
    const code = await compile('<BogusWidget>secret sauce</BogusWidget>');
    expect(code).toContain('UnknownMdxComponent');
    expect(code).not.toContain('BogusWidget');
    expect(code).toContain('secret sauce');
  });

  it('Unicode 组件名 <架构视图> 同样改写为兜底组件（红队 GAP-2 回归锁）', async () => {
    const code = await compile('<架构视图>哨兵内容</架构视图>');
    expect(code).toContain('UnknownMdxComponent');
    expect(code).toContain('哨兵内容');
    expect(code).not.toContain('架构视图');
  });

  it('mdxJsx 事件属性被轻过滤剥除', async () => {
    const code = await compile('<Card onclick="alert(1)">x</Card>');
    expect(code).not.toContain('onclick');
    expect(code).toContain('Card');
  });

  it('href 的 javascript: 伪协议被轻过滤剥除', async () => {
    const code = await compile('<Link href="javascript:alert(1)">点我</Link>');
    expect(code).not.toContain('javascript:');
    expect(code).toContain('点我');
  });

  it('remarkSafeBraces 产出的 <DynamicVar> 存活（裸花括号保护恢复生效）', async () => {
    const code = await compile('当前时间是 {now} 点');
    expect(code).toContain('DynamicVar');
    expect(code).toContain('now');
  });

  it('纯 markdown 基线行为不变', async () => {
    const code = await compile('# Title\n\nsome **bold** paragraph\n');
    expect(code).toContain('Title');
    expect(code).toContain('bold');
    expect(code).not.toContain('UnknownMdxComponent');
  });
});
