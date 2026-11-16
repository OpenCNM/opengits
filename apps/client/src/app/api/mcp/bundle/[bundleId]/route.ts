import { NextRequest, NextResponse } from 'next/server';
import { McpServer } from '@modelcontextprotocol/server';
import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { searchBundleDocs } from '@/lib/mcp/bundle-search';
import { recordMcpToolCall, wrapToolTelemetry } from '@/lib/telemetry/mcp-beacon';
import { registerRepositoryTools } from '@/lib/mcp/repo-tools';
import { resolveRepositoryMcpCached } from '@/lib/mcp/repo-resolve-cache';
import { RepoContext, RepoRuntime } from '@/lib/mcp/tools/shared';
import { capFullDocText } from '@/lib/mcp/repo-tools';
import { applyContentLayerRead } from '@/lib/content-addressing';
import { recordMcpClientPresence } from '@/lib/mcp/mcp-heartbeat';
import { runWithMcpClientContext } from '@/lib/telemetry/mcp-beacon';
import { getCorsHeaders, DIMENSION_TO_CONTENT_TYPES } from '@/lib/constants';
import { installUnknownToolFallback } from '@/lib/mcp/unknown-tool-fallback';
import { enforceMcpAuth, enforceMcpAuthAndQuota } from '@/lib/mcp/request-guard';
import { getGlobalToolPolicies } from '@/lib/mcp/mcp-tools-manager';
import { meetsTierRequirement, isAdminRole } from '@/lib/tiers';
// 与单仓/Hub 统一的工具清单：bundle 端点不再维护 legacy 私有名（search_docs 等）
import { MCP_AVAILABLE_TOOLS } from '@/lib/mcp/capability-manifest';
import { BUNDLE_TOOL_CONTRACTS } from '@/lib/mcp/tool-contracts';
import { normalizeMcpToolCallRequest } from '@/lib/mcp/request-normalizer';
import { readBodyJson } from '@/lib/mcp/body-json';
import { MCP_MAX_TOOL_INPUT_ELEMENTS } from '@/lib/constants';

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
    // SDK 2.3+ 的 Protocol.close() 依赖 transport 触发 onclose 清除内部
    // transport 引用；不触发则池化 server 复用时 connect() 抛 ALREADY_CONNECTED
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

// Bundle 特化工具契约（名称/描述/schema 单一事实源）：@/lib/mcp/tool-contracts BUNDLE_TOOL_CONTRACTS

// ── Bundle 元数据轻量级 60s TTL 缓存 ──
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

// ── McpServer 实例池化机制（切除 90% 重复 new McpServer 与闭包分配）──
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

/**
 * Bundle 限定 RepoRuntime：resolveRepository/listRepositories 仅解析 bundle 内
 * （cachedMcpBundle 已过滤 PAUSED/非公开）的仓库；深工具（outline/read/explore_concept/
 * read_symbol/search_symbols/read_source_file）由共享工厂注册，与单仓/Hub 同一实现。
 */
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
      // 显式 @edition 未命中时宁可报「未找到」也不静默回退基础行（镜像 hub 守卫；Agent 的讲法意图必须被尊重）
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

  /** 统一 bundle 检索工具体：按 dimension 过滤扇出 FTS */
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
    recordMcpToolCall({ bundleId: bundle.id, userId, toolName: 'search', query, resultCount: results.length, dimension, tokensReturned: tokenReturnedEstimate, responseTimeMs: Date.now() - startTime, resultSnapshot: { count: results.length, items: results.slice(0, 5).map(r => ({ path: r.path, title: r.title, score: r.similarity })) } }).catch(() => {});
    if (results.length === 0) {
      return {
        content: [{ type: 'text' as const, text: `No relevant knowledge chunks found across the bundle for query: "${query}". Try list_repositories to see included packages.` }],
      };
    }
    return { content: [{ type: 'text' as const, text: outputText }] };
  };

  // ── 与单仓/Hub 统一的 6 工具注册（capability-manifest 同源名单）──

  if (isToolEnabled('list_resources')) {
    server.registerTool(
      'list_resources',
      {
        description: `List all ${bundle.repositories.length} repositories included in this MCP Bundle (${bundle.title}).`,
        inputSchema: BUNDLE_TOOL_CONTRACTS.find((c) => c.name === 'list_resources')!.schema,
      },
      wrapToolTelemetry(
        { bundleId: bundle.id, userId, toolName: 'list_resources', dimension: 'all', policyTokenCap: policyTokenCap('list_resources') },
        async () => {
          let text = `Repositories included in bundle "${bundle.title}" (${bundle.slug || bundle.id}):\n\n`;
          for (const r of bundle.repositories) {
            text += `- ${r.owner}/${r.repo} [Category: ${r.category || 'General'}, Stars: ${r.starCount}, Verified: ${r.isVerified ? 'Yes' : 'No'}]\n`;
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
        description: `Fan-out FTS search across all ${bundle.repositories.length} repositories in this MCP Bundle (${bundle.title}). Filter by dimension: architecture / code / gotcha.`,
        inputSchema: BUNDLE_TOOL_CONTRACTS.find((c) => c.name === 'search')!.schema,
      },
      wrapToolTelemetry(
        { bundleId: bundle.id, userId, toolName: 'search', dimension: 'all', policyTokenCap: policyTokenCap('search') },
        async ({ query, dimension }: any) => {
          if (!query || typeof query !== 'string' || !query.trim()) {
            return { content: [{ type: 'text' as const, text: 'Error: Query cannot be empty.' }], isError: true };
          }
          return runBundleSearch(query, dimension ?? 'all');
        }
      )
    );
  }

  if (isToolEnabled('read_document')) {
    server.registerTool(
      'read_document',
      {
        description: BUNDLE_TOOL_CONTRACTS.find((c) => c.name === 'read_document')!.description,
        inputSchema: BUNDLE_TOOL_CONTRACTS.find((c) => c.name === 'read_document')!.schema,
      },
      wrapToolTelemetry(
        { bundleId: bundle.id, userId, toolName: 'read_document', dimension: 'documents', policyTokenCap: policyTokenCap('read_document') },
        async ({ repository, path }: any) => {
          const startTime = Date.now();
          if (!repository || typeof repository !== 'string' || !repository.trim() || !path || typeof path !== 'string' || !path.trim()) {
            return {
              content: [{ type: 'text' as const, text: 'Error: Repository and path cannot be empty.' }],
              isError: true,
            };
          }

          const [owner, repo] = repository.split('/');
          if (!owner || !repo) {
            return {
              content: [{ type: 'text' as const, text: 'Error: repository must be in "owner/repo" format.' }],
              isError: true,
            };
          }

          const repoMeta = bundle.repositories.find(
            r => r.owner.toLowerCase() === owner.toLowerCase() && r.repo.toLowerCase() === repo.toLowerCase()
          );

          if (!repoMeta) {
            return {
              content: [{ type: 'text' as const, text: `Error: Repository "${repository}" is not included in this bundle.` }],
              isError: true,
            };
          }

          const doc = await prisma.document.findFirst({
            where: {
              repositoryId: repoMeta.id,
              status: 'PROCESSED',
              ownerUserId: null,
              OR: [
                { path: { equals: path, mode: 'insensitive' } },
                { path: { equals: `${path}.md`, mode: 'insensitive' } },
                { path: { equals: `${path}.mdx`, mode: 'insensitive' } },
              ],
            },
            select: { title: true, path: true, content: true, contentId: true, contentRef: { select: { content: true } } },
          });

          const docContent = doc ? applyContentLayerRead(doc).content : null;

          if (!doc || !docContent) {
            recordMcpToolCall({ bundleId: bundle.id, userId, toolName: 'read_document', query: path, resultCount: 0, dimension: 'documents', responseTimeMs: Date.now() - startTime }).catch(() => {});
            return {
              content: [{ type: 'text' as const, text: `Error: Document "${path}" not found in ${repository}.` }],
              isError: true,
            };
          }

          return {
            telemetry: { query: path, resultCount: 1, dimension: 'documents', tokensReturned: Math.floor(docContent.length / 4) },
            content: [
              {
                type: 'text' as const,
                text: `# ${doc.title || doc.path}\nRepository: ${repository}\nSource Path: ${doc.path}\n\n${capFullDocText(docContent)}`,
              },
            ],
          };
        }
      )
    );
  }

  if (isToolEnabled('check_breaking_changes')) {
    server.registerTool(
      'check_breaking_changes',
      {
        description: BUNDLE_TOOL_CONTRACTS.find((c) => c.name === 'check_breaking_changes')!.description,
        inputSchema: BUNDLE_TOOL_CONTRACTS.find((c) => c.name === 'check_breaking_changes')!.schema,
      },
      wrapToolTelemetry(
        { bundleId: bundle.id, userId, toolName: 'check_breaking_changes', dimension: 'documents', policyTokenCap: policyTokenCap('check_breaking_changes') },
        async ({ query }: any) => {
          if (!query || typeof query !== 'string' || !query.trim()) {
            return { content: [{ type: 'text' as const, text: 'Error: Query cannot be empty.' }], isError: true };
          }
          return runBundleSearch(query, 'gotcha');
        }
      )
    );
  }

  // 深工具补齐：共享工厂注册 outline/read/explore_concept/read_symbol/search_symbols/
  // read_source_file（与单仓/Hub 同一实现）；skip 四个 bundle 特化工具（上方本文件注册）
  await registerRepositoryTools(server, createBundleRepoRuntime(bundle, userId), {
    skip: ['list_resources', 'search', 'read_document', 'check_breaking_changes'],
  });

  installUnknownToolFallback(server, { label: `bundle ${bundle.title || bundle.id}` });
  return server;
}

export async function GET(
 request: NextRequest,
 { params }: { params: Promise<{ bundleId: string }> }
) {
 try {
 // 产品规则：MCP 必须登录（未登录仅可浏览公开教程）；支持 Bearer API Token 与 Web 会话双通道
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
  // 与 repo-tools 注册表同源（capability-manifest），不在此维护第二份名单
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
  // 鉴权 + 配额统一守卫（Bearer token / session 双通道 → 封禁 / RPM / 每日配额；历史仅查登录）
  const guard = await enforceMcpAuthAndQuota(request, { rpc: true, cors: corsHeaders() });
  if (guard.response) return guard.response;
  const userId = guard.userId;

  // Heartbeat tracking + 即时 presence 事件（与单仓/Hub 路由同款：Dashboard MCP 客户端面板数据源）
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

 // 网关层请求规范化（别名透明重写与未知工具短路响应，零 monkey patch；与单仓/Hub 路由同款）
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

    // 全局工具策略与 tier 门禁（与单仓 repo-tools 同一实现）；
    // 失效封闭：策略表加载失败直接上抛（本路由外层 catch 统一转 -32603），不得降级为空表放行
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
    // 客户端名注入遥测上下文：工具调用落 McpCallLog.clientName + call 事件
    const responseMessage = await runWithMcpClientContext(clientName, () => transport.receive(body));
    await server.close();

    releasePooledServer(poolKey, server);

    // Increment use count asynchronously via Go single writer
    callSidecar('/v1/mcp/bundles/use', { bundleId: bundle.id }, { label: 'increment bundle use' }).catch(() => {});

    return NextResponse.json(responseMessage, { status: 200, headers: corsHeaders() });
 } catch (error: any) {
 console.error('Error handling JSON-RPC POST in /api/mcp/bundle:', error);
 // 与单仓路由的 JSON-RPC 错误约定一致：HTTP 500 + -32603 内部错误
 return NextResponse.json(
 { jsonrpc: '2.0', error: { code: -32603, message: error?.message || 'Internal Server Error' }, id: null },
 { status: 500, headers: corsHeaders() }
 );
 }
}
