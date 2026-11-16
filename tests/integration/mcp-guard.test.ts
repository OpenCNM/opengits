import { test, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { enforceMcpAuth, enforceMcpAuthAndQuota } from '@/lib/mcp/request-guard';

/**
 * MCP 统一守卫回归锚点：
 * 1. 无效 Bearer Token → 401 且绝不回落 cookie/默认用户（防身份串号）
 * 2. 401 带 WWW-Authenticate: Bearer challenge（MCP 规范；RFC 9728 对齐后
 *    challenge 附 resource_metadata 指引授权服务器发现端点，见 d1d3e106）
 * 3. REST / JSON-RPC 两种错误体
 * 4. 鉴权失败不触配额路径（auth 先于 quota）
 * 注：无凭证路径依赖 next-auth 请求上下文，由手动矩阵覆盖。
 */

function bearerReq(token: string, path = '/api/mcp/hub'): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

test('无效 Token → REST 401 + WWW-Authenticate: Bearer + error 体', async () => {
  const rest = await enforceMcpAuth(bearerReq('opgts_0000000000000000000000000000000'), {});
  expect(rest.response).toBeTruthy();
  expect(rest.response!.status).toBe(401);
  const challenge = rest.response!.headers.get('WWW-Authenticate') ?? '';
  // RFC 9728：Bearer challenge + resource_metadata（授权服务器发现指引）
  expect(challenge.startsWith('Bearer')).toBe(true);
  expect(challenge).toContain('resource_metadata=');
  const body: any = await rest.response!.json();
  expect(String(body.error)).toContain('Unauthorized');
});

test('无效 Token → JSON-RPC 401（jsonrpc 2.0 / code -32000 / id null）', async () => {
  const rpc = await enforceMcpAuth(bearerReq('opgts_0000000000000000000000000000000'), { rpc: true });
  expect(rpc.response!.status).toBe(401);
  const body: any = await rpc.response!.json();
  expect(body.jsonrpc).toBe('2.0');
  expect(body.error?.code).toBe(-32000);
  expect(body.id).toBeNull();
});

test('enforceMcpAuthAndQuota：鉴权失败先于配额检查（userId 空）', async () => {
  const quota = await enforceMcpAuthAndQuota(bearerReq('opgts_0000000000000000000000000000000'), { rpc: true });
  expect(quota.response!.status).toBe(401);
  expect(quota.userId).toBe('');
});

test('任意伪造 Token 一律 401——无默认用户回落旁路', async () => {
  const another = await enforceMcpAuth(bearerReq(`opgts_deadbeef_${Date.now()}`, '/api/mcp/hub'), { rpc: true });
  expect(another.response!.status).toBe(401);
});
