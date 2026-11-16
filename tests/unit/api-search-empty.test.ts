import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const sidecarUnifiedSearchMock = vi.fn();
const callSidecarMock = vi.fn();

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/engine/search-driver', () => ({
  // 检索已下沉 Go（Fail-Closed 单实现）——统一混合检索委托 Go worker-sidecar
  executeSidecarUnifiedSearch: (...args: unknown[]) => sidecarUnifiedSearchMock(...args),
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue(null),
}));

async function callSearch(url: string) {
  const { GET } = await import('@/app/api/search/route');
  return GET(new NextRequest(url), { params: Promise.resolve({}) });
}

describe('GET /api/search 空查询与推荐单测', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidecarUnifiedSearchMock.mockResolvedValue([]);
    callSidecarMock.mockResolvedValue({ ok: true, repos: [] });
  });

  it('无 query 参数时：查询并返回平台热门公开教程（featured_tutorial）', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      repos: [
        { id: 'r1', owner: 'facebook', repo: 'react' },
        { id: 'r2', owner: 'vercel', repo: 'next.js' },
      ],
    });

    const res = await callSearch('http://localhost/api/search');
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(2);
    expect(json.data[0]).toEqual({
      id: 'featured-r1',
      type: 'featured_tutorial',
      isIngested: true,
      title: 'facebook/react',
      description: '',
      owner: 'facebook',
      repo: 'react',
      url: '/docs/facebook/react',
      score: 0,
    });
    expect(json.data[1]).toEqual({
      id: 'featured-r2',
      type: 'featured_tutorial',
      isIngested: true,
      title: 'vercel/next.js',
      description: '',
      owner: 'vercel',
      repo: 'next.js',
      url: '/docs/vercel/next.js',
      score: 0,
    });

    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/search/featured',
      expect.objectContaining({ limit: expect.any(Number) }),
      expect.anything()
    );
  });

  it('空字符串 ?q= 时：同样视为无查询，走热门公开教程', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      repos: [
        { id: 'r1', owner: 'tailwindlabs', repo: 'tailwindcss' },
      ],
    });

    const res = await callSearch('http://localhost/api/search?q=');
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].title).toBe('tailwindlabs/tailwindcss');
  });

  it('纯空格 ?q=%20%20 时：trim 后视为无查询，走热门公开教程', async () => {
    callSidecarMock.mockResolvedValueOnce({ ok: true, repos: [] });

    const res = await callSearch('http://localhost/api/search?q=%20%20%20');
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/search/featured',
      expect.objectContaining({ limit: expect.any(Number) }),
      expect.anything()
    );
  });

  it('🧪 [9.5.2.1] 有实际 query 时：不查 featured 教程，全局检索走 searchGlobalDocs（不再扫 Document.content）', async () => {
    const res = await callSearch('http://localhost/api/search?q=zustand');
    expect(res.status).toBe(200);

    const featuredCall = callSidecarMock.mock.calls.find(
      (call) => call[0] === '/v1/search/featured'
    );
    expect(featuredCall).toBeUndefined();

    expect(sidecarUnifiedSearchMock).toHaveBeenCalledTimes(1);
    expect(sidecarUnifiedSearchMock).toHaveBeenCalledWith(expect.objectContaining({
      query: 'zustand',
      rawQuery: 'zustand',
      userId: null,
    }));
  });

  it('Mode A (仓内搜索)：优先返回概念卡片，chunk 命中聚合为文档级结果（带 headingPath 锚点）', async () => {
    sidecarUnifiedSearchMock.mockResolvedValueOnce([
      {
        id: 'concept-c1',
        type: 'document',
        isIngested: true,
        title: '💡 所有权 (Core)',
        description: 'Rust 核心内存安全机制',
        owner: 'rust-lang',
        repo: 'rust',
        category: 'Core',
        url: '/docs/rust-lang/rust/ch04-01-what-is-ownership#ownership-rules',
        score: 200,
      },
      {
        id: 'doc-rust-lang-rust-ch04-01-what-is-ownership.md',
        type: 'document',
        isIngested: true,
        title: '认识所有权',
        description: '所有权是 Rust 最独特的特性，它让 Rust 无需垃圾回收器即可保证内存安全。',
        owner: 'rust-lang',
        repo: 'rust',
        url: '/docs/rust-lang/rust/ch04-01-what-is-ownership#ownership-rules',
        score: 90,
      },
    ]);

    const res = await callSearch('http://localhost/api/search?q=所有权&owner=rust-lang&repo=rust');
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.length).toBe(2);

    // 概念卡片置顶（score=200）
    expect(json.data[0]).toMatchObject({
      id: 'concept-c1',
      type: 'document',
      isIngested: true,
      title: '💡 所有权 (Core)',
      url: '/docs/rust-lang/rust/ch04-01-what-is-ownership#ownership-rules',
      category: 'Core',
      score: 200,
    });

    // chunk 聚合后的文档结果：snippet 取 chunk content，url 携带锚点
    expect(json.data[1]).toMatchObject({
      id: 'doc-rust-lang-rust-ch04-01-what-is-ownership.md',
      type: 'document',
      isIngested: true,
      title: '认识所有权',
      description: expect.stringContaining('无需垃圾回收器'),
      url: '/docs/rust-lang/rust/ch04-01-what-is-ownership#ownership-rules',
    });

    // 仓内检索透传仓库 owner/repo 与查询原文
    expect(sidecarUnifiedSearchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'rust-lang',
        repo: 'rust',
        query: '所有权',
        rawQuery: '所有权',
      })
    );
  });

  it('🧪 [9.5.1.1] Mode A (同文档多 chunk)：按 path 聚合去重，保留相似度最高的一 chunk', async () => {
    sidecarUnifiedSearchMock.mockResolvedValueOnce([
      {
        id: 'doc-rust-lang-rust-ch04-02-references.md',
        type: 'document',
        isIngested: true,
        title: '引用与借用',
        description: '借用规则规定同一作用域内不可同时拥有可变与不可变引用。',
        owner: 'rust-lang',
        repo: 'rust',
        url: '/docs/rust-lang/rust/ch04-02-references#borrow-rules',
        score: 95, // 50 + similarity(0.9) * 50
      },
    ]);

    const res = await callSearch('http://localhost/api/search?q=借用%20规则&owner=rust-lang&repo=rust');
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.length).toBe(1);
    expect(json.data[0].id).toBe('doc-rust-lang-rust-ch04-02-references.md');
    // 保留高分 chunk 的锚点与摘要
    expect(json.data[0].url).toBe('/docs/rust-lang/rust/ch04-02-references#borrow-rules');
    expect(json.data[0].description).toContain('不可变引用');
    expect(json.data[0].score).toBe(95);
  });

  it('Mode B (全局搜索)：searchGlobalDocs 命中映射为文档结果，与已列出的仓库去重', async () => {
    sidecarUnifiedSearchMock.mockResolvedValueOnce([
      {
        id: 'repo-r1',
        type: 'repository_exists',
        isIngested: true,
        title: 'vercel/next.js',
        description: 'Framework 开源项目',
        owner: 'vercel',
        repo: 'next.js',
        url: '/docs/vercel/next.js',
        category: 'Framework',
        score: 400,
      },
      {
        id: 'doc-pmndrs-zustand-advanced/immer.md',
        type: 'document',
        isIngested: true,
        title: 'zustand 进阶',
        description: 'zustand 与 immer 结合可简化不可变更新。',
        owner: 'pmndrs',
        repo: 'zustand',
        url: '/docs/pmndrs/zustand/advanced/immer',
        score: 75, // 30 + similarity(0.9) * 50
      },
    ]);

    const res = await callSearch('http://localhost/api/search?q=zustand');
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);

    const docResults = json.data.filter((r: { type: string }) => r.type === 'document');
    // vercel/next.js 已有仓库级结果，其文档被抑制；仅保留 pmndrs/zustand 的文档
    expect(docResults).toHaveLength(1);
    expect(docResults[0]).toMatchObject({
      id: 'doc-pmndrs-zustand-advanced/immer.md',
      title: 'zustand 进阶',
      owner: 'pmndrs',
      repo: 'zustand',
      url: '/docs/pmndrs/zustand/advanced/immer',
      score: 75,
    });
  });

  it('🧪 [9.5.1.2] 私有文档经全局搜索泄露给匿名者：搜索限定 isPublic 且传递 userId 约束', async () => {
    await callSearch('http://localhost/api/search?q=secret');

    expect(sidecarUnifiedSearchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'secret',
        userId: null,
      })
    );
  });

  it('🧪 [9.5.1.2] 登录用户全局检索时传递 userId 约束私有文档可见性', async () => {
    const { getSessionHelper } = await import('@/lib/auth-helper');
    vi.mocked(getSessionHelper).mockResolvedValueOnce({
      user: { id: 'user-auth-456', email: 'user@example.com' },
    } as never);

    await callSearch('http://localhost/api/search?q=private-docs');

    expect(sidecarUnifiedSearchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'private-docs',
        userId: 'user-auth-456',
      })
    );
  });

  it('🧪 [9.5.2.2] tsquery 解析失败导致搜索整体报错：静默回落，二者皆空返回空结果而非异常', async () => {
    sidecarUnifiedSearchMock.mockRejectedValueOnce(new Error('tsquery syntax error'));

    const res = await callSearch('http://localhost/api/search?q=invalid:tsquery&');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });
});
