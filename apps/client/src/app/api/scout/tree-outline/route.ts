/**
 * POST /api/scout/tree-outline
 *
 * 统一树大纲入口（向导「树模式」）：Go 侧按全量文件数路由深度——
 * 小仓单发扁平章；巨仓骨架规划→并行下钻→课程树（总览课+分区子课）。
 * 用户在向导端勾选子课（分区剪枝），拍平进 customOutline 走既有 ingest。
 */

import { z } from 'zod';
import { NextResponse } from 'next/server';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { executeSidecarTreeOutline, SidecarTreeOutlineResponse } from '@/engine/tree-outline-driver';
import { resolveTargetSha } from '@/engine/repo-tarball';
import { enrichMacroTopologyWithLlm } from '@/engine/macro-topology-enricher';
import { resolveGenerativeLanguage, TRANSLATION_LANGUAGES } from '@/lib/constants';
import { resolveGithubToken } from '@/lib/github/token-resolver';

export const maxDuration = 900;

/** 采样路由观测（契约 C4）：服务端结构化日志一行，不参与透传/渲染。
 *  Phase 2 扩展：补齐 astCoverageRatio 与规划诊断（needRollup 触顶/退化恢复/
 *  覆盖缺失）——单行 key=value 摘要，成败两条路径各一行，零 per-event 写放大。
 *  sha 必带：Phase 3 统计去重键 = (repo, sha)，同仓重试/换版本可区分。 */
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
    );
  }
  console.log(`[TreeOutline] ${parts.join(' ')}`);
};

/** 失败路径单行摘要（守恒公理：错误也进观测账面，不只成功可见） */
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
    pacing: z.enum(['compact', 'normal', 'detailed']).optional(),
    teachingDepth: z.enum(['overview', 'standard', 'deep']).optional(),
    learnerArchetype: z
      .enum(['architecture_overview', 'deep_dive_internals', 'cross_language_migrant', 'pedagogical_beginner'])
      .optional(),
    /** 调用方总预算（毫秒）：客户端 fetch 超时闸的显式声明 */
    budgetMs: z.number().int().positive().max(600_000).optional(),
    /** 显式重试标识：清空前序失败并强制重新点火准备管线 */
    retry: z.boolean().optional(),
  }),
  handler: async ({ request, body, userId }) => {
    const handlerStart = Date.now();

    const isStream =
      Boolean(request.headers.get('accept')?.includes('text/event-stream')) ||
      request.nextUrl.searchParams.get('stream') === '1';

    // 动态预算：调用方总闸（budgetMs）扣除本请求已耗时间与收尾预留
    //（着色 3s + 序列化/网络），剩余额度交给 sidecar 自主编排——
    // 归档/提取快则 LLM 拿到大预算，慢则自动收缩，不再静态拍数
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
          // writer closed or client disconnected
        }
      };

      const sendComment = async (comment: string) => {
        try {
          await writer.write(encoder.encode(`: ${comment}\n\n`));
        } catch {
          // writer closed or client disconnected
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
            // ignore
          }
        });
      }

      (async () => {
        // 声明在 try 之外：catch 分支的失败摘要日志（logOutlineFailure）也要带上 sha
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
              // fail-open: Token 获取失败时交由 Sidecar 内部 Token 池或本地归档兜底
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
              pacing: body.pacing,
              teachingDepth: body.teachingDepth,
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

          // 采样路由观测（契约 C4）：流式与非流式分支共用同一日志出口
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
              // fail-closed: keeps rawMermaid in macroTopology
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
          const anyErr = err as { status?: number; statusCode?: number; message?: string; code?: string };
          const msg = String(anyErr?.message || err);
          // 密钥类配置故障（A 类）：透传真实 code 与 409，前端据此引导重配 Key
          // ——绝不折叠成匿名 TREE_OUTLINE_ERROR（伪弹性会掩盖真实根因）。
          // message 前缀匹配为旧 sidecar 二进制（无结构化 code 字段）的兜底。
          const keyErrorCode =
            anyErr?.code === 'KEY_DECRYPT_FAILED' || anyErr?.code === 'MISSING_API_KEY'
              ? anyErr.code
              : /llm-gateway (KEY_DECRYPT_FAILED|MISSING_API_KEY):/.exec(msg)?.[1];
          if (keyErrorCode) {
            logOutlineFailure(`${body.owner}/${body.repo}`, keyErrorCode, msg, resolvedSha);
            await sendEvent('error', {
              message: msg,
              code: keyErrorCode,
              status: 409,
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
          });
        } finally {
          clearInterval(pingInterval);
          try {
            await writer.close();
          } catch {
            // ignore
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
        // fail-open: Token 获取失败时交由 Sidecar 内部 Token 池或本地归档兜底
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
        pacing: body.pacing,
        teachingDepth: body.teachingDepth,
        learnerArchetype: body.learnerArchetype,
        budgetMs: remainingBudgetMs,
      });
    } catch (err: unknown) {
      const anyErr = err as { status?: number; statusCode?: number; message?: string; code?: string };
      const msg = String(anyErr?.message || err);
      // 密钥类配置故障透传真实根因码（与流式分支同一收口：绝不折叠成匿名 500）
      const keyErrorCode =
        anyErr?.code === 'KEY_DECRYPT_FAILED' || anyErr?.code === 'MISSING_API_KEY'
          ? anyErr.code
          : /llm-gateway (KEY_DECRYPT_FAILED|MISSING_API_KEY):/.exec(msg)?.[1];
      if (keyErrorCode === 'KEY_DECRYPT_FAILED' || keyErrorCode === 'MISSING_API_KEY') {
        logOutlineFailure(`${body.owner}/${body.repo}`, keyErrorCode, msg, resolvedSha);
        throw ApiError.fromCode(keyErrorCode, { detail: msg });
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

    // 采样路由观测（契约 C4）：非流式分支此前缺日志，与流式分支共用出口
    logSamplingRoute(res.stats, `${body.owner}/${body.repo}`, resolvedSha);

    // 冷启动准备透传（202 契约）：巨仓后台下载建图期间无大纲产物，
    // 客户端按 retryAfterMs 轮询——本路由不做富化直接让位
    if (res.preparing) {
      return ok({
        preparing: true,
        status: res.status ?? 'running',
        detail: res.detail ?? null,
        retryAfterMs: res.retryAfterMs ?? 15_000,
      });
    }

    let macroTopology = res.macroTopology ?? res.courseTree?.macroTopology ?? null;

    // 架构图语义着色（非关键路径）：purpose 级 3s deadline 由网关集中强制
    // （registry diagram_architecture_macro_v1.timeoutMs），超时/异常 fail-open
    // 回落 rawMermaid。领域/标签分类伴生产出已离线化——由客户端在大纲就绪后
    // fire-and-forget 调 /api/scout/repo-metadata 懒取（CDC：消费点拉取），
    // 思考类模型的分钟级分类延迟不再扣死本响应。
    if (macroTopology) {
      try {
        macroTopology = await enrichMacroTopologyWithLlm(
          macroTopology,
          body.repo,
          userId,
          // 语义着色是生成型内容:'none' 只约束文档转录,此处确定性回落默认语言。
          // 降级与否不设 API 标记:mermaid/rawMermaid 两字段微秒级可推导(零物化)。
          resolveGenerativeLanguage(body.targetLanguage, TRANSLATION_LANGUAGES.DEFAULT_CODE),
        );
      } catch {
        // fail-closed: keeps rawMermaid in macroTopology
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
