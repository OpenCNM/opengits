import { NextRequest, NextResponse } from 'next/server';
import { McpServer } from '@modelcontextprotocol/server';
import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { searchBundleDocs } from '@/lib/mcp/bundle-search';
import { recordMcpToolCall, wrapToolTelemetry } from '@/lib/telemetry/mcp-beacon';
import { registerRepositoryTools } from '@/lib/mcp/repo-tools';
import { resolveRepositoryMcpCached } from '@/lib/mcp/repo-resolve-cache';
import { RepoContext, RepoRuntime } from '@/lib/mcp/tools/shared';
import { runOutline } from '@/lib/mcp/tools/outline';
import { runExploreConcept } from '@/lib/mcp/tools/concepts';
import { runSearch as runScopedSearch } from '@/lib/mcp/tools/search';
import { runBreakingChanges } from '@/lib/mcp/tools/maintenance';
import { runSearchSymbols } from '@/lib/mcp/tools/symbol';
import { recordMcpClientPresence } from '@/lib/mcp/mcp-heartbeat';
import { runWithMcpClientContext } from '@/lib/telemetry/mcp-beacon';
import { getCorsHeaders, DIMENSION_TO_CONTENT_TYPES } from '@/lib/constants';
import { installUnknownToolFallback } from '@/lib/mcp/unknown-tool-fallback';
import { enforceMcpAuth, enforceMcpAuthAndQuota } from '@/lib/mcp/request-guard';
import { getGlobalToolPolicies } from '@/lib/mcp/mcp-tools-manager';
import { meetsTierRequirement, isAdminRole } from '@/lib/tiers';
import { MCP_AVAILABLE_TOOLS } from '@/lib/mcp/capability-manifest';
import { BUNDLE_TOOL_CONTRACTS } from '@/lib/mcp/tool-contracts';
import { normalizeMcpToolCallRequest } from '@/lib/mcp/request-normalizer';
import { readBodyJson } from '@/lib/mcp/body-json';
import { MCP_MAX_TOOL_INPUT_ELEMENTS } from '@/lib/constants';
import { ignoreBestEffort } from '@/lib/best-effort';

class StatelessDirectTransport {
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private responsePromise: Promise<unknown>;
  private resolveResponse!: (msg: unknown) => void;

  constructor() {
    this.responsePromise = new Promise((resolve) => {
      this.resolveResponse = resolve;
    });
  }

  async start(): Promise<void> {}
  async close(): Promise<void> {
    // SDK Protocol.close() requires transport.onclose() to clear internal state before pool reuse.
    this.onclose?.();
  }
  async send(message: unknown): Promise<void> {
    this.resolveResponse(message);
  }

  async receive(requestMessage: unknown): Promise<unknown> {
    if (this.onmessage) {
      this.onmessage(requestMessage);
    }
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Tool execution timeout after 25s')), 25000);
    });
    try {
      return await Promise.race([this.responsePromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function corsHeaders() {
 return getCorsHeaders('GET, POST, OPTIONS');
}

interface CachedMcpBundleRepo {
  id: string;
  owner: string;
  repo: string;
  category: string | null;
  starCount: number;
  isVerified?: boolean;
}

export interface CachedMcpBundle {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  repositories: CachedMcpBundleRepo[];
}

const BUNDLE_META_TTL_MS = 60_000;
const bundleMetaCache = new Map<string, { data: CachedMcpBundle; expiresAt: number }>();

export async function cachedMcpBundle(bundleId: string): Promise<CachedMcpBundle | null> {
  const now = Date.now();
  const cached = bundleMetaCache.get(bundleId);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const bundle = await prisma.mcpBundle.findFirst({
    where: {
      OR: [{ id: bundleId }, { slug: bundleId }],
    },
    include: {
      repositories: {
        where: { mcpStatus: { not: 'PAUSED' }, isPublic: true },
        select: { id: true, owner: true, repo: true, category: true, starCount: true, isVerified: true },
      },
    },
  });

  if (!bundle) {
    return null;
  }

  const data: CachedMcpBundle = {
    id: bundle.id,
    slug: bundle.slug,
    title: bundle.title,
    description: bundle.description,
    repositories: bundle.repositories,
  };

  const entry = { data, expiresAt: now + BUNDLE_META_TTL_MS };
  bundleMetaCache.set(bundleId, entry);
  if (bundle.id) bundleMetaCache.set(bundle.id, entry);
  if (bundle.slug) bundleMetaCache.set(bundle.slug, entry);

  if (bundleMetaCache.size > 200) {
    const oldestKey = bundleMetaCache.keys().next().value;
    if (oldestKey) bundleMetaCache.delete(oldestKey);
  }

  return data;
}

export function clearBundleMetaCacheForTest() {
  bundleMetaCache.clear();
}

interface PooledServerEntry {
  server: McpServer;
  createdAt: number;
}

const SERVER_POOL_TTL_MS = 60_000;
const MAX_POOL_PER_KEY = 5;
const serverPoolMap = new Map<string, PooledServerEntry[]>();

export function getPooledServer(poolKey: string): McpServer | null {
  const pool = serverPoolMap.get(poolKey);
  if (!pool || pool.length === 0) return null;
  const now = Date.now();
  while (pool.length > 0) {
    const entry = pool.pop()!;
    if (now - entry.createdAt < SERVER_POOL_TTL_MS) {
      return entry.server;
    }
  }
  return null;
}

export function releasePooledServer(poolKey: string, server: McpServer) {
  let pool = serverPoolMap.get(poolKey);
  if (!pool) {
    pool = [];
    serverPoolMap.set(poolKey, pool);
  }
  if (pool.length < MAX_POOL_PER_KEY) {
    pool.push({ server, createdAt: Date.now() });
  }
  if (serverPoolMap.size > 100) {
    const oldestKey = serverPoolMap.keys().next().value;
    if (oldestKey) serverPoolMap.delete(oldestKey);
  }
}

export function clearServerPoolForTest() {
  serverPoolMap.clear();
}

function createBundleRepoRuntime(bundle: CachedMcpBundle, userId?: string): RepoRuntime {
  const resolveByRef = async (ref: string): Promise<RepoContext | null> => {
    const base = ref.split('@')[0];
    const at = ref.lastIndexOf('@');
    const edition = at > 0 ? ref.slice(at + 1) : undefined;
    const parts = base.split('/');
    for (const r of bundle.repositories) {
      const matchById = r.id === base;
      const matchByName = parts.length === 2 &&
        r.owner.toLowerCase() === parts[0].toLowerCase() &&
        r.repo.toLowerCase() === parts[1].toLowerCase();
      if (!matchById && !matchByName) continue;
      const resolved = await resolveRepositoryMcpCached(r.owner, r.repo, undefined, edition, userId);
      if (!resolved?.repository) return null;
      if (edition && resolved.editionMiss) return null;
      return {
        owner: resolved.repository.owner,
        repo: resolved.repository.repo,
        repository: resolved.repository,
        targetVersionLabel: resolved.targetVersionLabel,
        edition: resolved.repository.edition ?? '',
        isFallback: resolved.isFallback,
        requestedEdition: edition,
      };
    }
    return null;
  };

  return {
    label: `bundle ${bundle.title || bundle.id}`,
    multiRepo: true,
    userId,
    resolveRepository: (ref?: string) => (ref ? resolveByRef(ref) : Promise.resolve(null)),
    listRepositories: async () => {
      const ctxs = await Promise.all(
        bundle.repositories.map((r) =>
          resolveRepositoryMcpCached(r.owner, r.repo, undefined, undefined, userId).then(
            (resolved): RepoContext | null =>
              resolved?.repository
                ? {
                    owner: resolved.repository.owner,
                    repo: resolved.repository.repo,
                    repository: resolved.repository,
                    targetVersionLabel: resolved.targetVersionLabel,
                    edition: resolved.repository.edition ?? '',
                    isFallback: resolved.isFallback,
                  }
                : null
          )
        )
      );
      return ctxs.filter((c): c is RepoContext => c !== null);
    },
  };
}

export async function createBundleMcpServer(
  bundle: CachedMcpBundle,
  userTier: string | null,
  userId: string | undefined,
  userIsAdmin: boolean,
  policyMap: Map<string, any>
): Promise<McpServer> {
  const server = new McpServer({
    name: `opengits-bundle-${bundle.slug || bundle.id}`,
    version: '1.0.0',
  }, { maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS });

  const isToolEnabled = (name: string) => {
    const policy = policyMap.get(name);
    if (policy?.isEnabled === false) return false;
    return meetsTierRequirement(userTier, policy?.tierRequirement, userIsAdmin);
  };
  const policyTokenCap = (name: string): number | undefined => {
    const budget = policyMap.get(name)?.tokenBudget;
    return typeof budget === 'number' && budget > 0 ? budget : undefined;
  };

  const runBundleSearch = async (query: string, dimension: 'all' | 'architecture' | 'code' | 'gotcha' | 'documents') => {
    const startTime = Date.now();
    const contentTypes = DIMENSION_TO_CONTENT_TYPES[dimension] ?? (dimension === 'all' ? undefined : [dimension]);
    const results = await searchBundleDocs(bundle.id, query, 3, 10, contentTypes);
    let outputText = `Bundle Search Results for "${query}"${dimension === 'all' ? '' : ` [${dimension}]`} across ${bundle.title}:\n\n`;
    let tokenReturnedEstimate = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      outputText += `--- Result ${i + 1} (${r.owner}/${r.repo} | Score: ${(r.similarity * 100).toFixed(1)}%) ---\n`;
      outputText += `Document: ${r.title || r.path} [Path: ${r.path}]\n`;
      if (r.heading) {
        outputText += `Section Heading: ${r.heading}\n`;
      }
      outputText += `\n${r.content}\n\n`;
      tokenReturnedEstimate += Math.floor((r.content.length) / 4);
    }
    recordMcpToolCall({ bundleId: bundle.id, userId, toolName: 'search', query, resultCount: results.length, dimension, tokensReturned: tokenReturnedEstimate, responseTimeMs: Date.now() - startTime, resultSnapshot: { count: results.length, items: results.slice(0, 5).map(r => ({ path: r.path, title: r.title, score: r.similarity })) } }).catch(ignoreBestEffort);
    if (results.length === 0) {
      return {
        content: [{ type: 'text' as const, text: `No relevant knowledge chunks found across the bundle for query: "${query}". Try browse() to see included packages.` }],
      };
    }
    return { content: [{ type: 'text' as const, text: outputText }] };
  };

  const bundleRuntime = createBundleRepoRuntime(bundle, userId);

  if (isToolEnabled('browse')) {
    server.registerTool(
      'browse',
      {
        description: BUNDLE_TOOL_CONTRACTS.find((c) => c.name === 'browse')!.description,
        inputSchema: BUNDLE_TOOL_CONTRACTS.find((c) => c.name === 'browse')!.schema,
      },
      wrapToolTelemetry(
        { bundleId: bundle.id, userId, toolName: 'browse', dimension: 'documents', policyTokenCap: policyTokenCap('browse') },
        async (args: any) => {
          const rawRepo = typeof args.repository === 'string' ? args.repository.trim() : '';
          const scopedRepo =
            rawRepo && args.edition && !rawRepo.includes('@')
              ? `${rawRepo}@${String(args.edition).trim()}`
              : rawRepo;
          const view = typeof args.view === 'string' ? args.view.toLowerCase().trim() : 'outline';

          if (scopedRepo) {
            if ((view === 'architecture' || view === 'course_map') && (!args.path || view === 'architecture')) {
              return runExploreConcept(
                {
                  repository: scopedRepo,
                  action: view === 'architecture' ? 'architecture' : 'course_map',
                  concept: view === 'architecture' ? (args.path || args.query) : undefined,
                },
                bundleRuntime,
                bundle.id
              );
            }
            return runOutline({ repository: scopedRepo, path: args.path }, bundleRuntime, bundle.id);
          }

          const catFilter = typeof args.category === 'string' ? args.category.trim().toLowerCase() : '';
          const qFilter = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
          const matched = bundle.repositories.filter((r) => {
            if (catFilter && !(r.category || '').toLowerCase().includes(catFilter)) return false;
            if (qFilter && !`${r.owner}/${r.repo}`.toLowerCase().includes(qFilter)) return false;
            return true;
          });
          let text = `Repositories included in bundle "${bundle.title}" (${bundle.slug || bundle.id}):\n\n`;
          for (const r of matched) {
            text += `- ${r.owner}/${r.repo} [Category: ${r.category || 'General'}, Stars: ${r.starCount}, Verified: ${r.isVerified ? 'Yes' : 'No'}]\n`;
          }
          if (matched.length === 0) {
            text += '(No matching repositories in this bundle.)\n';
          }
          return {
            content: [{ type: 'text' as const, text }],
          };
        }
      )
    );
  }

  if (isToolEnabled('search')) {
    server.registerTool(
      'search',
      {
        description: BUNDLE_TOOL_CONTRACTS.find((c) => c.name === 'search')!.description,
        inputSchema: BUNDLE_TOOL_CONTRACTS.find((c) => c.name === 'search')!.schema,
      },
      wrapToolTelemetry(
        { bundleId: bundle.id, userId, toolName: 'search', dimension: 'all', policyTokenCap: policyTokenCap('search') },
        async (args: any, extra: any) => {
          const rawFilter = typeof args.filter === 'string'
            ? args.filter
            : typeof args.mode === 'string'
              ? args.mode
              : typeof args.dimension === 'string'
                ? args.dimension
                : 'all';
          const effectiveFilter = rawFilter.toLowerCase().trim() || 'all';
          const rawRepo = typeof args.repository === 'string' ? args.repository.trim() : '';
          const scopedRepo =
            rawRepo && args.edition && !rawRepo.includes('@')
              ? `${rawRepo}@${String(args.edition).trim()}`
              : rawRepo;

          if (effectiveFilter === 'symbols' || effectiveFilter === 'symbol') {
            return runSearchSymbols(
              {
                repository: scopedRepo || undefined,
                query: args.query,
                file: args.file,
                limit: args.limit,
                role: args.role,
              },
              bundleRuntime,
              bundle.id
            );
          }

          const query = typeof args.query === 'string' ? args.query.trim() : '';
          if (!query) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: "query" is required unless filter="symbols".',
                },
              ],
              isError: true,
            };
          }

          if (scopedRepo) {
            if (effectiveFilter === 'gotchas' || effectiveFilter === 'gotcha' || effectiveFilter === 'warning') {
              return runBreakingChanges(
                {
                  repository: scopedRepo,
                  query,
                  limit: args.limit,
                  detail: args.detail === 'full' ? 'full' : 'locator',
                  token_budget: args.token_budget,
                },
                extra,
                bundleRuntime
              );
            }
            return runScopedSearch(
              { ...args, repository: scopedRepo, query, filter: effectiveFilter },
              extra,
              bundleRuntime
            );
          }

          const fanoutDim: 'all' | 'architecture' | 'code' | 'gotcha' =
            effectiveFilter === 'gotchas' || effectiveFilter === 'gotcha' || effectiveFilter === 'warning'
              ? 'gotcha'
              : effectiveFilter === 'architecture' || effectiveFilter === 'code'
                ? effectiveFilter
                : 'all';
          return runBundleSearch(query, fanoutDim);
        }
      )
    );
  }

  await registerRepositoryTools(server, bundleRuntime, {
    skip: ['browse', 'search'],
  });

  installUnknownToolFallback(server, { label: `bundle ${bundle.title || bundle.id}` });
  return server;
}

export async function GET(
 request: NextRequest,
 { params }: { params: Promise<{ bundleId: string }> }
) {
 try {
 const guard = await enforceMcpAuth(request, { cors: corsHeaders() });
 if (guard.response) return guard.response;
 const { bundleId } = await params;
 if (!bundleId || typeof bundleId !== 'string' || !bundleId.trim()) {
 return NextResponse.json({ error: 'Invalid bundleId' }, { status: 400, headers: corsHeaders() });
 }
 const bundle = await cachedMcpBundle(bundleId);

 if (!bundle) {
 return NextResponse.json({ error: 'McpBundle not found' }, { status: 404, headers: corsHeaders() });
 }

 return NextResponse.json({
 name: `opengits-bundle-${bundle.slug || bundle.id}`,
 version: '1.0.0',
 description: bundle.description || `MCP Bundle containing ${bundle.repositories.length} verified repositories`,
 status: 'READY',
 repositoriesCount: bundle.repositories.length,
 repositories: bundle.repositories.map(r => `${r.owner}/${r.repo}`),
 endpoints: {
 rpc: `/api/mcp/bundle/${bundle.slug || bundle.id}`,
 },
 capabilities: {
  tools: [...MCP_AVAILABLE_TOOLS],
 },
 }, {
 status: 200,
 headers: corsHeaders(),
 });
 } catch (error) {
 console.error('Error in GET /api/mcp/bundle:', error);
 return NextResponse.json({ error: 'Internal Server Error' }, { status: 500, headers: corsHeaders() });
 }
}

export async function OPTIONS() {
 return new NextResponse(null, {
 status: 204,
 headers: corsHeaders(),
 });
}

export async function POST(
 request: NextRequest,
 { params }: { params: Promise<any> }
) {
 try {
  const guard = await enforceMcpAuthAndQuota(request, { rpc: true, cors: corsHeaders() });
  if (guard.response) return guard.response;
  const userId = guard.userId;

  const clientHeader = request.headers.get('x-mcp-client-name') || request.headers.get('user-agent') || 'Unknown Client';
  const clientName = recordMcpClientPresence(
    userId,
    clientHeader,
    request.headers.get('x-forwarded-for')?.split(',')[0] || undefined,
  );

  const { bundleId } = await params;
  if (!bundleId || typeof bundleId !== 'string' || !bundleId.trim()) {
 return NextResponse.json(
 { jsonrpc: '2.0', error: { code: -32602, message: 'Invalid bundleId parameter' }, id: null },
 { status: 400, headers: corsHeaders() }
 );
 }
  const bundle = await cachedMcpBundle(bundleId);

  if (!bundle) {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'McpBundle not found' }, id: null },
      { status: 404, headers: corsHeaders() }
    );
  }

 const normalized = await normalizeMcpToolCallRequest(
 request,
 MCP_AVAILABLE_TOOLS,
 `bundle ${bundle.slug || bundle.id}`
 );
 if (normalized.directResponse) return normalized.directResponse;

 let body: any;
 try {
 body = await readBodyJson(normalized.request);
 } catch (parseErr) {
 return NextResponse.json(
 { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: malformed JSON' }, id: null },
 { status: 400, headers: corsHeaders() }
 );
 }

 if (!body || typeof body !== 'object' || !body.method) {
 return NextResponse.json(
 { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid JSON-RPC Request' }, id: body?.id ?? null },
 { status: 400, headers: corsHeaders() }
 );
 }

    const policyMap = await getGlobalToolPolicies();
    let userTier: string | null = null;
    let userIsAdmin = false;
    if (userId) {
      const user = await prisma.user
        .findUnique({ where: { id: userId }, select: { tier: true, role: true } })
        .catch(() => null);
      userTier = user?.tier ?? null;
      userIsAdmin = isAdminRole(user?.role);
    }

    const poolKey = `${bundle.id}:${userTier ?? 'anon'}:${userId ?? 'anon'}`;
    let server = getPooledServer(poolKey);
    if (!server) {
      server = await createBundleMcpServer(bundle, userTier, userId, userIsAdmin, policyMap);
    }

    const transport = new StatelessDirectTransport();
    await server.connect(transport);
    const responseMessage = await runWithMcpClientContext(clientName, () => transport.receive(body));
    await server.close();

    releasePooledServer(poolKey, server);

    callSidecar('/v1/mcp/bundles/use', { bundleId: bundle.id }, { label: 'increment bundle use' }).catch(ignoreBestEffort);

    return NextResponse.json(responseMessage, { status: 200, headers: corsHeaders() });
 } catch (error: any) {
 console.error('Error handling JSON-RPC POST in /api/mcp/bundle:', error);
 return NextResponse.json(
 { jsonrpc: '2.0', error: { code: -32603, message: error?.message || 'Internal Server Error' }, id: null },
 { status: 500, headers: corsHeaders() }
 );
 }
}
