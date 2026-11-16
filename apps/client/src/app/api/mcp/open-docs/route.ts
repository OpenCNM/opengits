import { NextResponse } from 'next/server';
import { getPublishedMcpOpenDoc } from '@/lib/mcp/default-open-docs';
import { getCorsHeaders } from '@/lib/constants';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data = await getPublishedMcpOpenDoc();
    return NextResponse.json(
      {
        id: data.id,
        version: data.version,
        title: data.title,
        markdown: data.markdown,
        changelog: data.changelog,
        publishedAt: data.publishedAt || data.updatedAt,
      },
      {
        status: 200,
        headers: getCorsHeaders(),
      }
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || 'Failed to fetch MCP open docs' },
      { status: 500, headers: getCorsHeaders() }
    );
  }
}
