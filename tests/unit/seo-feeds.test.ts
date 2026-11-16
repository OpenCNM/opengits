import { describe, expect, it, vi } from 'vitest';

const repoFindManyMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findMany: (...args: unknown[]) => repoFindManyMock(...args),
    },
  },
}));

describe('SEO, Robots, Sitemap & RSS Feed (T25, T26)', () => {
  it('robots.ts: 输出规范的 Robots 配置', async () => {
    const { default: robots } = await import('@/app/robots');
    const result = robots();
    expect(result.rules).toBeDefined();
    expect(result.sitemap).toContain('/sitemap.xml');
  });

  it('sitemap.ts: 输出静态页与公开仓库路由', async () => {
    repoFindManyMock.mockResolvedValueOnce([
      { owner: 'facebook', repo: 'react', updatedAt: new Date() },
    ]);

    const { default: sitemap } = await import('@/app/sitemap');
    const urls = await sitemap();
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.some((u) => u.url.includes('/docs/facebook/react'))).toBe(true);
    expect(urls.some((u) => u.url.includes('/explore'))).toBe(true);
  });

  it('feed.xml: 输出 RSS 2.0 XML 格式教程聚合', async () => {
    repoFindManyMock.mockResolvedValueOnce([
      {
        owner: 'tailwindlabs',
        repo: 'tailwindcss',
        category: 'Frontend',
        bestUsedFor: ['CSS Framework'],
        updatedAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const { GET: feedGet } = await import('@/app/feed.xml/route');
    const res = await feedGet();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const text = await res.text();
    expect(text).toContain('<rss version="2.0"');
    expect(text).toContain('tailwindlabs/tailwindcss');
  });
});