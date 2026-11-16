import { NextRequest, NextResponse } from 'next/server';
import { internalAuthGuard } from '@/lib/internal-auth';
import { runMarketEngineTick } from '@/lib/scheduler/auto-update';

/**
 * ─────────────────────────────────────────────────────────────
 * 维护者兜底引擎微端点（后续刀 1 收窄）：确定性周期（清扫/过期标记/
 * 候选集/建单/基线推进）与投票结算（换入/否决/postSwap 重建/re-audit）
 * 均已 Go 进程内直跑；本端点仅剩维护者兜底转录（BYOK 注入式引擎，
 * 与 llm/generate 同域裁定保留）。
 *
 * POST /api/internal/scheduler/auto-update-once → { ok: true }
 * ─────────────────────────────────────────────────────────────
 */
export async function POST(req: NextRequest) {
  const denied = internalAuthGuard(req);
  if (denied) return denied;

  try {
    await runMarketEngineTick();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, message: message.slice(0, 500) }, { status: 500 });
  }
}
