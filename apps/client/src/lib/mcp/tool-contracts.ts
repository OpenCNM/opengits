// Single source of truth for the 4 MCP primitives; synced 1:1 with Go sidecar tools_list.go.
import { z } from 'zod';

export type HubSuffixKind = 'fanout' | 'required' | 'none';

export const HUB_SUFFIXES: Record<HubSuffixKind, string> = {
  fanout: ' Pass "repository" to scope; omit to search ALL tutorials on the Hub.',
  required: ' On the Hub, "repository" is required.',
  none: '',
};

const repoOptional = z
  .string()
  .optional()
  .describe(
    'Optional "owner/repo" or repository ID to scope; omit on Hub/Bundle to list or search ALL tutorials. Append "@edition" to target a specific edition.'
  );
const repoRequired = z.string().describe('Repository in "owner/repo" format or repository ID (see browse)');
const editionParam = z
  .string()
  .optional()
  .describe('Optional edition key to pick a specific transcription edition of "repository"; omit for default.');

export interface ToolContract {
  name: string;
  canonicalOrder: number;
  description: string;
  hubSuffix: HubSuffixKind;
  singleSchema: z.ZodObject;
  hubSchema: z.ZodObject;
}

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

const browseSingleSchema = z.object({
  path: z
    .string()
    .optional()
    .describe('Optional document path (e.g. "docs/getting-started.md") to inspect section headings and Addresses, or a subsystem name when view="architecture".'),
  view: z
    .enum(['outline', 'architecture', 'course_map', 'resources', 'coverage', 'recommend'])
    .optional()
    .default('outline')
    .describe(
      'Navigation view: "outline" (default: nav tree + concepts or doc TOC), "architecture" (C4 L1/L2 system/subsystem topology & AST call flows), "course_map" (ordered curriculum chapters), "resources" (repository summary), "recommend" (rank Hub tutorials by query), or "coverage" (skill coverage for query).'
    ),
  token_budget: z.number().min(1).optional().default(4000).describe('Maximum tokens for the response context window'),
});

const browseHubBaseSchema = z.object({
  path: z
    .string()
    .optional()
    .describe('Optional document path (e.g. "docs/getting-started.md") to inspect section headings and Addresses, or a subsystem name when view="architecture".'),
  view: z
    .enum(['outline', 'architecture', 'course_map', 'resources', 'coverage', 'recommend'])
    .optional()
    .default('outline')
    .describe(
      'Navigation view when "repository" is provided: "outline" (default), "architecture" (C4 L1/L2 topology), "course_map" (curriculum chapters), or "resources". Without "repository", lists available tutorials (or ranks/checks coverage when view="recommend"/"coverage").'
    ),
  category: z
    .string()
    .optional()
    .describe('Optional category filter when listing tutorials without "repository" (e.g. "Frontend", "AI", "Infrastructure").'),
  query: z
    .string()
    .optional()
    .describe('Optional keyword filter when listing tutorials without "repository", or skill/project description when view="coverage"/"recommend".'),
  token_budget: z.number().min(1).optional().default(4000).describe('Maximum tokens for the response context window'),
});

const searchBaseSchema = z.object({
  query: z
    .string()
    .trim()
    .optional()
    .describe(
      'Concise technical keyword, symbol, concept, or gotcha scenario (e.g. "useState", "jwt auth", "Next.js 15 async headers"). Required unless filter="symbols" (omit query to list top PageRank architectural symbols).'
    ),
  filter: z
    .enum(['all', 'docs', 'code', 'architecture', 'concept', 'gotchas', 'symbols'])
    .optional()
    .default('all')
    .describe(
      'Search mode: "all" (default hybrid FTS+concepts), "docs", "code", "architecture", "concept", "gotchas" (breaking changes & migration pitfalls), or "symbols" (topological PageRank AST symbol index).'
    ),
  mode: z
    .enum(['all', 'docs', 'code', 'architecture', 'concept', 'gotchas', 'symbols'])
    .optional()
    .describe('Legacy alias for "filter".'),
  file: z
    .string()
    .trim()
    .optional()
    .describe('Optional file path filter when filter="symbols" (e.g. "scheduler.go").'),
  role: z
    .enum(['all', 'core_contract', 'entry_point', 'pipeline_flow', 'leaf_utility'])
    .optional()
    .describe('Optional AST role filter when filter="symbols": "core_contract", "entry_point", "pipeline_flow", "leaf_utility", or "all".'),
  token_budget: z.number().min(1).optional().default(4000).describe('Maximum tokens for the response context window'),
  detail: z
    .enum(['locator', 'summary', 'full'])
    .optional()
    .default('locator')
    .describe('"locator" (default) returns section addresses + snippets; "summary"/"full" return richer content.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('Maximum hits for filter="gotchas" (default 5) or filter="symbols" (1-30, default 10).'),
});

const readBaseSchema = z.object({
  target: z
    .string()
    .optional()
    .describe('Document path (e.g. "docs/getting-started.md") or section address (e.g. "docs/getting-started.md#Installation" from search/browse).'),
  path: z
    .string()
    .optional()
    .describe('Alias for "target".'),
  concept: z
    .string()
    .trim()
    .optional()
    .describe('Knowledge-graph concept name or slug (e.g. "event-loop") to inspect its definition, prerequisites, learning path, quizzes, or editions.'),
  action: z
    .enum(['details', 'neighbors', 'path', 'quiz', 'editions'])
    .optional()
    .default('details')
    .describe(
      'Concept mode when "concept" is provided: "details" (default full concept card), "neighbors" (prerequisite/related edges), "path" (learning order chain), "quiz" (self-check quizzes), or "editions" (cross-edition comparison).'
    ),
  aspect: z
    .enum(['full', 'architecture', 'contract'])
    .optional()
    .default('full')
    .describe(
      'Cognitive slicing when reading a document/section: "full" (default) returns complete content; "architecture" keeps design & diagrams; "contract" keeps API specs, code blocks & tables.'
    ),
  token_budget: z.number().min(1).optional().default(4000).describe('Maximum tokens for the response context window'),
});

const readCodeBaseSchema = z.object({
  symbol: z
    .string()
    .trim()
    .optional()
    .describe('Exact AST symbol name (function, method, class, struct, type; e.g. "InitScheduler") to inspect signature, role, callers, and code slice.'),
  path: z
    .string()
    .trim()
    .optional()
    .describe('Repository-relative source file path (e.g. "internal/search/store_chunks.go"). With "symbol": disambiguates matching symbol; without "symbol": reads raw source lines.'),
  file: z
    .string()
    .trim()
    .optional()
    .describe('Legacy alias for "path".'),
  start_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Optional 1-based start line when reading raw source by "path".'),
  end_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Optional 1-based end line (inclusive); requires start_line.'),
  aspect: z
    .enum(['contract', 'architecture', 'implementation'])
    .optional()
    .default('contract')
    .describe(
      'Detail level when inspecting a symbol: "contract" (default) extracts compact type/function signatures (~80% token savings); "architecture" returns PageRank, role, call flows & chapter context; "implementation" returns full verbatim source code.'
    ),
  include_code: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to include the source code block when inspecting a symbol.'),
  include_callers: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to list cross-file callers and incoming dependencies when inspecting a symbol.'),
  token_budget: z.number().min(1).optional().default(4000).describe('Maximum tokens for the response context window'),
});

export const TOOL_CONTRACTS: ToolContract[] = ([
  {
    name: 'browse',
    canonicalOrder: 1,
    hubSuffix: 'fanout',
    description:
      'Browse tutorials, repository navigation trees, document table of contents (TOC), or C4 architecture topology (L1 pedagogical index). Call without "repository" on Hub/Bundle to list available tutorials (filterable via category/query); pass "repository" for repo outline, "path" for document section headings, or view="architecture" for C4 component call flows. For concrete implementation facts or AST signatures, drill down via read_code.',
    singleSchema: browseSingleSchema,
    hubSchema: withHubExtras(browseHubBaseSchema, 'optional', true),
  },
  {
    name: 'search',
    canonicalOrder: 2,
    hubSuffix: 'fanout',
    description:
      'Unified search across documentation, architecture, concepts, breaking-change gotchas, and AST code symbols (L1/L2 hybrid router). Set filter="gotchas" before coding/upgrading to audit breaking changes, or filter="symbols" to discover PageRank-ranked code symbols (omit query to list golden anchors). Note: If doc snippets appear simplified, verify physical AST contracts with read_code.',
    singleSchema: searchBaseSchema,
    hubSchema: withHubExtras(searchBaseSchema, 'optional', true),
  },
  {
    name: 'read',
    canonicalOrder: 3,
    hubSuffix: 'required',
    description:
      'Read pedagogical document content or a specific section by address (path#heading), OR explore a knowledge-graph concept card, prerequisite graph, learning path, quizzes, and cross-edition diff (L1 pedagogical digest). Pass "target" for doc/section reading (supports aspect="full"|"architecture"|"contract"), or "concept" (+ action) for graph exploration. Drill into physical code truth via read_code.',
    singleSchema: readBaseSchema.extend({ repository: repoOptional }),
    hubSchema: withHubExtras(readBaseSchema, 'required', true),
  },
  {
    name: 'read_code',
    canonicalOrder: 4,
    hubSuffix: 'required',
    description:
      'Inspect L2 physical source ground truth from the repository AST and pinned import archive. Pass "symbol" (optionally with "path") to inspect AST signatures, PageRank role, callers, and code slices (defaults to aspect="contract" for concise ~80% token savings), OR pass "path" (+ optional start_line/end_line) without "symbol" to read raw source lines.',
    singleSchema: readCodeBaseSchema.extend({ repository: repoOptional }),
    hubSchema: withHubExtras(readCodeBaseSchema, 'required', true),
  },
] as ToolContract[]).sort((a, b) => a.canonicalOrder - b.canonicalOrder);

export function contractFor(name: string): ToolContract | undefined {
  return TOOL_CONTRACTS.find((c) => c.name === name);
}

export function contractSchema(name: string, multiRepo: boolean): z.ZodObject | undefined {
  const c = contractFor(name);
  if (!c) return undefined;
  return multiRepo ? c.hubSchema : c.singleSchema;
}

export function contractDescription(name: string, multiRepo: boolean): string | undefined {
  const c = contractFor(name);
  if (!c) return undefined;
  return multiRepo ? c.description + HUB_SUFFIXES[c.hubSuffix] : c.description;
}

export interface BundleToolContract {
  name: string;
  description: string;
  schema: z.ZodObject;
}

export const BUNDLE_TOOL_CONTRACTS: BundleToolContract[] = [
  {
    name: 'browse',
    description:
      'List all repositories in this MCP Bundle (when "repository" is omitted), or inspect a specific bundled repository\'s outline, document TOC, or C4 architecture topology (when "repository" is passed).',
    schema: browseHubBaseSchema.extend({
      repository: repoOptional,
      edition: editionParam,
    }),
  },
  {
    name: 'search',
    description:
      'Search across all repositories in this MCP Bundle (or scope via "repository"). Set filter="gotchas" to audit breaking changes across the bundle, or filter="symbols" (with "repository") to search AST code symbols.',
    schema: searchBaseSchema.extend({
      repository: repoOptional,
      edition: editionParam,
      dimension: z
        .enum(['all', 'architecture', 'code', 'gotcha'])
        .optional()
        .describe('Legacy alias for "filter" on bundle search.'),
    }),
  },
  {
    name: 'read',
    description:
      'Read pedagogical document content (target="path#heading") or explore knowledge-graph concepts (concept="...", action="details"|"neighbors"|"path") inside any repository of this bundle ("repository" is required).',
    schema: withHubExtras(readBaseSchema, 'required', true),
  },
  {
    name: 'read_code',
    description:
      'Inspect L2 physical AST symbol signatures/callers (via "symbol") or raw source file lines (via "path") inside any repository of this bundle ("repository" is required).',
    schema: withHubExtras(readCodeBaseSchema, 'required', true),
  },
];

export const MCP_AVAILABLE_TOOLS = [
  'browse',
  'search',
  'read',
  'read_code',
] as const;

export type McpAvailableTool = (typeof MCP_AVAILABLE_TOOLS)[number];

