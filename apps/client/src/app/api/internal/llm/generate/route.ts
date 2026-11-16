import { NextRequest, NextResponse } from 'next/server';
import { internalAuthGuard } from '@/lib/internal-auth';
import {
  llmGenerateRequestSchema,
  runLlmGatewayGenerate,
  runLlmGatewayStream,
  LLM_GATEWAY_ERROR_CODES,
} from '@/lib/llm-gateway/service';

/**
 * ─────────────────────────────────────────────────────────────
 * LLM 网关内部端点（M1 / 方向 3）：Go 执行体 / 其他服务的 LLM 编排统一咽喉。
 *
 * POST /api/internal/llm/generate
 *   x-internal-token: <INTERNAL_API_TOKEN>
 *   x-stream-mode: 1 (可选：开启 NDJSON 10s 心跳直通流)
 *   Accept: application/x-ndjson (可选：同开启流式模式)
 *   { purpose, variables, userId? } → 一元: { ok:true, object, mode } / { ok:true, text, finishReason }
 *                                  ↘ 一元: { ok:false, code, message } + HTTP 状态码
 *                                  ↘ 流式: Content-Type: application/x-ndjson (ping / chunk / done / error)
 *
 * 错误码契约（调用方按 code 分支）：
 * - UNKNOWN_PURPOSE 400 / MISSING_API_KEY 409 / BUDGET_EXCEEDED 429（延后重试）
 * - GENERATION_FAILED 502（provider/schema 终败）
 *
 * 网关豁免清单已含 /api/internal/（免 RPM/UA 拦截；本端点自鉴权）。
 * ─────────────────────────────────────────────────────────────
 */
export async function POST(req: NextRequest) {
  const denied = internalAuthGuard(req);
  if (denied) return denied;

  const raw = await req.json().catch(() => null);
  const parsed = llmGenerateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false as const, code: 'UNKNOWN_PURPOSE', message: 'invalid request body' },
      { status: 400 },
    );
  }

  const callId =
    req.headers.get('x-llm-call-id')?.trim() ||
    (typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10));

  const isStreamMode =
    req.headers.get('x-stream-mode') === '1' ||
    Boolean(req.headers.get('accept')?.includes('application/x-ndjson'));

  if (isStreamMode) {
    const stream = runLlmGatewayStream(parsed.data, { callId, signal: req.signal });
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'x-accel-buffering': 'no',
        'x-llm-call-id': callId,
      },
    });
  }

  const result = await runLlmGatewayGenerate(parsed.data, { callId, signal: req.signal });
  if (result.ok) {
    return NextResponse.json(result, {
      headers: {
        'x-llm-call-id': callId,
      },
    });
  }
  return NextResponse.json(result, {
    status: LLM_GATEWAY_ERROR_CODES[result.code],
    headers: {
      'x-llm-call-id': callId,
    },
  });
}
