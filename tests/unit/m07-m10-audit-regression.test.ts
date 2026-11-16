import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M01–M10 深审回归（ATOMIC_SYSTEM_AUDIT_MATRIX.md 附录 B 产出）。
 *
 * 两个用例各钉死一个已主线亲证的 bug，对应缺陷已修复，本文件为常驻回归：
 *
 * REGRESSION(BUG-M07-01) resources/read 免配额旁路：
 *   lib/mcp/request-guard.ts:59 将 'resources/read' 列入 FREE_PROTOCOL_METHODS，
 *   enforceMcpAuthAndQuota 对其跳过 McpRateLimiter.checkLimit——而单仓 server 注册的
 *   resources/read 会返回文档全文（server.ts docs:// 资源，16KB/次封顶）。
 *   等效于无限次 read_document：RPM 与日配额对资源通道整体失效。
 *   修复方向：从 FREE 集合移除 resources/read，或对资源读单独计量。
 *
 * REGRESSION(BUG-M10-01) 转录计酬 min>max 反向钳制绕过封顶：
 *   lib/credits/transcription-earn.ts:32-35 Math.max(min, Math.min(max, raw)) 在
 *   admin 误配 min>max（如 50/30）时恒返回 min——非代码章报酬恒等于 min，
 *   transcriptionCreditMax 封顶失效。且当时的 credits-config PUT 校验链无 min<=max
 *   交叉校验，误配可直接落库（该配置路由后随 admin 拆分迁出本仓）。
 *   修复方向：clamp 顺序改为 Math.min(max, Math.max(min, raw)) 或配置侧拒绝 min>max。
 */

// ───────────────────────── BUG-M07-01 ─────────────────────────

const checkLimitMock = vi.fn();

vi.mock('@/lib/mcp/token-auth', () => ({
  authenticateMcpRequest: vi.fn(async () => ({ userId: 'user-1', role: 'USER', response: null })),
  getRoleForMcpUser: vi.fn(async () => 'USER'),
}));
vi.mock('@/lib/mcp/rate-limiter', () => ({
  McpRateLimiter: { checkLimit: checkLimitMock },
}));

describe('REGRESSION(BUG-M07-01): MCP 资源读取必须消耗配额（不得免限流旁路）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkLimitMock.mockResolvedValue({ allowed: true, errorJson: {}, status: 429, headers: {} });
  });

  function fakeRpcRequest(method: string) {
    return {
      clone: () => ({ json: async () => ({ jsonrpc: '2.0', method, id: 1 }) }),
    } as never;
  }

  it('resources/read（返回文档全文）必须经过 McpRateLimiter.checkLimit', async () => {
    const { enforceMcpAuthAndQuota } = await import('@/lib/mcp/request-guard');

    const result = await enforceMcpAuthAndQuota(fakeRpcRequest('resources/read'), { rpc: true });

    // 鉴权应通过
    expect(result.userId).toBe('user-1');
    expect(result.response).toBeNull();
    // 经济不变量：全文读取必须计入 RPM/日配额。
    // 当前实现因 FREE_PROTOCOL_METHODS 含 resources/read 直接提前返回，checkLimit 未被调用。
    expect(checkLimitMock).toHaveBeenCalledTimes(1);
    expect(checkLimitMock).toHaveBeenCalledWith('user-1', 'USER');
  });

  it('对照：tools/list 属协议握手，保持免配额', async () => {
    const { enforceMcpAuthAndQuota } = await import('@/lib/mcp/request-guard');

    await enforceMcpAuthAndQuota(fakeRpcRequest('tools/list'), { rpc: true });

    expect(checkLimitMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────── BUG-M10-01 ─────────────────────────

// REGRESSION(BUG-M10-01) 段已随转录计酬全面退役删除（2026-10 收口：
// lib/credits/transcription-earn.ts 移除——更新市场"不估算、不发钱包积分"为既定产品决策）。
