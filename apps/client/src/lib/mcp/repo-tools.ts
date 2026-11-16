/**
 * repo-tools 组装入口（原单文件 repo-tools.ts 按工具域拆分后的注册门面）。
 * 职责：完成全部 MCP 核心工具（13 个，见 MCP_AVAILABLE_TOOLS）在 McpServer 上的注册
 * （tier 门禁 / 工具策略 / 遥测归属）。各工具域实现已迁入 ./tools/*：
 * - shared.ts      跨域共享类型与辅助
 * - resources.ts   list_resources
 * - search.ts      search（单仓精搜 + Hub fan-out）
 * - document.ts    read_document（get_document / read_section / list_documents）
 * - concepts.ts    explore_concept（概念图 / 依赖 / 课程图）
 * - maintenance.ts check_breaking_changes
 * 本文件原样 re-export 原 repo-tools.ts 的全部导出符号，外部消费方 import 路径零变化。
 */
import { McpServer } from '@modelcontextprotocol/server';
import { prisma } from '@/lib/db';
import { TtlCache } from '@/lib/cache/ttl-cache';
import {
  getGlobalToolPolicies,
} from '@/lib/mcp/mcp-tools-manager';
import { wrapToolTelemetry } from '@/lib/telemetry/mcp-beacon';
import { contractDescription, contractSchema } from '@/lib/mcp/tool-contracts';
import { MCP_QUERY_MIN_LENGTH } from '@/lib/constants';
import { RepoRuntime } from './tools/shared';
import { runListResources } from './tools/resources';
import { runSearch } from './tools/search';
import { runReadDocument } from './tools/document';
import { runExploreConcept } from './tools/concepts';
import { runBreakingChanges } from './tools/maintenance';
import { runOutline } from './tools/outline';
import { runRead } from './tools/read';
import { runReadSymbol, runSearchSymbols } from './tools/symbol';
import { runReadSourceFile } from './tools/source-file';
import { runListChapterVersions } from './tools/versions';
import { runDissectCode } from './tools/dissect';
import { runVerifyClaim } from './tools/verify-claim';

// ── 原 repo-tools.ts 导出符号 re-export：保持 '@/lib/mcp/repo-tools' 路径零变化 ──
export { repositoryDocsInclude } from './tools/shared';
export type { RepoContext, RepoRuntime } from './tools/shared';
export {
  capFullDocText,
  fetchDocumentContent,
  formatNavTree,
  findDocInContext,
  runOutline,
  runRead,
} from './tools/document';

/**
 * ─────────────────────────────────────────────────────────────
 * 共享单仓工具工厂（repo-tools）
 *
 * 单仓深度工具在「单仓 MCP」与「OpenGits Hub MCP」两处复用同一套实现：
 * - 单仓模式（multiRepo=false）：工具绑定到唯一仓库
 * - Hub 模式（multiRepo=true）：搜索类工具接受可选 repository 参数——
 *   传了则单仓精搜，不传则跨全库 fan-out 返回带归因的 locator 结果；
 *   文档定位类工具要求必传 repository
 * ─────────────────────────────────────────────────────────────
 */

/** 用户 tier/role 热路径缓存：stateless 每请求重建工具注册都要查一次（读多写少，60s TTL） */
const userTierCache = new TtlCache<{ tier: string | null; role: string | null } | null>();

// -------------------------------------------------------------
// 注册入口
// -------------------------------------------------------------

/**
 * 将全部 MCP 核心工具（与 capability-manifest MCP_AVAILABLE_TOOLS 锁步）注册到目标 McpServer。
 * 单仓模式与 Hub 模式通过 runtime.multiRepo 区分工具签名与行为。
 */
export interface RegisterRepositoryToolsOptions {
  /** 跳过指定工具名的注册（端点已自带特化实现时使用，如 Bundle 的 4 个专有工具） */
  skip?: string[];
}

export async function registerRepositoryTools(
  server: McpServer,
  runtime: RepoRuntime,
  opts?: RegisterRepositoryToolsOptions
): Promise<void> {
  const skip = new Set(opts?.skip ?? []);
  // 单仓模式下解析出绑定仓库用于遥测归属；Hub 模式下为 null（由 handler 内部按实际解析仓库上报）
  const primaryCtx = await runtime.resolveRepository();
  const telemetryId = primaryCtx?.repository.id;

  // 失效封闭：策略表加载失败直接上抛（DB 故障 → 路由 500），不得降级为空表放行全部工具
  const policyMap = await getGlobalToolPolicies();

  // 工具级 tier 门禁：按发起用户权限等级判定（admin 豁免；匿名/系统通道不拦截）。
  // tier/role 走 60s TTL 缓存（每请求重建工具注册都会查一次，读多写少）
  const { meetsTierRequirement, isAdminRole } = await import('@/lib/tiers');
  let userTier: string | null = null;
  let userIsAdmin = false;
  if (runtime.userId) {
    const user = await userTierCache.getOrLoad(runtime.userId, async () => {
      try {
        return await prisma.user.findUnique({ where: { id: runtime.userId! }, select: { tier: true, role: true } });
      } catch {
        return null;
      }
    });
    userTier = user?.tier ?? null;
    userIsAdmin = isAdminRole(user?.role);
  }
  const isToolEnabled = (name: string) => {
    if (skip.has(name)) return false;
    const policy = policyMap.get(name);
    if (policy?.isEnabled === false) return false;
    return meetsTierRequirement(userTier, policy?.tierRequirement, userIsAdmin);
  };
  const getToolDesc = (name: string, fallback: string) => policyMap.get(name)?.customDescription || fallback;
  /** admin 全局策略 Token 预算（未配置/非法时不约束；由 wrapToolTelemetry 与用户级/入参上限取小执行） */
  const policyTokenCap = (name: string): number | undefined => {
    const budget = policyMap.get(name)?.tokenBudget;
    return typeof budget === 'number' && budget > 0 ? budget : undefined;
  };


  // ── 1. list_resources ──
  if (isToolEnabled('list_resources')) {
    server.registerTool(
      'list_resources',
      {
        description: getToolDesc('list_resources', contractDescription('list_resources', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('list_resources', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'list_resources', dimension: 'all', policyTokenCap: policyTokenCap('list_resources') },
        async (args: any) => runListResources(args, runtime)
      )
    );
  }

  // ── 2. outline ──
  if (isToolEnabled('outline')) {
    server.registerTool(
      'outline',
      {
        description: getToolDesc('outline', contractDescription('outline', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('outline', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'outline', dimension: 'documents', policyTokenCap: policyTokenCap('outline') },
        async (args: any) => runOutline(args, runtime, telemetryId)
      )
    );
  }

  // ── 3. search ──
  if (isToolEnabled('search')) {
    server.registerTool(
      'search',
      {
        description: getToolDesc('search', contractDescription('search', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('search', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'search', dimension: 'all', policyTokenCap: policyTokenCap('search') },
        async (args: any, extra: any) => runSearch(args, extra, runtime)
      )
    );
  }

  // ── 4. read ──
  if (isToolEnabled('read')) {
    server.registerTool(
      'read',
      {
        description: getToolDesc('read', contractDescription('read', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('read', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'read', dimension: 'documents', policyTokenCap: policyTokenCap('read') },
        async (args: any) => runRead(args, runtime, telemetryId)
      )
    );
  }

  // ── 5. read_document ──
  if (isToolEnabled('read_document')) {
    server.registerTool(
      'read_document',
      {
        description: getToolDesc('read_document', contractDescription('read_document', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('read_document', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'read_document', dimension: 'documents', policyTokenCap: policyTokenCap('read_document') },
        async (args: any) => runReadDocument(args, runtime, telemetryId)
      )
    );
  }

  // ── 6. explore_concept ──
  if (isToolEnabled('explore_concept')) {
    server.registerTool(
      'explore_concept',
      {
        description: getToolDesc('explore_concept', contractDescription('explore_concept', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('explore_concept', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'explore_concept', dimension: 'all', policyTokenCap: policyTokenCap('explore_concept') },
        async (args: any) => runExploreConcept(args, runtime, telemetryId)
      )
    );
  }

  // ── 7. check_breaking_changes ──
  if (isToolEnabled('check_breaking_changes')) {
    server.registerTool(
      'check_breaking_changes',
      {
        description: getToolDesc('check_breaking_changes', contractDescription('check_breaking_changes', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('check_breaking_changes', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'check_breaking_changes', dimension: 'documents', policyTokenCap: policyTokenCap('check_breaking_changes') },
        async (args: any, extra: any) => runBreakingChanges(args, extra, runtime)
      )
    );
  }

  // ── 8. read_symbol ──
  if (isToolEnabled('read_symbol')) {
    server.registerTool(
      'read_symbol',
      {
        description: getToolDesc('read_symbol', contractDescription('read_symbol', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('read_symbol', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'read_symbol', dimension: 'symbols', policyTokenCap: policyTokenCap('read_symbol') },
        async (args: any) => runReadSymbol(args, runtime, telemetryId)
      )
    );
  }

  // ── 9. search_symbols ──
  if (isToolEnabled('search_symbols')) {
    server.registerTool(
      'search_symbols',
      {
        description: getToolDesc('search_symbols', contractDescription('search_symbols', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('search_symbols', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'search_symbols', dimension: 'symbols', policyTokenCap: policyTokenCap('search_symbols') },
        async (args: any) => runSearchSymbols(args, runtime, telemetryId)
      )
    );
  }

  // ── 10. read_source_file ──
  if (isToolEnabled('read_source_file')) {
    server.registerTool(
      'read_source_file',
      {
        description: getToolDesc('read_source_file', contractDescription('read_source_file', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('read_source_file', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'read_source_file', dimension: 'source', policyTokenCap: policyTokenCap('read_source_file') },
        async (args: any) => runReadSourceFile(args, runtime, telemetryId)
      )
    );
  }

  // ── 11. list_chapter_versions ──
  if (isToolEnabled('list_chapter_versions')) {
    server.registerTool(
      'list_chapter_versions',
      {
        description: getToolDesc('list_chapter_versions', contractDescription('list_chapter_versions', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('list_chapter_versions', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'list_chapter_versions', dimension: 'documents', policyTokenCap: policyTokenCap('list_chapter_versions') },
        async (args: any) => runListChapterVersions(args, runtime, telemetryId)
      )
    );
  }

  // ── 12. dissect_code ──
  if (isToolEnabled('dissect_code')) {
    server.registerTool(
      'dissect_code',
      {
        description: getToolDesc('dissect_code', contractDescription('dissect_code', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('dissect_code', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'dissect_code', dimension: 'source', policyTokenCap: policyTokenCap('dissect_code') },
        async (args: any) => runDissectCode(args, runtime, telemetryId)
      )
    );
  }

  // ── 13. verify_claim ──
  if (isToolEnabled('verify_claim')) {
    server.registerTool(
      'verify_claim',
      {
        description: getToolDesc('verify_claim', contractDescription('verify_claim', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('verify_claim', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'verify_claim', dimension: 'source', policyTokenCap: policyTokenCap('verify_claim') },
        async (args: any) => runVerifyClaim(args, runtime, telemetryId)
      )
    );
  }
}
