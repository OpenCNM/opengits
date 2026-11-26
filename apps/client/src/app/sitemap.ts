import type { MetadataRoute } from 'next';
import { prisma } from '@/lib/db';
import { getBaseUrl } from '@/lib/url-utils';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = getBaseUrl();

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1.0,
    },
    {
      url: `${baseUrl}/explore`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.8,
    },
    {
      url: `${baseUrl}/legal/terms`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.3,
    },
    {
      url: `${baseUrl}/legal/privacy`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.3,
    },
  ];

  try {
    const publicRepos = await prisma.repository.findMany({
      where: { isPublic: true },
      select: { owner: true, repo: true, updatedAt: true },
      take: 1000,
    });

    const repoRoutes: MetadataRoute.Sitemap = publicRepos.map((r) => ({
      url: `${baseUrl}/docs/${r.owner}/${r.repo}`,
      lastModified: r.updatedAt || new Date(),
      changeFrequency: 'weekly',
      priority: 0.7,
    }));

    return [...staticRoutes, ...repoRoutes];
  } catch (err) {
    console.warn('[sitemap] public repos query failed, serving static routes only:', err);
    return staticRoutes;
  }
}