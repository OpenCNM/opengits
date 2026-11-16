import { NextRequest, NextResponse } from 'next/server';
import { getSessionHelper } from "@/lib/auth-helper";
import { checkRateLimit } from '@/lib/rate-limit';
import { isEmergencyReadOnly } from '@/lib/gateway/policy';
import {
  getRepoImportQuotaError,
  isScoutPipelineError,
  runScoutPipeline,
  SCOUT_RATE_LIMIT_PER_MINUTE,
  SCOUT_RATE_LIMIT_WINDOW_MS,
  ScoutPipelineInput,
} from '@/lib/scout/pipeline';
import { inspectGithubUrl, InspectionResult } from '@/lib/url-inspector';

const STREAM_QUERY_PARAM = 'stream';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
} as const;

interface ScoutRequestBody {
  url?: string;
  customPrompt?: string;
  activeParadigm?: string;
  targetLanguage?: string;
  prefixFilter?: string;
  importScopeMode?: string;
  filePath?: string;
}

/**
 * scout 探测路由：协议层（鉴权 / 限流 / 输入校验 / SSE 或同步响应），
 * 领域逻辑全部在 lib/scout/pipeline 服务层。
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSessionHelper();
    if (!session || !session.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 紧急只读熔断：scout 为 LLM 密集探测+导入链路，熔断期整体暂停（策略库故障 fail-open）
    if (await isEmergencyReadOnly()) {
      return NextResponse.json(
        { status: 'EMERGENCY_READONLY', error: '全站维护中，探测暂不可用，请稍后再试' },
        { status: 503 }
      );
    }

    const allowed = await checkRateLimit(
      `scout:${session.user.id}`,
      SCOUT_RATE_LIMIT_PER_MINUTE,
      SCOUT_RATE_LIMIT_WINDOW_MS
    );
    if (!allowed) {
      return NextResponse.json(
        { status: 'RATE_LIMITED', error: '探测请求过于频繁，请稍后再试' },
        { status: 429 }
      );
    }

    const body = (await req.json()) as ScoutRequestBody;

    // 缺省 url 以空串送检——与原实现一致，由 URL 预检产出 INVALID_FORMAT 诊断
    const inspection = inspectGithubUrl(body.url ?? '');
    if (!inspection.isValid) {
      return NextResponse.json({
        status: inspection.status,
        error: inspection.diagnosticTitle,
        diagnosticDescription: inspection.diagnosticDescription,
        suggestedFormat: inspection.suggestedFormat,
      }, { status: 400 });
    }

    const { owner, repo } = inspection;
    if (!owner || !repo) {
      return NextResponse.json({
        status: 'INVALID_FORMAT',
        error: '无法解析 owner/repo',
        suggestedFormat: 'https://github.com/owner/repo'
      }, { status: 400 });
    }

    // 仓数上限预检（导入管线第一步；重复导入已有仓不占新额度）
    const quotaError = await getRepoImportQuotaError(session.user.id, owner, repo);
    if (quotaError) {
      return NextResponse.json(quotaError, { status: 403 });
    }

    const isStream = req.headers.get('accept')?.includes('text/event-stream')
      || req.nextUrl.searchParams.get(STREAM_QUERY_PARAM) === '1';

    const input: ScoutPipelineInput = {
      owner,
      repo,
      userId: session.user.id,
      urlBranch: inspection.branch ?? undefined,
      customPrompt: body.customPrompt,
      activeParadigm: body.activeParadigm,
      targetLanguage: body.targetLanguage,
      prefixFilter: body.prefixFilter,
      importScopeMode: body.importScopeMode,
      filePath: body.filePath,
      inspectionFilePath: inspection.filePath ?? undefined,
    };
    const context = {
      urlBranch: inspection.branch ?? undefined,
      inspectionFilePath: inspection.filePath ?? undefined,
      inspectionResourceType: inspection.resourceType,
    };

    if (isStream) {
      return streamPipelineResponse(input, context, req.signal);
    }

    // Standard synchronous response fallback
    try {
      const result = await runScoutPipeline(input, { ...context, signal: req.signal });
      return NextResponse.json(result);
    } catch (err: unknown) {
      if (isScoutPipelineError(err)) {
        return NextResponse.json(err.toJSON(), { status: err.httpStatus });
      }
      return NextResponse.json({ error: err instanceof Error ? err.message : '探测失败' }, { status: 500 });
    }
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '探测失败' }, { status: 500 });
  }
}

/** SSE 路径：管道阶段事件逐条推送，complete/error 收口后关闭流 */
function streamPipelineResponse(
  input: ScoutPipelineInput,
  context: Parameters<typeof runScoutPipeline>[1],
  signal?: AbortSignal
): NextResponse {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const pushStep = async (step: { stage: string; tag: string; title: string; detail: string }) => {
    if (signal?.aborted) return;
    const payload = JSON.stringify({ ...step, timestamp: new Date().toISOString() });
    try {
      await writer.write(encoder.encode(`event: step\ndata: ${payload}\n\n`));
    } catch {
      // client disconnected
    }
  };

  const pushComplete = async (data: unknown) => {
    if (signal?.aborted) return;
    try {
      await writer.write(encoder.encode(`event: complete\ndata: ${JSON.stringify(data)}\n\n`));
      await writer.close();
    } catch {
      // client disconnected
    }
  };

  (async () => {
    try {
      if (signal?.aborted) {
        await writer.close().catch(() => {});
        return;
      }
      const result = await runScoutPipeline(input, { ...context, signal }, pushStep);
      if (signal?.aborted) {
        await writer.close().catch(() => {});
        return;
      }
      await pushComplete(result);
    } catch (err: unknown) {
      if (signal?.aborted) {
        await writer.close().catch(() => {});
        return;
      }
      const errPayload = isScoutPipelineError(err)
        ? err.toJSON()
        : { error: err instanceof Error ? err.message : '探测失败' };
      try {
        await writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify(errPayload)}\n\n`));
        await writer.close();
      } catch {
        // client disconnected
      }
    }
  })();

  return new NextResponse(stream.readable, { headers: SSE_HEADERS });
}
