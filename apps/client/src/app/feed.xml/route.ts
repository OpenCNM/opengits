import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getBaseUrl } from '@/lib/url-utils';

export async function GET(request?: Request) {
  let origin = '';
  try {
    if (request?.url) {
      origin = new URL(request.url).origin;
    }
  } catch {}
  const baseUrl = getBaseUrl(origin);

  const repos = await prisma.repository.findMany({
    where: { isPublic: true },
    select: {
      owner: true,
      repo: true,
      category: true,
      bestUsedFor: true,
      updatedAt: true,
      createdAt: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  }).catch(() => []);

  const itemsXml = repos
    .map((r) => {
      const link = `${baseUrl}/docs/${r.owner}/${r.repo}`;
      const title = `${r.owner}/${r.repo}`;
      const desc = r.bestUsedFor?.join(', ') || r.category || 'OpenGits Tutorial';
      const pubDate = new Date(r.updatedAt || r.createdAt).toUTCString();
      // CDATA 内唯一的逃逸序列是 ]]>：不转义可被用户可控文本提前闭合并注入任意 XML 节点
      const safeTitle = title.replace(/\]\]>/g, ']]&gt;');
      const safeDesc = desc.replace(/\]\]>/g, ']]&gt;');
      return `    <item>
      <title><![CDATA[${safeTitle}]]></title>
      <link>${link}</link>
      <guid>${link}</guid>
      <description><![CDATA[${safeDesc}]]></description>
      <pubDate>${pubDate}</pubDate>
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>OpenGits - Latest Tutorials</title>
    <link>${baseUrl}</link>
    <description>AI-native open source codebase tutorials and interactive learning</description>
    <language>zh-CN</language>
    <atom:link href="${baseUrl}/feed.xml" rel="self" type="application/rss+xml"/>
${itemsXml}
  </channel>
</rss>`;

  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}