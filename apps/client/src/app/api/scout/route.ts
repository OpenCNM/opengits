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

export async function POST(req: NextRequest) {
  try {
    const session = await getSessionHelper();
    if (!session || !session.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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
    }
  };

  const pushComplete = async (data: unknown) => {
    if (signal?.aborted) return;
    try {
      await writer.write(encoder.encode(`event: complete\ndata: ${JSON.stringify(data)}\n\n`));
      await writer.close();
    } catch {
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
      }
    }
  })();

  return new NextResponse(stream.readable, { headers: SSE_HEADERS });
}
