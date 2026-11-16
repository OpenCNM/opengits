/**
 * MCP 工具契约表（纯数据，零 DB / 零运行时依赖）。
 *
 * 单一事实源：工具名 / 规范描述 / 双形态输入 schema 全部在此定义，
 * 消费方由此派生，禁止再各自手抄：
 * 1. registerRepositoryTools（repo-tools.ts）——运行时注册（叠加 policy/tier 门禁与 customDescription 覆盖）
 * 2. MCP_AVAILABLE_TOOLS 原生常量导出 —— 供 capability-manifest 与 wire 协议消费
 *
 * 描述归一原则：TS 与 Go 历史行文取并集——Go 更丰富的措辞（read_symbol 的
 * ~80% tokens 说明、explore_concept 的 C4 展开）回填于此，TS 更新的子句
 * （quiz/editions/token_budget）保留；Hub 后缀统一走 hubSuffix 三型模板。
 * 运行时 admin customDescription 覆盖仍会与静态清单分叉（预存在行为，文档标注）。
 */
import { z } from 'zod';
import { MCP_QUERY_MIN_LENGTH } from '@/lib/constants';

/** multiRepo 描述后缀三型（与历史 TS 行为逐字一致） */
export type HubSuffixKind = 'fanout' | 'required' | 'none';

/** multiRepo 描述后缀模板（契约与工厂共用；Go 侧 tools_list.go 维持对称） */
export const HUB_SUFFIXES: Record<HubSuffixKind, string> = {
  fanout: ' Pass "repository" to scope; omit to search ALL tutorials on the Hub.',
  required: ' On the Hub, "repository" is required.',
  none: '',
};

const repoOptional = z
  .string()
  .optional()
  .describe(
    'Optional "owner/repo" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append "@edition" to target a specific edition.'
  );
const repoRequired = z.string().describe('Repository in "owner/repo" format or repository ID (see list_resources)');
const editionParam = z
  .string()
  .optional()
  .describe('Optional edition key to pick a specific transcription edition of "repository"; omit for default.');

export interface ToolContract {
  name: string;
  /** MCP_AVAILABLE_TOOLS 钉死顺序（≠注册顺序；与 Go tools_list.go 原生清单同序） */
  canonicalOrder: number;
  /** 规范描述（multiRepo 后缀由 hubSuffix 模板追加，不内联） */
  description: string;
  hubSuffix: HubSuffixKind;
  /** 单仓形态输入 schema */
  singleSchema: z.ZodObject;
  /** Hub / Bundle（multiRepo）形态输入 schema */
  hubSchema: z.ZodObject;
}

/** 单仓 → Hub 形态派生：追加 repository（可选/必填）与可选 edition */
function withHubExtras(
  single: z.ZodObject,
  repository: 'optional' | 'required',
  edition: boolean
): z.ZodObject {
  const extras: Record<string, z.ZodTypeAny> = {
    repository: repository === 'required' ? repoRequired : repoOptional,
  };
  if (edition) extras.edition = editionParam;
  return single.extend(extras);
}

export const TOOL_CONTRACTS: ToolContract[] = ([
  {
    name: 'outline',
    canonicalOrder: 1,
    hubSuffix: 'fanout',
    description:
      'Inspect system architecture topology, documentation table of contents (TOC), and structural hierarchy (L1 pedagogical digest). Call without "path" to view macro architecture topology, repository navigation tree, and key addresses, or with "path" to inspect internal headings of a specific document. Note: For concrete implementation facts, exact line ranges, or AST symbol contracts, drill down via read_symbol or read_source_file (L2 physical ground truth).',
    singleSchema: z.object({
      path: z
        .string()
        .optional()
        .describe('Optional document path (e.g. "getting-started.md") to inspect its internal section headings and Addresses.'),
      depth: z
        .number()
        .optional()
        .describe('Optional maximum tree depth for the outline.'),
    }),
    hubSchema: withHubExtras(
      z.object({
        path: z
          .string()
          .optional()
          .describe('Optional document path (e.g. "getting-started.md") to inspect its internal section headings and Addresses.'),
        depth: z
          .number()
          .optional()
          .describe('Optional maximum tree depth for the outline.'),
      }),
      'optional',
      false
    ),
  },
  {
    name: 'search',
    canonicalOrder: 2,
    hubSuffix: 'fanout',
    description:
      'Deterministic search across documentation, code examples, architecture, concepts, or migration gotchas (L1 pedagogical digest). Pass concise keywords or symbols. Note: Returned content represents pedagogical synthesis; if code fails or implementation details are suspected of simplification, do not loop in search—drill down directly into physical AST/source ground truth using read_symbol or read_source_file.',
    singleSchema: z.object({
      query: z
        .string()
        .trim()
        .min(MCP_QUERY_MIN_LENGTH)
        .describe('Concise technical keyword, symbol, concept, or gotcha scenario (e.g. "useState", "jwt auth", "Next.js 15 async headers")'),
      filter: z
        .enum(['all', 'docs', 'code', 'architecture', 'concept', 'gotchas'])
        .optional()
        .default('all')
        .describe('Search dimension: "all" (default), "docs", "code", "architecture", "concept", or "gotchas" (breaking changes & pitfalls).'),
      mode: z
        .enum(['all', 'docs', 'code', 'architecture', 'concept', 'gotchas'])
        .optional()
        .describe('Legacy alias for "filter".'),
      token_budget: z.number().min(1).optional().default(4000).describe('Maximum tokens for the response context window'),
      detail: z
        .enum(['locator', 'summary', 'full'])
        .optional()
        .default('locator')
        .describe('"locator" (default) returns section addresses + snippets; "summary"/"full" return content.'),
    }),
    hubSchema: withHubExtras(
      z.object({
        query: z
          .string()
          .trim()
          .min(MCP_QUERY_MIN_LENGTH)
          .describe('Concise technical keyword, symbol, concept, or gotcha scenario (e.g. "useState", "jwt auth", "Next.js 15 async headers")'),
        filter: z
          .enum(['all', 'docs', 'code', 'architecture', 'concept', 'gotchas'])
          .optional()
          .default('all')
          .describe('Search dimension: "all" (default), "docs", "code", "architecture", "concept", or "gotchas" (breaking changes & pitfalls).'),
        mode: z
          .enum(['all', 'docs', 'code', 'architecture', 'concept', 'gotchas'])
          .optional()
          .describe('Legacy alias for "filter".'),
        token_budget: z.number().min(1).optional().default(4000).describe('Maximum tokens for the response context window'),
        detail: z
          .enum(['locator', 'summary', 'full'])
          .optional()
          .default('locator')
          .describe('"locator" (default) returns section addresses + snippets; "summary"/"full" return content.'),
      }),
      'optional',
      true
    ),
  },
  {
    name: 'read',
    canonicalOrder: 3,
    hubSuffix: 'required',
    description:
      'Read document content or a specific section by address (path#heading). Returns Markdown pedagogical digest (L1). Supports aspect parameter to filter by cognitive depth. Note: Tutorial text may simplify code for teaching clarity; if implementation fails or you suspect abstraction distortion, check the Provenance Beacon footer and drill down into verified physical AST facts or source code via read_symbol or read_source_file (L2 physical ground truth).',
    singleSchema: z
      .object({
        target: z
          .string()
          .optional()
          .describe('Document path (e.g. "docs/getting-started.md") or section address (e.g. "docs/getting-started.md#Installation" or from search hits).'),
        path: z
          .string()
          .optional()
          .describe('Alias for "target".'),
        aspect: z
          .enum(['full', 'architecture', 'contract'])
          .optional()
          .default('full')
          .describe(
            '"full" (default) returns complete content; "architecture" extracts conceptual design & diagrams while collapsing verbose code; "contract" extracts API specs, code blocks & tables without prose.'
          ),
      })
      .extend({ repository: repoOptional }),
    hubSchema: withHubExtras(
      z.object({
        target: z
          .string()
          .optional()
          .describe('Document path (e.g. "docs/getting-started.md") or section address (e.g. "docs/getting-started.md#Installation" or from search hits).'),
        path: z
          .string()
          .optional()
          .describe('Alias for "target".'),
        aspect: z
          .enum(['full', 'architecture', 'contract'])
          .optional()
          .default('full')
          .describe(
            '"full" (default) returns complete content; "architecture" extracts conceptual design & diagrams while collapsing verbose code; "contract" extracts API specs, code blocks & tables without prose.'
          ),
      }),
      'required',
      true
    ),
  },
  {
    name: 'list_resources',
    canonicalOrder: 4,
    hubSuffix: 'none',
    description:
      'List all tutorials/repositories on your bookshelf with tech stack, source URL, last synced date & best-used-for. Call FIRST to pick the right repository before searching or reading.',
    singleSchema: z.object({
      category: z.string().optional().describe('Optional category filter (e.g. "Frontend", "AI", "Infrastructure")'),
      query: z.string().optional().describe('Optional keyword to filter tutorials by name, tags, or description'),
    }),
    hubSchema: z.object({
      category: z.string().optional().describe('Optional category filter (e.g. "Frontend", "AI", "Infrastructure")'),
      query: z.string().optional().describe('Optional keyword to filter tutorials by name, tags, or description'),
    }),
  },
  {
    name: 'read_document',
    canonicalOrder: 5,
    hubSuffix: 'required',
    description:
      '[Legacy alias: prefer outline / read] Read documentation outline (TOC) or fetch exact section content by Address (L1 pedagogical digest). Call without "section" to get the outline, or with "section" (path#headingPath) to fetch exact section text. Note: If implementation fails or content is suspected of simplification, do not loop—drill down into physical facts via read_symbol or read_source_file (L2 physical ground truth).',
    singleSchema: z
      .object({
        path: z
          .string()
          .optional()
          .describe('Optional document path (e.g. "docs/getting-started.md"). When provided without "section", returns the internal TOC & content.'),
        section: z
          .string()
          .optional()
          .describe(
            'Optional section address (e.g. "docs/getting-started.md#Installation > Step 1" or "Installation"). When provided, returns ONLY that exact section to save tokens.'
          ),
      })
      .extend({ repository: repoOptional }),
    hubSchema: withHubExtras(
      z.object({
        path: z
          .string()
          .optional()
          .describe('Optional document path (e.g. "docs/getting-started.md"). When provided without "section", returns the internal TOC & content.'),
        section: z
          .string()
          .optional()
          .describe(
            'Optional section address (e.g. "docs/getting-started.md#Installation > Step 1" or "Installation"). When provided, returns ONLY that exact section to save tokens.'
          ),
      }),
      'required',
      false
    ),
  },
  {
    name: 'explore_concept',
    canonicalOrder: 6,
    hubSuffix: 'fanout',
    description:
      'Explore knowledge graph concept definitions, neighbor dependencies, prerequisite learning paths, course map, system architecture topology (C4 L1/L2), or cross-tutorial skill coverage & recommendation.',
    singleSchema: z.object({
      concept: z
        .string()
        .trim()
        .optional()
        .describe('Concept name/slug, subsystem name (for action="architecture"), or a short project description when action="recommend" (e.g. "Next.js 15 + Drizzle + auth 全栈项目"). Required for "details", "neighbors", "path" and "recommend".'),
      action: z
        .enum(['details', 'neighbors', 'path', 'course_map', 'coverage', 'recommend', 'architecture', 'quiz', 'editions'])
        .optional()
        .default('details')
        .describe(
          'Exploration action: "details" (full concept package), "neighbors" (prerequisite/related edges), "path" (learning path chain), "course_map" (teaching order), "coverage" (skill tree coverage), "recommend" (rank tutorials by concept coverage of a project description; concept carries the description), "architecture" (C4 L1 macro system context or C4 L2 subsystem component collaboration maps with verified AST call flows), "quiz" (structured companion quizzes of the concept chapter: question/options/answer/explanation), or "editions" (cross-edition comparison of the same concept across transcription editions).'
        ),
    }),
    hubSchema: withHubExtras(
      z.object({
        concept: z
          .string()
          .trim()
          .optional()
          .describe('Concept name/slug, subsystem name (for action="architecture"), or a short project description when action="recommend" (e.g. "Next.js 15 + Drizzle + auth 全栈项目"). Required for "details", "neighbors", "path" and "recommend".'),
        action: z
          .enum(['details', 'neighbors', 'path', 'course_map', 'coverage', 'recommend', 'architecture', 'quiz', 'editions'])
          .optional()
          .default('details')
          .describe(
            'Exploration action: "details" (full concept package), "neighbors" (prerequisite/related edges), "path" (learning path chain), "course_map" (teaching order), "coverage" (skill tree coverage), "recommend" (rank tutorials by concept coverage of a project description; concept carries the description), "architecture" (C4 L1 macro system context or C4 L2 subsystem component collaboration maps with verified AST call flows), "quiz" (structured companion quizzes of the concept chapter: question/options/answer/explanation), or "editions" (cross-edition comparison of the same concept across transcription editions).'
          ),
      }),
      'optional',
      false
    ),
  },
  {
    name: 'check_breaking_changes',
    canonicalOrder: 7,
    hubSuffix: 'fanout',
    description: 'Check breaking changes & migration gotchas. Call BEFORE coding or upgrading.',
    singleSchema: z.object({
      query: z
        .string()
        .trim()
        .min(MCP_QUERY_MIN_LENGTH)
        .describe('The code snippet, API call, or migration scenario being evaluated (e.g. "Async request headers in Next.js 15").'),
      limit: z.number().optional().default(5).describe('Maximum number of breaking changes to return (default 5, max 5).'),
      detail: z
        .enum(['locator', 'full'])
        .optional()
        .default('locator')
        .describe('"locator" (default) returns section addresses + snippets; "full" returns content.'),
      token_budget: z.number().min(1).optional().default(4000).describe('Maximum tokens for the response context window (used in full mode)'),
    }),
    hubSchema: withHubExtras(
      z.object({
        query: z
          .string()
          .trim()
          .min(MCP_QUERY_MIN_LENGTH)
          .describe('The code snippet, API call, or migration scenario being evaluated (e.g. "Async request headers in Next.js 15").'),
        limit: z.number().optional().default(5).describe('Maximum number of breaking changes to return (default 5, max 5).'),
        detail: z
          .enum(['locator', 'full'])
          .optional()
          .default('locator')
          .describe('"locator" (default) returns section addresses + snippets; "full" returns content.'),
        token_budget: z.number().min(1).optional().default(4000).describe('Maximum tokens for the response context window (used in full mode)'),
      }),
      'optional',
      false
    ),
  },
  {
    name: 'read_symbol',
    canonicalOrder: 8,
    hubSuffix: 'fanout',
    description:
      'Inspect exact source code snippet, line ranges, type signature, and callers for a verified code symbol (function, method, class, struct, type) from the repository AST. Defaults to aspect="contract" for concise signatures saving tokens for fast LLM coding.',
    singleSchema: z.object({
      symbol: z
        .string()
        .trim()
        .min(1)
        .describe('Exact symbol name (e.g. "InitScheduler", "PageRank")'),
      file: z
        .string()
        .trim()
        .optional()
        .describe('Optional file path (e.g. "scheduler.go") to disambiguate identical symbols'),
      aspect: z
        .enum(['contract', 'architecture', 'implementation'])
        .optional()
        .default('contract')
        .describe(
          'Cognitive detail level: "contract" (default) extracts compact type/function signatures without function bodies (saves ~80% tokens for fast coding); "architecture" returns role, PageRank centrality, inbound/outbound call flows & chapter context; "implementation" returns the full verbatim source code slice for debugging.'
        ),
      include_code: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether to return the actual source code block'),
      include_callers: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether to list cross-file callers and incoming dependencies'),
    }),
    hubSchema: withHubExtras(
      z.object({
        symbol: z
          .string()
          .trim()
          .min(1)
          .describe('Exact symbol name (e.g. "InitScheduler", "PageRank")'),
        file: z
          .string()
          .trim()
          .optional()
          .describe('Optional file path (e.g. "scheduler.go") to disambiguate identical symbols'),
        aspect: z
          .enum(['contract', 'architecture', 'implementation'])
          .optional()
          .default('contract')
          .describe(
            'Cognitive detail level: "contract" (default) extracts compact type/function signatures without function bodies (saves ~80% tokens for fast coding); "architecture" returns role, PageRank centrality, inbound/outbound call flows & chapter context; "implementation" returns the full verbatim source code slice for debugging.'
          ),
        include_code: z
          .boolean()
          .optional()
          .default(true)
          .describe('Whether to return the actual source code block'),
        include_callers: z
          .boolean()
          .optional()
          .default(true)
          .describe('Whether to list cross-file callers and incoming dependencies'),
      }),
      'optional',
      false
    ),
  },
  {
    name: 'search_symbols',
    canonicalOrder: 9,
    hubSuffix: 'fanout',
    description:
      'Fuzzy search and discover code symbols (functions, types, classes, structs) ranked by topological PageRank centrality and match relevance. Call without "query" to get the top architectural anchors and core contracts cheat-sheet.',
    singleSchema: z.object({
      query: z
        .string()
        .trim()
        .optional()
        .describe('Fuzzy symbol name, prefix, or keyword (e.g. "sched", "Init", "Token"). Leave empty to list top golden symbols.'),
      file: z
        .string()
        .trim()
        .optional()
        .describe('Optional file path filter to narrow results to a specific module (e.g. "scheduler.go")'),
      role: z
        .enum(['all', 'core_contract', 'entry_point', 'pipeline_flow', 'leaf_utility'])
        .optional()
        .default('all')
        .describe('Filter by architectural role: "core_contract", "entry_point", "pipeline_flow", "leaf_utility", or "all"'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .default(10)
        .describe('Maximum number of symbols to return (1-30, default 10)'),
    }),
    hubSchema: withHubExtras(
      z.object({
        query: z
          .string()
          .trim()
          .optional()
          .describe('Fuzzy symbol name, prefix, or keyword (e.g. "sched", "Init", "Token"). Leave empty to list top golden symbols.'),
        file: z
          .string()
          .trim()
          .optional()
          .describe('Optional file path filter to narrow results to a specific module (e.g. "scheduler.go")'),
        role: z
          .enum(['all', 'core_contract', 'entry_point', 'pipeline_flow', 'leaf_utility'])
          .optional()
          .default('all')
          .describe('Filter by architectural role: "core_contract", "entry_point", "pipeline_flow", "leaf_utility", or "all"'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .default(10)
          .describe('Maximum number of symbols to return (1-30, default 10)'),
      }),
      'optional',
      false
    ),
  },
  {
    name: 'read_source_file',
    canonicalOrder: 10,
    hubSuffix: 'required',
    description:
      "Read the raw source file content from the repository's frozen import archive. Pass an optional line range for targeted inspection of large files. Use read_symbol for symbol-level slices with AST-verified line ranges.",
    singleSchema: z.object({
      path: z
        .string()
        .trim()
        .min(1)
        .describe('Repository-relative file path (e.g. "internal/search/store_chunks.go")'),
      start_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Optional 1-based start line for a targeted window'),
      end_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Optional 1-based end line (inclusive); requires start_line'),
    }),
    hubSchema: withHubExtras(
      z.object({
        path: z
          .string()
          .trim()
          .min(1)
          .describe('Repository-relative file path (e.g. "internal/search/store_chunks.go")'),
        start_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Optional 1-based start line for a targeted window'),
        end_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Optional 1-based end line (inclusive); requires start_line'),
      }),
      'required',
      false
    ),
  },
  {
    name: 'list_chapter_versions',
    canonicalOrder: 11,
    hubSuffix: 'required',
    description:
      'List community chapter versions (relay/retranslation candidates with votes, pins and the currently effective one) for a chapter document path.',
    singleSchema: z.object({
      path: z
        .string()
        .trim()
        .min(1)
        .describe('Chapter document path (e.g. "ch01-intro.md"; see outline for valid paths)'),
    }),
    hubSchema: withHubExtras(
      z.object({
        path: z
          .string()
          .trim()
          .min(1)
          .describe('Chapter document path (e.g. "ch01-intro.md"; see outline for valid paths)'),
      }),
      'required',
      false
    ),
  },
  {
    name: 'dissect_code',
    canonicalOrder: 12,
    hubSuffix: 'required',
    description:
      'Dissect a source file (or symbol window) into a mermaid component-collaboration diagram via deterministic Tree-sitter AST analysis (no LLM). Pass "symbol" or start_line/end_line to narrow the window.',
    singleSchema: z.object({
      path: z.string().trim().min(1).describe('Repository-relative source file path'),
      symbol: z.string().trim().optional().describe('Optional symbol name to dissect a 40-line window around its definition'),
      start_line: z.number().int().min(1).optional().describe('Optional 1-based start line window'),
      end_line: z.number().int().min(1).optional().describe('Optional 1-based end line (inclusive)'),
    }),
    hubSchema: withHubExtras(
      z.object({
        path: z.string().trim().min(1).describe('Repository-relative source file path'),
        symbol: z.string().trim().optional().describe('Optional symbol name to dissect a 40-line window around its definition'),
        start_line: z.number().int().min(1).optional().describe('Optional 1-based start line window'),
        end_line: z.number().int().min(1).optional().describe('Optional 1-based end line (inclusive)'),
      }),
      'required',
      false
    ),
  },
  {
    name: 'verify_claim',
    canonicalOrder: 13,
    hubSuffix: 'required',
    description:
      'Verify whether a specific claim or code assumption is factually true against physical AST symbols and source code (L2 physical ground truth). Use when tutorial text seems outdated, contradictory, or ambiguous, or when compile errors suggest signature/behavior drift. Returns deterministic verdict (VERIFIED_TRUE, REFUTED_FALSE, or AMBIGUOUS) backed by exact code slice evidence and line ranges.',
    singleSchema: z.object({
      claim: z
        .string()
        .trim()
        .min(1)
        .describe(
          'Specific technical claim or assertion to verify (e.g. "VerifyToken takes 3 arguments", "WorkerPool has Stop method", "Config.timeout defaults to 30s")'
        ),
      symbol: z
        .string()
        .trim()
        .optional()
        .describe('Optional function, class, type, or method name associated with the claim (e.g. "VerifyToken")'),
      file: z
        .string()
        .trim()
        .optional()
        .describe('Optional repository-relative source file path associated with the claim (e.g. "src/auth/token.ts")'),
    }),
    hubSchema: withHubExtras(
      z.object({
        claim: z
          .string()
          .trim()
          .min(1)
          .describe(
            'Specific technical claim or assertion to verify (e.g. "VerifyToken takes 3 arguments", "WorkerPool has Stop method", "Config.timeout defaults to 30s")'
          ),
        symbol: z
          .string()
          .trim()
          .optional()
          .describe('Optional function, class, type, or method name associated with the claim (e.g. "VerifyToken")'),
        file: z
          .string()
          .trim()
          .optional()
          .describe('Optional repository-relative source file path associated with the claim (e.g. "src/auth/token.ts")'),
      }),
      'required',
      false
    ),
  },
] as ToolContract[]).sort((a, b) => a.canonicalOrder - b.canonicalOrder);

/** 契约查询助手（工厂与生成器共用） */
export function contractFor(name: string): ToolContract | undefined {
  return TOOL_CONTRACTS.find((c) => c.name === name);
}

/** 按形态取 schema：multiRepo=true 走 hubSchema，否则 singleSchema */
export function contractSchema(name: string, multiRepo: boolean): z.ZodObject | undefined {
  const c = contractFor(name);
  if (!c) return undefined;
  return multiRepo ? c.hubSchema : c.singleSchema;
}

/** 按形态合成描述：契约描述 + hubSuffix 模板（multiRepo=false 时无后缀） */
export function contractDescription(name: string, multiRepo: boolean): string | undefined {
  const c = contractFor(name);
  if (!c) return undefined;
  return multiRepo ? c.description + HUB_SUFFIXES[c.hubSuffix] : c.description;
}

// ─────────────────────────────────────────────────────────────
// Bundle 特化契约（bundle 路由本地注册的 4 工具；不进共享工厂）
// ─────────────────────────────────────────────────────────────

export interface BundleToolContract {
  name: string;
  description: string;
  schema: z.ZodObject;
}

export const BUNDLE_TOOL_CONTRACTS: BundleToolContract[] = [
  {
    name: 'list_resources',
    description: 'List all repositories included in this MCP Bundle.',
    schema: z.object({}),
  },
  {
    name: 'search',
    description: 'Fan-out FTS search across all repositories in this MCP Bundle. Filter by dimension: architecture / code / gotcha.',
    schema: z.object({
      query: z.string().describe('The search query or technical concept'),
      dimension: z.enum(['all', 'architecture', 'code', 'gotcha']).optional().describe('Optional content dimension filter'),
    }),
  },
  {
    name: 'read_document',
    description: 'Fetch the full markdown content of a specific document inside any repository of this bundle.',
    schema: z.object({
      repository: z.string().describe('Repository name in owner/repo format, e.g., vercel/next.js'),
      path: z.string().describe('Relative file path of the document, e.g., docs/getting-started.md'),
    }),
  },
  {
    name: 'check_breaking_changes',
    description: 'Search upgrade guides, migration notes & breaking-change warnings across the bundle.',
    schema: z.object({
      query: z.string().describe('The upgrade/migration search query (e.g. "v4 to v5")'),
    }),
  },
];

/** 有序工具名清单（与 TOOL_CONTRACTS canonicalOrder 顺序严格一致） */
export const MCP_AVAILABLE_TOOLS = [
  'outline',
  'search',
  'read',
  'list_resources',
  'read_document',
  'explore_concept',
  'check_breaking_changes',
  'read_symbol',
  'search_symbols',
  'read_source_file',
  'list_chapter_versions',
  'dissect_code',
  'verify_claim',
] as const;

export type McpAvailableTool = (typeof MCP_AVAILABLE_TOOLS)[number];

