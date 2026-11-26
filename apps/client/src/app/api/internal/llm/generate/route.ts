import { NextRequest, NextResponse } from 'next/server';
import { internalAuthGuard } from '@/lib/internal-auth';
import {
  llmGenerateRequestSchema,
  runLlmGatewayGenerate,
  runLlmGatewayStream,
  LLM_GATEWAY_ERROR_CODES,
} from '@/lib/llm-gateway/service';

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
