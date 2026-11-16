import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import robots from '@/app/robots';
import sitemap from '@/app/sitemap';
import { GET as feedGet } from '@/app/feed.xml/route';

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findMany: vi.fn().mockResolvedValue([
        { owner: 'testowner', repo: 'testrepo', updatedAt: new Date() },
      ]),
    },
  },
}));

describe('Base URL dynamic derivation (Item 12)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.APP_URL;
    delete process.env.VERCEL_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('robots() derives sitemap url without hardcoding domain when env is empty', () => {
    const res = robots();
    expect(res.sitemap).toBe('https://opengits.com/sitemap.xml');
  });

  it('robots() uses NEXT_PUBLIC_APP_URL when present', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://custom-domain.org';
    const res = robots();
    expect(res.sitemap).toBe('https://custom-domain.org/sitemap.xml');
  });

  it('feed.xml derives baseUrl from request URL when env is empty', async () => {
    const req = new Request('https://preview-123.deploy.app/feed.xml');
    const res = await feedGet(req);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<link>https://preview-123.deploy.app</link>');
    expect(xml).toContain('href="https://preview-123.deploy.app/feed.xml"');
    expect(xml).toContain('https://preview-123.deploy.app/docs/testowner/testrepo');
  });

  it('sitemap() builds routes with derived baseUrl', async () => {
    process.env.APP_URL = 'https://docs.mycompany.io';
    const routes = await sitemap();
    expect(routes.some((r) => r.url === 'https://docs.mycompany.io/explore')).toBe(true);
    expect(routes.some((r) => r.url === 'https://docs.mycompany.io/docs/testowner/testrepo')).toBe(true);
  });
});
