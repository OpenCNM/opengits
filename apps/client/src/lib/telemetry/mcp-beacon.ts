import { Prisma } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { TELEMETRY_EVENTS } from './beacon';
import { MCP_QUERY_STATUS, MCP_QUERY_DIMENSIONS } from '@/lib/constants';
import { publishPresence } from '@/lib/mcp/presence-bus';
import { estimateTokens, truncateToTokenBudget } from '@/lib/token-counter';

export interface RecordMcpToolCallParams {
  repositoryId?: string;
  bundleId?: string;
  toolName: string;
  query?: string;
  expandedQuery?: string;
  resultCount: number;
  fromVersion?: string;
  toVersion?: string;
  tokensSaved?: number;
  gotchasGuarded?: number;
  dimension?: string;
  tokenBudget?: number;
  tokensReturned?: number;
  responseTimeMs?: number;
  status?: (typeof MCP_QUERY_STATUS)[number];
  errorMessage?: string;
  resultSnapshot?: Prisma.InputJsonValue | null;
  /** 调用者（token 解析所得）：用户隔离查询的依据；缺省时从工具遥测上下文取 */
  userId?: string;
  /** 发起调用的 MCP 客户端名（归一化后）；缺省时从工具遥测上下文取 */
  clientName?: string;
  /** 端点/入参显式请求的讲法或版本（回退观测：与 resolvedEdition 不一致即回退） */
  requestedEdition?: string;
  /** 实际服务的讲法 key（'' = 基础讲法） */
  resolvedEdition?: string;
  /** 解析回退标记（请求未命中回退基础行时 true） */
  isFallback?: boolean;
}

/** 工具执行上下文：wrapToolTelemetry 注入调用者与客户端名，工具内部 recordMcpToolCall 自动携带 */
const toolTelemetryContext = new AsyncLocalStorage<{
  userId?: string;
  clientName?: string;
  requestedEdition?: string;
  resolvedEdition?: string;
  isFallback?: boolean;
}>();

/**
 * 在 MCP 请求派发外层注入客户端名（路由层调用）。
 * wrapToolTelemetry 建立内层 store 时会保留外层 clientName。
 */
export function runWithMcpClientContext<R>(clientName: string | undefined, fn: () => Promise<R>): Promise<R> {
  if (!clientName) return fn();
  return toolTelemetryContext.run({ clientName }, fn);
}

/**
 * 在 MCP 请求外层注入讲法/版本解析观测字段（路由层调用；resolveRepository 后）。
 * wrapToolTelemetry 建立内层 store 时保留外层字段，工具内 recordMcpToolCall 自动携带。
 */
export function runWithMcpEditionContext<R>(
  edition: { requestedEdition?: string; resolvedEdition?: string; isFallback?: boolean } | undefined,
  fn: () => Promise<R>
): Promise<R> {
  if (!edition || (!edition.requestedEdition && !edition.resolvedEdition && !edition.isFallback)) return fn();
  const outer = toolTelemetryContext.getStore();
  return toolTelemetryContext.run({ ...outer, ...edition }, fn);
}

/**
 * 从工具名推导默认查询维度（写入 McpCallLog.dimension 的值，全部取自注册表）
 */
export function deriveQueryDimension(toolName: string): string {
  if (toolName.includes('architecture')) return MCP_QUERY_DIMENSIONS[1];
  if (toolName.includes('code')) return MCP_QUERY_DIMENSIONS[2];
  if (toolName.includes('gotcha')) return MCP_QUERY_DIMENSIONS[4];
  return MCP_QUERY_DIMENSIONS[0];
}

/**
 * EpisodicEvent.userId / Note.userId 是 User 外键，系统写入必须保证对应 User 行存在。
 * 首次调用时自愈 upsert 一次并缓存结果；永不抛错（遥测非阻塞红线）。
 */
let systemUserReady: Promise<void> | null = null;

export async function recordMcpToolCall(params: RecordMcpToolCallParams): Promise<void> {
  try {
    const isBlindSpot = params.resultCount === 0;
    let pageUrl = 'mcp://global';
    if (params.repositoryId) {
      pageUrl = `mcp://repo/${params.repositoryId}`;
    } else if (params.bundleId) {
      pageUrl = `mcp://bundle/${params.bundleId}`;
    }

    const status = params.status ?? (isBlindSpot ? MCP_QUERY_STATUS[2] : MCP_QUERY_STATUS[0]);
    const dimension = params.dimension ?? deriveQueryDimension(params.toolName);

    // 遥测记录（隐私安全版 McpCallLog，取代已移除的 McpQueryLog/EpisodicEvent 写入）：
    // 只存工具名/仓库/维度/状态/命中数/耗时，不存原始查询词——
    // 保留「幻觉频率、盲点率、工具热度」观测面。调用者 id 落 userId 列
    // （不存外键、不含查询词），clientName 落归一化客户端列，
    // 支撑「用户只看自己的调用明细」与按客户端聚合的隔离查询。
    const effectiveUserId = params.userId ?? toolTelemetryContext.getStore()?.userId ?? null;
    const effectiveClientName = params.clientName ?? toolTelemetryContext.getStore()?.clientName ?? null;
    const store = toolTelemetryContext.getStore();
    const effectiveRequestedEdition = params.requestedEdition ?? store?.requestedEdition;
    const effectiveResolvedEdition = params.resolvedEdition ?? store?.resolvedEdition;
    const effectiveIsFallback = params.isFallback ?? store?.isFallback;
    const wireBody: Record<string, unknown> = {
      toolName: params.toolName,
      userId: effectiveUserId ?? undefined,
      clientName: effectiveClientName ?? undefined,
      repositoryId: params.repositoryId ?? undefined,
      bundleId: params.bundleId ?? undefined,
      dimension,
      status,
      resultCount: params.resultCount ?? 0,
      responseTimeMs: params.responseTimeMs ?? 0,
    };
    // 讲法/版本回退观测三件套：仅在有值时进 wire 契约（无回退调用零字段污染）
    if (effectiveRequestedEdition !== undefined) wireBody.requestedEdition = effectiveRequestedEdition;
    if (effectiveResolvedEdition !== undefined) wireBody.resolvedEdition = effectiveResolvedEdition;
    if (effectiveIsFallback !== undefined) wireBody.isFallback = effectiveIsFallback;
    callSidecar<{ ok: boolean }>(
      '/v1/telemetry/mcp-call-log',
      wireBody,
      { label: 'mcp-beacon' }
    )
      .then(() => {
        // 事件驱动在线状态：调用完成即推送（hit 口径与面板一致：SUCCESS 且有命中）
        if (effectiveUserId && effectiveClientName) {
          publishPresence({
            type: 'call',
            userId: effectiveUserId,
            clientName: effectiveClientName,
            status,
            hit: status === 'SUCCESS' && (params.resultCount ?? 0) > 0,
            at: Date.now(),
          });
        }
      })
      .catch(() => undefined);

    // Real-time counter increment for MCP tool invocations (Powers Badge System & Explore metrics)
    if (params.repositoryId) {
      await callSidecar(
        '/v1/repos/increment',
        { id: params.repositoryId, mcpCallCount: 1 },
        { label: 'mcp-beacon-increment-repo' }
      ).catch(() => {});
    } else if (params.bundleId) {
      const bundle = await prisma.mcpBundle.findUnique({
        where: { id: params.bundleId },
        select: { repositories: { select: { id: true } } },
      });
      if (bundle?.repositories && bundle.repositories.length > 0) {
        const repoIds = bundle.repositories.map(r => r.id);
        await callSidecar(
          '/v1/repos/increment',
          { ids: repoIds, mcpCallCount: 1 },
          { label: 'mcp-beacon-increment-repos' }
        ).catch(() => {});
      }
    }
  } catch (error) {
    // Non-blocking red-line: eat errors
  }
}

/**
 * 工具异常兜底上报：工具 handler 抛错时以 ERROR 状态补记一条最小遥测，
 * 保证失败调用不丢失（正常路径由调用方在工具内部上报完整上下文）。
 */
export function recordMcpToolError(params: {
  repositoryId?: string;
  bundleId?: string;
  toolName: string;
  query?: string;
  dimension?: string;
  responseTimeMs: number;
  errorMessage: string;
}): void {
  recordMcpToolCall({
    ...params,
    resultCount: 0,
    status: MCP_QUERY_STATUS[1],
  }).catch(() => {});
}

/**
 * 工具遥测包装器：统一异常兜底上报（ERROR 状态）并保留原始异常给 MCP SDK。
 * 正常路径的完整遥测仍由工具内部 recordMcpToolCall 上报（携带计时与快照）。
 *
 * 输出截断（Token 三层上限取小后执行）：用户级 singleCallTokenCap（传入 userId
 * 时）、工具入参 token_budget、admin 全局策略 GlobalMcpToolPolicy.tokenBudget
 * （传入 policyTokenCap 时）。任一约束存在即截断——保护服务端输出长度与
 * 上下文窗口预算。
 */
const TOKEN_CAP_DEFAULT = 4000;
const TOKEN_CAP_CACHE_TTL_MS = 60 * 1000;
const tokenCapCache = new Map<string, { cap: number; at: number }>();

async function resolveTokenCap(userId?: string): Promise<number> {
  if (!userId) return TOKEN_CAP_DEFAULT;
  const cached = tokenCapCache.get(userId);
  if (cached && Date.now() - cached.at < TOKEN_CAP_CACHE_TTL_MS) return cached.cap;
  const user = await prisma.user
    .findUnique({ where: { id: userId }, select: { singleCallTokenCap: true, role: true } })
    .catch(() => null);
  // ADMIN/SUPER_ADMIN 与限流器口径一致（放宽上限）
  const cap = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN' ? 32000 : (user?.singleCallTokenCap ?? TOKEN_CAP_DEFAULT);
  tokenCapCache.set(userId, { cap, at: Date.now() });
  return cap;
}

export function truncateToolOutput<R>(result: R, maxTokens: number): R {
  if (!result || typeof result !== 'object' || !Array.isArray((result as any).content)) return result;
  const content = (result as any).content as Array<{ type?: string; text?: unknown }>;
  let budget = maxTokens;
  (result as any).content = content.map((block) => {
    if (typeof block?.text !== 'string') return block;
    if (estimateTokens(block.text) <= budget) {
      budget -= estimateTokens(block.text);
      return block;
    }
    const truncated = { ...block, text: truncateToTokenBudget(block.text, Math.max(256, budget)) };
    budget = 0;
    return truncated;
  });
  return result;
}

export function wrapToolTelemetry<A extends Record<string, unknown>, R>(
  base: {
    repositoryId?: string;
    bundleId?: string;
    toolName: string;
    dimension?: string;
    userId?: string;
    /** admin 全局工具策略的 Token 预算（GlobalMcpToolPolicy.tokenBudget；未配置时不约束） */
    policyTokenCap?: number;
  },
  handler: (args: A, extra: unknown) => Promise<R>
): (args: A, extra: unknown) => Promise<R> {
  return async (args, extra) => {
    const startTime = Date.now();
    // 调用者注入工具遥测上下文：工具内部成功路径的 recordMcpToolCall 自动携带 userId，
    // 无需逐个工具透传（错误兜底路径经 recordMcpToolError({...base}) 已带）
    return toolTelemetryContext.run(
      // 保留外层（runWithMcpClientContext 注入的）clientName，只覆盖 userId
      { userId: base.userId, clientName: toolTelemetryContext.getStore()?.clientName },
      async () => {
      try {
        const result = await handler(args, extra);
        if (!Array.isArray((result as any)?.content)) return result;
        // 结构化遥测收割：handler 在结果上携带 telemetry 时由装饰器统一记录并剥除
        // （替代工具内 38 处手工 recordMcpToolCall；错误路径仍走下方 catch 兜底）
        const telemetry = (result as any)?.telemetry as ToolTelemetryHint | undefined;
        if (telemetry && typeof telemetry.resultCount === 'number') {
          recordMcpToolCall({
            repositoryId: base.repositoryId,
            bundleId: base.bundleId,
            toolName: base.toolName,
            dimension: telemetry.dimension ?? base.dimension,
            query: telemetry.query,
            expandedQuery: telemetry.expandedQuery,
            resultCount: telemetry.resultCount,
            status: telemetry.status,
            tokensSaved: telemetry.tokensSaved,
            tokensReturned: telemetry.tokensReturned,
            errorMessage: telemetry.errorMessage,
            resultSnapshot: telemetry.resultSnapshot ?? undefined,
            responseTimeMs: Date.now() - startTime,
          }).catch(() => {});
          delete (result as any).telemetry;
        }
        const caps: number[] = [];
        if (base.userId) caps.push(await resolveTokenCap(base.userId));
        const schemaBudget = typeof (args as any)?.token_budget === 'number' ? (args as any).token_budget : undefined;
        if (schemaBudget !== undefined && schemaBudget > 0) caps.push(schemaBudget);
        if (typeof base.policyTokenCap === 'number' && base.policyTokenCap > 0) caps.push(base.policyTokenCap);
        if (caps.length === 0) return result;
        return truncateToolOutput(result, Math.min(...caps));
      } catch (error) {
        recordMcpToolError({
          ...base,
          query: typeof args?.query === 'string' ? args.query : undefined,
          responseTimeMs: Date.now() - startTime,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      },
    );
  };
}

/**
 * 结构化遥测提示（鸭型契约，与 tools/shared.ts ToolTelemetry 字段一致；
 * 此处不复用类型以避免 telemetry → mcp-tools 的层次倒置）。
 */
interface ToolTelemetryHint {
  resultCount: number;
  status?: (typeof MCP_QUERY_STATUS)[number];
  dimension?: string;
  query?: string;
  expandedQuery?: string;
  tokensSaved?: number;
  tokensReturned?: number;
  resultSnapshot?: Prisma.InputJsonValue | null;
  errorMessage?: string;
}
