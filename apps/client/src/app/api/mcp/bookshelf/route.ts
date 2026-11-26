import { NextRequest } from 'next/server';
import { GET as hubGET, POST as hubPOST } from '@/app/api/mcp/hub/route';

export async function GET(req: NextRequest) {
  return hubGET(req);
}

export async function POST(req: NextRequest) {
  return hubPOST(req);
}
