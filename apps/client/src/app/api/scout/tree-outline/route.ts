import { z } from 'zod';
import { NextResponse } from 'next/server';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { executeSidecarTreeOutline, SidecarTreeOutlineResponse } from '@/engine/tree-outline-driver';
import { resolveTargetSha } from '@/engine/repo-tarball';
import { enrichMacroTopologyWithLlm } from '@/engine/macro-topology-enricher';
import { resolveGenerativeLanguage, TRANSLATION_LANGUAGES } from '@/lib/constants';
import { resolveGithubToken } from '@/lib/github/token-resolver';
import { ignoreBestEffort } from '@/lib/best-effort';

export const maxDuration = 900;

const logSamplingRoute = (stats: SidecarTreeOutlineResponse['stats'], repo: string, sha?: string): void => {
  if (!stats?.samplingStrategy && !stats?.diagnostics) return;
  const parts = [
    `repo=${repo}`,
    sha ? `sha=${sha}` : '',
    stats.samplingStrategy ? `samplingStrategy=${stats.samplingStrategy}` : '',
    `sampledFileCount=${stats.sampledFileCount ?? 0}`,
    stats.astCoverageRatio !== undefined ? `astCoverageRatio=${stats.astCoverageRatio}` : '',
    stats.allFiles !== undefined ? `allFiles=${stats.allFiles}` : '',
    stats.durationMs !== undefined ? `durationMs=${stats.durationMs}` : '',
  ].filter(Boolean);
  const d = stats.diagnostics;
  if (d) {
    parts.push(
      `needRollupRequested=${d.needRollupRequested ?? 0}`,
      `needRollupCapped=${d.needRollupCapped ?? false}`,
      `planDegenerateTriggered=${d.planDegenerateTriggered ?? false}`,
      `planDegenerateRecovered=${d.planDegenerateRecovered ?? false}`,
      `uncoveredSubsystemCount=${d.uncoveredSubsystemCount ?? 0}`,
      `needRollupQuota=${d.needRollupQuota ?? 0}`,
      `needRollupDepth=${d.needRollupDepth ?? 0}`,
    );
  }
  console.log(`[TreeOutline] ${parts.join(' ')}`);
};

const logOutlineFailure = (repo: string, code: string, message: string, sha?: string): void => {
  const parts = [
    `repo=${repo}`,
    sha ? `sha=${sha}` : '',
    `code=${code}`,
    `message="${message.slice(0, 200)}"`,
  ];
  console.log(`[TreeOutline] outcome=error ${parts.join(' ')}`);
};

const SSE_HEADERS: HeadersInit = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

const PreviousOutlineChapterSchema = z.object({
  index: z.number().int().positive().optional(),
  partTitle: z.string().max(120).optional(),
  title: z.string().min(1).max(200),
  files: z.array(z.string().max(300)).max(8).optional(),
});

export const POST = defineRoute({
  scope: 'POST /api/scout/tree-outline',
  auth: 'user',
  bodySchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    sha: z.string().min(1),
    token: z.string().optional(),
    githubToken: z.string().optional(),
    targetLanguage: z.string().optional(),
    prefix: z.string().optional(),
    fileCap: z.number().int().positive().optional(),
    excludedPaths: z.array(z.string()).optional(),
    customPrompt: z.string().optional(),
    previousOutline: z.array(PreviousOutlineChapterSchema).max(30).optional(),
    pacing: z.enum(['compact', 'normal', 'detailed']).optional(),
    teachingDepth: z.enum(['overview', 'standard', 'deep']).optional(),
    learnerArchetype: z
      .enum(['architecture_overview', 'deep_dive_internals', 'cross_language_migrant', 'pedagogical_beginner'])
      .optional(),
    budgetMs: z.number().int().positive().max(600_000).optional(),
    rollupLevel: z.number().int().min(0).max(3).optional(),
    retry: z.boolean().optional(),
  }),
  handler: async ({ request, body, userId }) => {
    const handlerStart = Date.now();

    const isStream =
      Boolean(request.headers.get('accept')?.includes('text/event-stream')) ||
      request.nextUrl.searchParams.get('stream') === '1';

    const remainingBudgetMs =
      body.budgetMs && body.budgetMs > 0
        ? Math.max(15_000, body.budgetMs - (Date.now() - handlerStart) - 10_000)
        : undefined;

    if (isStream) {
      const stream = new TransformStream();
      const writer = stream.writable.getWriter();
      const encoder = new TextEncoder();

      const sendEvent = async (event: string, data: any) => {
        try {
          const payload = typeof data === 'string' ? data : JSON.stringify(data);
          await writer.write(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
        } catch {
        }
      };

      const sendComment = async (comment: string) => {
        try {
          await writer.write(encoder.encode(`: ${comment}\n\n`));
        } catch {
        }
      };

      const pingInterval = setInterval(() => {
        void sendComment('ping');
      }, 4000);

      if (request.signal) {
        request.signal.addEventListener('abort', () => {
          clearInterval(pingInterval);
          try {
            void writer.abort();
          } catch {
          }
        });
      }

      (async () => {
        let resolvedSha = body.sha;
        try {
          try {
            resolvedSha = await resolveTargetSha(body.owner, body.repo, body.sha);
          } catch (resolveErr) {
            console.warn(`[TreeOutline] Failed to resolve target SHA for ${body.owner}/${body.repo}@${body.sha}:`, resolveErr);
          }

          let effectiveToken = body.githubToken || body.token;
          if (!effectiveToken && userId) {
            try {
              effectiveToken = await resolveGithubToken(userId);
            } catch {
              ignoreBestEffort();
            }
          }

          const res = await executeSidecarTreeOutline(
            {
              owner: body.owner,
              repo: body.repo,
              sha: resolvedSha,
              token: effectiveToken,
              githubToken: effectiveToken,
              targetLanguage: body.targetLanguage,
              prefix: body.prefix,
              fileCap: body.fileCap,
              userId,
              excludedPaths: body.excludedPaths,
              customPrompt: body.customPrompt,
              previousOutline: body.previousOutline,
              pacing: body.pacing,
              teachingDepth: body.teachingDepth,
              rollupLevel: body.rollupLevel,
              learnerArchetype: body.learnerArchetype,
              budgetMs: remainingBudgetMs,
              retry: body.retry,
            },
            {
              signal: request.signal,
              stream: true,
              onProgress: (step) => {
                void sendEvent('step', step);
              },
            }
          );

          logSamplingRoute(res.stats, `${body.owner}/${body.repo}`, resolvedSha);

          if (res.preparing) {
            await sendEvent('complete', {
              preparing: true,
              status: res.status ?? 'running',
              detail: res.detail ?? null,
              retryAfterMs: res.retryAfterMs ?? 15_000,
            });
            return;
          }

          let macroTopology = res.macroTopology ?? res.courseTree?.macroTopology ?? null;
          if (macroTopology) {
            try {
              macroTopology = await enrichMacroTopologyWithLlm(
                macroTopology,
                body.repo,
                userId,
                resolveGenerativeLanguage(body.targetLanguage, TRANSLATION_LANGUAGES.DEFAULT_CODE),
              );
            } catch {
              ignoreBestEffort();
            }
          }

          await sendEvent('complete', {
            depth: res.depth,
            chapters: res.chapters ?? [],
            courseTree: res.courseTree ?? null,
            macroTopology,
            droppedPaths: res.droppedPaths ?? [],
            excludedFiles: res.excludedFiles ?? [],
            stats: res.stats ?? {},
            resolvedSha,
          });
        } catch (err: unknown) {
          const anyErr = err as {
            status?: number;
            statusCode?: number;
            message?: string;
            code?: string;
            provider?: string;
            model?: string;
            upstreamStatus?: number;
            upstreamCode?: string;
            upstreamMessage?: string;
          };
          const msg = String(anyErr?.message || err);
          const knownCodes = new Set([
            'KEY_DECRYPT_FAILED',
            'MISSING_API_KEY',
            'BUDGET_EXCEEDED',
            'UPSTREAM_AUTH_ERROR',
            'UPSTREAM_QUOTA_EXCEEDED',
            'UPSTREAM_MODEL_NOT_FOUND',
            'UPSTREAM_BAD_REQUEST',
            'UPSTREAM_SERVER_ERROR',
            'UPSTREAM_NETWORK_ERROR',
            'RATE_LIMITED',
          ]);
          const matchedPrefixCode = /llm-gateway ([A-Z_]+):/.exec(msg)?.[1];
          const resolvedCode =
            anyErr?.code && knownCodes.has(anyErr.code)
              ? anyErr.code
              : matchedPrefixCode && knownCodes.has(matchedPrefixCode)
                ? matchedPrefixCode
                : undefined;

          if (resolvedCode) {
            const status =
              typeof anyErr?.status === 'number' && anyErr.status > 0
                ? anyErr.status
                : resolvedCode === 'KEY_DECRYPT_FAILED' || resolvedCode === 'MISSING_API_KEY'
                  ? 409
                  : resolvedCode === 'UPSTREAM_AUTH_ERROR'
                    ? 401
                    : resolvedCode === 'UPSTREAM_QUOTA_EXCEEDED'
                      ? 402
                      : resolvedCode === 'UPSTREAM_MODEL_NOT_FOUND'
                        ? 404
                        : resolvedCode === 'UPSTREAM_BAD_REQUEST'
                          ? 400
                          : resolvedCode === 'RATE_LIMITED' || resolvedCode === 'BUDGET_EXCEEDED'
                            ? 429
                            : 502;
            logOutlineFailure(`${body.owner}/${body.repo}`, resolvedCode, msg, resolvedSha);
            await sendEvent('error', {
              message: msg,
              code: resolvedCode,
              status,
              ...(anyErr.provider ? { provider: anyErr.provider } : {}),
              ...(anyErr.model ? { model: anyErr.model } : {}),
              ...(anyErr.upstreamStatus !== undefined ? { upstreamStatus: anyErr.upstreamStatus } : {}),
              ...(anyErr.upstreamCode ? { upstreamCode: anyErr.upstreamCode } : {}),
              ...(anyErr.upstreamMessage ? { upstreamMessage: anyErr.upstreamMessage } : {}),
            });
            return;
          }
          const isRateLimit =
            anyErr?.status === 429 ||
            anyErr?.statusCode === 429 ||
            /rate limit|ratelimit|throttling|toomanyrequests|速率限制|请求频率|并发超限|429/i.test(msg);
          const finalCode = isRateLimit ? 'RATE_LIMITED' : 'TREE_OUTLINE_ERROR';
          logOutlineFailure(`${body.owner}/${body.repo}`, finalCode, msg, resolvedSha);
          await sendEvent('error', {
            message: msg,
            code: finalCode,
            status: isRateLimit ? 429 : 500,
            ...(anyErr.provider ? { provider: anyErr.provider } : {}),
            ...(anyErr.model ? { model: anyErr.model } : {}),
            ...(anyErr.upstreamStatus !== undefined ? { upstreamStatus: anyErr.upstreamStatus } : {}),
            ...(anyErr.upstreamCode ? { upstreamCode: anyErr.upstreamCode } : {}),
            ...(anyErr.upstreamMessage ? { upstreamMessage: anyErr.upstreamMessage } : {}),
          });
        } finally {
          clearInterval(pingInterval);
          try {
            await writer.close();
          } catch {
          }
        }
      })();

      return new NextResponse(stream.readable, { headers: SSE_HEADERS });
    }

    let resolvedSha = body.sha;
    try {
      resolvedSha = await resolveTargetSha(body.owner, body.repo, body.sha);
    } catch (resolveErr) {
      console.warn(`[TreeOutline] Failed to resolve target SHA for ${body.owner}/${body.repo}@${body.sha}:`, resolveErr);
    }

    let effectiveToken = body.githubToken || body.token;
    if (!effectiveToken && userId) {
      try {
        effectiveToken = await resolveGithubToken(userId);
      } catch {
        ignoreBestEffort();
      }
    }

    let res;
    try {
      res = await executeSidecarTreeOutline({
        owner: body.owner,
        repo: body.repo,
        sha: resolvedSha,
        token: effectiveToken,
        githubToken: effectiveToken,
        targetLanguage: body.targetLanguage,
        prefix: body.prefix,
        fileCap: body.fileCap,
        userId,
        excludedPaths: body.excludedPaths,
        customPrompt: body.customPrompt,
        previousOutline: body.previousOutline,
        pacing: body.pacing,
        teachingDepth: body.teachingDepth,
        rollupLevel: body.rollupLevel,
        learnerArchetype: body.learnerArchetype,
        budgetMs: remainingBudgetMs,
      });
    } catch (err: unknown) {
      const anyErr = err as { status?: number; statusCode?: number; message?: string; code?: string };
      const msg = String(anyErr?.message || err);
      const nonStreamKnownCodes = [
        'KEY_DECRYPT_FAILED',
        'MISSING_API_KEY',
        'UPSTREAM_AUTH_ERROR',
        'UPSTREAM_QUOTA_EXCEEDED',
        'UPSTREAM_MODEL_NOT_FOUND',
        'UPSTREAM_BAD_REQUEST',
        'UPSTREAM_SERVER_ERROR',
        'UPSTREAM_NETWORK_ERROR',
      ] as const;
      const matchedPrefixCode = /llm-gateway ([A-Z_]+):/.exec(msg)?.[1];
      const matchedKnown = nonStreamKnownCodes.find(
        (c) => c === anyErr?.code || c === matchedPrefixCode
      );
      if (matchedKnown) {
        logOutlineFailure(`${body.owner}/${body.repo}`, matchedKnown, msg, resolvedSha);
        throw ApiError.fromCode(matchedKnown, { detail: msg });
      }
      const isRateLimit =
        anyErr?.status === 429 ||
        anyErr?.statusCode === 429 ||
        /rate limit|ratelimit|throttling|toomanyrequests|速率限制|请求频率|并发超限|429/i.test(msg);
      if (isRateLimit) {
        logOutlineFailure(`${body.owner}/${body.repo}`, 'RATE_LIMITED', msg, resolvedSha);
        throw ApiError.fromCode('RATE_LIMITED', { detail: msg });
      }
      logOutlineFailure(`${body.owner}/${body.repo}`, 'TREE_OUTLINE_ERROR', msg, resolvedSha);
      throw err;
    }

    logSamplingRoute(res.stats, `${body.owner}/${body.repo}`, resolvedSha);

    if (res.preparing) {
      return ok({
        preparing: true,
        status: res.status ?? 'running',
        detail: res.detail ?? null,
        retryAfterMs: res.retryAfterMs ?? 15_000,
      });
    }

    let macroTopology = res.macroTopology ?? res.courseTree?.macroTopology ?? null;

    if (macroTopology) {
      try {
        macroTopology = await enrichMacroTopologyWithLlm(
          macroTopology,
          body.repo,
          userId,
          resolveGenerativeLanguage(body.targetLanguage, TRANSLATION_LANGUAGES.DEFAULT_CODE),
        );
      } catch {
        ignoreBestEffort();
      }
    }

    return ok({
      depth: res.depth,
      chapters: res.chapters ?? [],
      courseTree: res.courseTree ?? null,
      macroTopology,
      droppedPaths: res.droppedPaths ?? [],
      excludedFiles: res.excludedFiles ?? [],
      stats: res.stats ?? {},
      resolvedSha,
    });
  },
});
