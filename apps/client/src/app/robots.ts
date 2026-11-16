import type { MetadataRoute } from 'next';
import { getBaseUrl } from '@/lib/url-utils';

export default function robots(): MetadataRoute.Robots {
  const baseUrl = getBaseUrl();
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/admin/', '/settings/', '/auth/', '/private/'],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}