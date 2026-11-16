import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * MDX 编译内容寻址缓存单测（#9 修订版）：
 * 缓存键含 sha256(源文) / 条目为可序列化结构(compiled 字符串而非 FC) /
 * 命中后仅 render 不再 compile / 缓存异常回落直编。
 */

const compileMock = vi.fn();
const renderMock = vi.fn();

vi.mock('@fumadocs/mdx-remote', () => ({
  createCompiler: () => ({
    compile: (...args: unknown[]) => compileMock(...args),
    render: (...args: unknown[]) => renderMock(...args),
  }),
}));

const cacheRegistry: Array<{ fn: () => Promise<unknown>; keyParts: string[]; options: Record<string, unknown> }> = [];

vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[], options: Record<string, unknown>) => {
    cacheRegistry.push({ fn, keyParts, options });
    return fn;
  },
}));

const SOURCE = '# Hello\n\nWorld';
const fakeComponent = () => null;

describe('cachedCompileMdx(MDX 编译内容寻址缓存)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    cacheRegistry.length = 0;
    // render LRU 是模块级状态，跨用例隔离（render 命中行为有专测）
    const mod = await import('@/lib/mdx/compile-cache');
    mod.__resetRenderCacheForTests();
    // 默认编译产物：compiled 为 JS 字符串（可序列化），body 为不可序列化组件
    compileMock.mockResolvedValue({
      body: fakeComponent,
      toc: [{ depth: 1, title: 'Hello', url: '#hello' }],
      frontmatter: { title: 'Hello' },
      compiled: 'MDX_JS_CODE',
    });
    renderMock.mockResolvedValue({ default: fakeComponent });
  });

  it('miss:编译一次并缓存 compiled 字符串;返回 render 出的组件', async () => {
    const mod = await import('@/lib/mdx/compile-cache');
    const result = await mod.cachedCompileMdx(SOURCE);

    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledWith('MDX_JS_CODE');
    expect(result.body).toBe(fakeComponent); // render 的 default 输出
    expect(result.toc).toEqual([{ depth: 1, title: 'Hello', url: '#hello' }]);
    expect(result.frontmatter).toEqual({ title: 'Hello' });

    // 缓存注册：键含 variant 与源文摘要；revalidate 天级
    expect(cacheRegistry).toHaveLength(1);
    const { keyParts, options } = cacheRegistry[0];
    const digest = createHash('sha256').update(`primary\u0000${SOURCE}`).digest('hex');
    expect(keyParts).toContain('mdx-compile');
    expect(keyParts).toContain(digest);
    expect(options.revalidate).toBe(24 * 60 * 60);
  });

  it('variant 参与摘要:不同 variant 生成不同缓存键', async () => {
    const mod = await import('@/lib/mdx/compile-cache');
    await mod.cachedCompileMdx(SOURCE, 'primary');
    await mod.cachedCompileMdx(SOURCE, 'print');

    const d1 = createHash('sha256').update(`primary\u0000${SOURCE}`).digest('hex');
    const d2 = createHash('sha256').update(`print\u0000${SOURCE}`).digest('hex');
    expect(cacheRegistry[0].keyParts).toContain(d1);
    expect(cacheRegistry[1].keyParts).toContain(d2);
  });

  it(':h1s 剔除变体独立缓存键 + 缓存版本升 v5（读侧卫生插件行为变更失效旧条目）', async () => {
    const mod = await import('@/lib/mdx/compile-cache');
    await mod.cachedCompileMdx(SOURCE, 'primary:h1s');

    const dh = createHash('sha256').update(`primary:h1s\u0000${SOURCE}`).digest('hex');
    expect(cacheRegistry[0].keyParts).toContain(dh);
    expect(cacheRegistry[0].keyParts).toContain('v5');
    expect(cacheRegistry[0].keyParts).not.toContain('v4');
  });

  it('缓存条目不含组件函数(纯数据),保证 JSON 可序列化', async () => {
    const mod = await import('@/lib/mdx/compile-cache');
    await mod.cachedCompileMdx(SOURCE);
    const entry = await cacheRegistry[0].fn();
    // JSON 序列化不丢内容(body 组件从未进入缓存条目)
    expect(JSON.parse(JSON.stringify(entry))).toEqual({
      compiled: 'MDX_JS_CODE',
      toc: [{ depth: 1, title: 'Hello', url: '#hello' }],
      frontmatter: { title: 'Hello' },
    });
  });

  it('render LRU 命中:同源二次请求不再 compile 也不再 render eval', async () => {
    const mod = await import('@/lib/mdx/compile-cache');
    const first = await mod.cachedCompileMdx(SOURCE);
    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(1);

    const second = await mod.cachedCompileMdx(SOURCE);
    // 进程内 LRU 命中：compile/render 均零次新增，body 复用同一 FC 引用
    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(second.body).toBe(first.body);
    expect(second.toc).toEqual(first.toc);
    // 两次请求只注册一条 unstable_cache 条目（无二次缓存读）
    expect(cacheRegistry).toHaveLength(1);
  });

  it('缓存读取抛错:回落直编路径,不阻塞渲染', async () => {
    vi.resetModules();
    vi.doMock('next/cache', () => ({
      unstable_cache: () => async () => {
        throw new Error('cache store down');
      },
    }));
    const mod = await import('@/lib/mdx/compile-cache');

    const result = await mod.cachedCompileMdx('# Another');
    // 直编兜底生效:返回编译产物本身
    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(result.toc).toEqual([{ depth: 1, title: 'Hello', url: '#hello' }]);
    expect(renderMock).not.toHaveBeenCalled(); // 未走 render 路径
  });

  it('源文编译错误:直接上抛不做同源二次编译（坏文档每次视图原白付两次编译）', async () => {
    vi.resetModules();
    compileMock.mockRejectedValueOnce(new Error('bad mdx source'));
    const mod = await import('@/lib/mdx/compile-cache');

    await expect(mod.cachedCompileMdx('# Broken')).rejects.toThrow('bad mdx source');
    // 缓存包装内编译失败后不再触发兜底直编
    expect(compileMock).toHaveBeenCalledTimes(1);
  });

  it('stringifyTocTitle 与 sanitizeTocItems：递归纯文本化防反序列化 null 消失', async () => {
    const mod = await import('@/lib/mdx/compile-cache');

    // 测试字符串
    expect(mod.stringifyTocTitle('快速开始')).toBe('快速开始');

    // 测试带有嵌套 children 的对象（如 React VNode 或反序列化后的 JSON）
    const vnode = {
      type: 'span',
      props: {
        children: ['Hello ', { type: 'code', props: { children: 'World' } }],
      },
    };
    expect(mod.stringifyTocTitle(vnode)).toBe('Hello World');

    // 测试 sanitizeTocItems
    const rawToc = [
      { depth: 2, url: '#intro', title: vnode },
      { depth: 3, url: '#step-1', title: '步骤一' },
      { depth: 2, url: '#empty', title: null },
    ];

    const clean = mod.sanitizeTocItems(rawToc);
    expect(clean).toEqual([
      { depth: 2, url: '#intro', title: 'Hello World' },
      { depth: 3, url: '#step-1', title: '步骤一' },
    ]);
  });
});
