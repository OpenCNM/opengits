import { McpServer } from '@modelcontextprotocol/server';
import { prisma } from '@/lib/db';
import { TtlCache } from '@/lib/cache/ttl-cache';
import { getGlobalToolPolicies } from '@/lib/mcp/mcp-tools-manager';
import { wrapToolTelemetry } from '@/lib/telemetry/mcp-beacon';
import { contractDescription, contractSchema } from '@/lib/mcp/tool-contracts';
import { MCP_QUERY_MIN_LENGTH } from '@/lib/constants';
import { RepoRuntime } from './tools/shared';
import { runListResources } from './tools/resources';
import { runSearch } from './tools/search';
import { runExploreConcept } from './tools/concepts';
import { runBreakingChanges } from './tools/maintenance';
import { runOutline } from './tools/outline';
import { runRead } from './tools/read';
import { runReadSymbol, runSearchSymbols } from './tools/symbol';
import { runReadSourceFile } from './tools/source-file';

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

function withEditionRef(repository?: string, edition?: string): string | undefined {
  const repoTrim = repository?.trim();
  if (!repoTrim) return undefined;
  const edTrim = edition?.trim();
  if (edTrim && !repoTrim.includes('@')) {
    return `${repoTrim}@${edTrim}`;
  }
  return repoTrim;
}

const userTierCache = new TtlCache<{ tier: string | null; role: string | null } | null>();

export interface RegisterRepositoryToolsOptions {
  skip?: string[];
}

export async function registerRepositoryTools(
  server: McpServer,
  runtime: RepoRuntime,
  opts?: RegisterRepositoryToolsOptions
): Promise<void> {
  const skip = new Set(opts?.skip ?? []);
  const primaryCtx = await runtime.resolveRepository();
  const telemetryId = primaryCtx?.repository.id;

  // Fail closed if global tool policies fail to load.
  const policyMap = await getGlobalToolPolicies();

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
  const policyTokenCap = (name: string): number | undefined => {
    const budget = policyMap.get(name)?.tokenBudget;
    return typeof budget === 'number' && budget > 0 ? budget : undefined;
  };

  if (isToolEnabled('browse')) {
    server.registerTool(
      'browse',
      {
        description: getToolDesc('browse', contractDescription('browse', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('browse', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'browse', dimension: 'documents', policyTokenCap: policyTokenCap('browse') },
        async (args: any) => {
          const scopedRepo = withEditionRef(args.repository, args.edition);
          const view = typeof args.view === 'string' ? args.view.toLowerCase().trim() : 'outline';

          if (view === 'coverage' || view === 'recommend') {
            return runExploreConcept(
              { repository: scopedRepo, concept: args.query ?? args.concept ?? args.path, action: view },
              runtime,
              telemetryId
            );
          }

          if (runtime.multiRepo && !scopedRepo) {
            return runListResources({ category: args.category, query: args.query }, runtime);
          }

          if (view === 'resources' && !args.path && !runtime.multiRepo) {
            return runListResources({ category: args.category, query: args.query }, runtime);
          }

          if ((view === 'architecture' || view === 'course_map') && (!args.path || view === 'architecture')) {
            return runExploreConcept(
              {
                repository: scopedRepo,
                action: view === 'architecture' ? 'architecture' : 'course_map',
                concept: view === 'architecture' ? (args.path || args.concept || args.query) : undefined,
              },
              runtime,
              telemetryId
            );
          }

          return runOutline({ repository: scopedRepo, path: args.path }, runtime, telemetryId);
        }
      )
    );
  }

  if (isToolEnabled('search')) {
    server.registerTool(
      'search',
      {
        description: getToolDesc('search', contractDescription('search', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('search', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'search', dimension: 'all', policyTokenCap: policyTokenCap('search') },
        async (args: any, extra: any) => {
          const rawFilter = typeof args.filter === 'string'
            ? args.filter
            : typeof args.mode === 'string'
              ? args.mode
              : 'all';
          const effectiveFilter = rawFilter.toLowerCase().trim() || 'all';
          const scopedRepo = withEditionRef(args.repository, args.edition);

          if (effectiveFilter === 'symbols' || effectiveFilter === 'symbol') {
            return runSearchSymbols(
              {
                repository: scopedRepo,
                query: args.query,
                file: args.file,
                limit: args.limit,
                role: args.role,
              },
              runtime,
              telemetryId
            );
          }

          const rawQuery = typeof args.query === 'string' ? args.query.trim() : '';
          if (rawQuery.length < MCP_QUERY_MIN_LENGTH) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: "query" is required for documentation, architecture, code, concept, or gotchas search (omit "query" only with filter="symbols").',
                },
              ],
              isError: true,
            };
          }

          if (effectiveFilter === 'gotchas' || effectiveFilter === 'gotcha' || effectiveFilter === 'warning') {
            return runBreakingChanges(
              {
                repository: scopedRepo,
                query: rawQuery,
                limit: args.limit,
                detail: args.detail === 'full' ? 'full' : 'locator',
                token_budget: args.token_budget,
              },
              extra,
              runtime
            );
          }

          return runSearch(
            {
              ...args,
              query: rawQuery,
              filter: effectiveFilter,
            },
            extra,
            runtime
          );
        }
      )
    );
  }

  if (isToolEnabled('read')) {
    server.registerTool(
      'read',
      {
        description: getToolDesc('read', contractDescription('read', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('read', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'read', dimension: 'documents', policyTokenCap: policyTokenCap('read') },
        async (args: any) => {
          const conceptName = typeof args.concept === 'string' ? args.concept.trim() : '';
          const rawTarget = typeof args.target === 'string' ? args.target.trim() : typeof args.path === 'string' ? args.path.trim() : '';
          const scopedRepo = withEditionRef(args.repository, args.edition);
          if (conceptName || (!rawTarget && args.action)) {
            return runExploreConcept(
              {
                repository: scopedRepo,
                concept: conceptName,
                action: args.action || 'details',
              },
              runtime,
              telemetryId
            );
          }
          return runRead(
            {
              repository: args.repository,
              edition: args.edition,
              target: args.target,
              path: args.path,
              aspect: args.aspect,
            },
            runtime,
            telemetryId
          );
        }
      )
    );
  }

  if (isToolEnabled('read_code')) {
    server.registerTool(
      'read_code',
      {
        description: getToolDesc('read_code', contractDescription('read_code', runtime.multiRepo) ?? ''),
        inputSchema: contractSchema('read_code', runtime.multiRepo)!,
      },
      wrapToolTelemetry(
        { repositoryId: telemetryId, userId: runtime.userId, toolName: 'read_code', dimension: 'source', policyTokenCap: policyTokenCap('read_code') },
        async (args: any) => {
          const scopedRepo = withEditionRef(args.repository, args.edition);
          const sym = typeof args.symbol === 'string' ? args.symbol.trim() : '';
          const filePath = typeof args.path === 'string'
            ? args.path.trim()
            : typeof args.file === 'string'
              ? args.file.trim()
              : '';

          if (sym) {
            return runReadSymbol(
              {
                repository: scopedRepo,
                symbol: sym,
                file: filePath || undefined,
                include_code: args.include_code,
                include_callers: args.include_callers,
                aspect: args.aspect,
              },
              runtime,
              telemetryId
            );
          }

          if (filePath) {
            return runReadSourceFile(
              {
                repository: scopedRepo,
                path: filePath,
                start_line: args.start_line,
                end_line: args.end_line,
              },
              runtime,
              telemetryId
            );
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: pass either "symbol" (exact AST symbol name) or "path" (repository-relative source file path). Use search(filter="symbols") to discover symbols.',
              },
            ],
            isError: true,
          };
        }
      )
    );
  }
}
