import { Prisma } from '@prisma/client';
import { ignoreBestEffort } from '@/lib/best-effort';
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
  userId?: string;
  clientName?: string;
  requestedEdition?: string;
  resolvedEdition?: string;
  isFallback?: boolean;
}

const toolTelemetryContext = new AsyncLocalStorage<{
  userId?: string;
  clientName?: string;
  requestedEdition?: string;
  resolvedEdition?: string;
  isFallback?: boolean;
}>();

export function runWithMcpClientContext<R>(clientName: string | undefined, fn: () => Promise<R>): Promise<R> {
  if (!clientName) return fn();
  return toolTelemetryContext.run({ clientName }, fn);
}

export function runWithMcpEditionContext<R>(
  edition: { requestedEdition?: string; resolvedEdition?: string; isFallback?: boolean } | undefined,
  fn: () => Promise<R>
): Promise<R> {
  if (!edition || (!edition.requestedEdition && !edition.resolvedEdition && !edition.isFallback)) return fn();
  const outer = toolTelemetryContext.getStore();
  return toolTelemetryContext.run({ ...outer, ...edition }, fn);
}

export function deriveQueryDimension(toolName: string): string {
  if (toolName.includes('architecture')) return MCP_QUERY_DIMENSIONS[1];
  if (toolName.includes('code')) return MCP_QUERY_DIMENSIONS[2];
  if (toolName.includes('gotcha')) return MCP_QUERY_DIMENSIONS[4];
  return MCP_QUERY_DIMENSIONS[0];
}

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
    if (effectiveRequestedEdition !== undefined) wireBody.requestedEdition = effectiveRequestedEdition;
    if (effectiveResolvedEdition !== undefined) wireBody.resolvedEdition = effectiveResolvedEdition;
    if (effectiveIsFallback !== undefined) wireBody.isFallback = effectiveIsFallback;
    callSidecar<{ ok: boolean }>(
      '/v1/telemetry/mcp-call-log',
      wireBody,
      { label: 'mcp-beacon' }
    )
      .then(() => {
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
      .catch(ignoreBestEffort);

    if (params.repositoryId) {
      await callSidecar(
        '/v1/repos/increment',
        { id: params.repositoryId, mcpCallCount: 1 },
        { label: 'mcp-beacon-increment-repo' }
      ).catch(ignoreBestEffort);
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
        ).catch(ignoreBestEffort);
      }
    }
  } catch (error) {
    ignoreBestEffort(error);
  }
}

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
  }).catch(ignoreBestEffort);
}

const TOKEN_CAP_DEFAULT = 4000;
const TOKEN_CAP_CACHE_TTL_MS = 60 * 1000;
const tokenCapCache = new Map<string, { cap: number; at: number }>();

async function resolveTokenCap(userId?: string): Promise<number> {
  if (!userId) return TOKEN_CAP_DEFAULT;
  const cached = tokenCapCache.get(userId);
  if (cached && Date.now() - cached.at < TOKEN_CAP_CACHE_TTL_MS) return cached.cap;
  const user = await prisma.user
    .findUnique({ where: { id: userId }, select: { singleCallTokenCap: true, role: true } })
    .catch(() => {
      ignoreBestEffort();
      return null;
    });
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
    policyTokenCap?: number;
  },
  handler: (args: A, extra: unknown) => Promise<R>
): (args: A, extra: unknown) => Promise<R> {
  return async (args, extra) => {
    const startTime = Date.now();
    return toolTelemetryContext.run(
      { userId: base.userId, clientName: toolTelemetryContext.getStore()?.clientName },
      async () => {
      try {
        const result = await handler(args, extra);
        if (!Array.isArray((result as any)?.content)) return result;
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
          }).catch(ignoreBestEffort);
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
