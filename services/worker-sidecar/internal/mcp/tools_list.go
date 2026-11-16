package mcp

import "encoding/json"

// ToolDefinition 对齐 MCP 规范 Tool 定义（JSON-RPC tools/list）。
type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// ServerCapabilities 对齐 MCP 规范 ServerCapabilities（JSON-RPC initialize）。
type ServerCapabilities struct {
	Tools     ToolsCapability     `json:"tools"`
	Resources ResourcesCapability `json:"resources"`
	Prompts   PromptsCapability   `json:"prompts"`
}

type ToolsCapability struct {
	ListChanged bool `json:"listChanged"`
}

type ResourcesCapability struct {
	Subscribe   bool `json:"subscribe"`
	ListChanged bool `json:"listChanged"`
}

type PromptsCapability struct {
	ListChanged bool `json:"listChanged"`
}

type ServerInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type InitializeResult struct {
	ProtocolVersion string             `json:"protocolVersion"`
	Capabilities    ServerCapabilities `json:"capabilities"`
	ServerInfo      ServerInfo         `json:"serverInfo"`
}

// DiscoverResult 对齐 MCP 2026-07-28 server/discover（服务端 MUST）：
// supportedVersions 仅列 modern 修订版（2025 及更早经 initialize 协商，对齐官方 SDK）。
type DiscoverResult struct {
	SupportedVersions []string           `json:"supportedVersions"`
	Capabilities      ServerCapabilities `json:"capabilities"`
	modernResultFields
}

type ToolsListResult struct {
	Tools []ToolDefinition `json:"tools"`
	modernResultFields
}

// ResourceDefinition 对齐 MCP 规范 Resource 定义（JSON-RPC resources/list）。
type ResourceDefinition struct {
	URI      string `json:"uri"`
	Name     string `json:"name"`
	Title    string `json:"title,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

type ResourcesListResult struct {
	Resources []ResourceDefinition `json:"resources"`
	modernResultFields
}

var NativeHubResourcesList = []ResourceDefinition{
	{
		URI:      "hub://overview",
		Name:     "hub_overview",
		Title:    "OpenGits Hub Overview",
		MimeType: "text/markdown",
	},
}

// NativeToolsList 单仓形态工具清单（与 Node MCP_AVAILABLE_TOOLS 同源）。
var NativeToolsList = []ToolDefinition{
	{
		Name:        "outline",
		Description: "Inspect system architecture topology, documentation table of contents (TOC), and structural hierarchy (L1 pedagogical digest). Call without \"path\" to view macro architecture topology, repository navigation tree, and key addresses, or with \"path\" to inspect internal headings of a specific document. Note: For concrete implementation facts, exact line ranges, or AST symbol contracts, drill down via read_symbol or read_source_file (L2 physical ground truth).",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"description\":\"Optional document path (e.g. \\\"getting-started.md\\\") to inspect its internal section headings and Addresses.\",\"type\":\"string\"},\"depth\":{\"description\":\"Optional maximum tree depth for the outline.\",\"type\":\"number\"}}}"),
	},
	{
		Name:        "search",
		Description: "Deterministic search across documentation, code examples, architecture, concepts, or migration gotchas (L1 pedagogical digest). Pass concise keywords or symbols. Note: Returned content represents pedagogical synthesis; if code fails or implementation details are suspected of simplification, do not loop in search—drill down directly into physical AST/source ground truth using read_symbol or read_source_file.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Concise technical keyword, symbol, concept, or gotcha scenario (e.g. \\\"useState\\\", \\\"jwt auth\\\", \\\"Next.js 15 async headers\\\")\"},\"filter\":{\"default\":\"all\",\"description\":\"Search dimension: \\\"all\\\" (default), \\\"docs\\\", \\\"code\\\", \\\"architecture\\\", \\\"concept\\\", or \\\"gotchas\\\" (breaking changes & pitfalls).\",\"type\":\"string\",\"enum\":[\"all\",\"docs\",\"code\",\"architecture\",\"concept\",\"gotchas\"]},\"mode\":{\"description\":\"Legacy alias for \\\"filter\\\".\",\"type\":\"string\",\"enum\":[\"all\",\"docs\",\"code\",\"architecture\",\"concept\",\"gotchas\"]},\"token_budget\":{\"default\":4000,\"description\":\"Maximum tokens for the response context window\",\"type\":\"number\",\"minimum\":1},\"detail\":{\"default\":\"locator\",\"description\":\"\\\"locator\\\" (default) returns section addresses + snippets; \\\"summary\\\"/\\\"full\\\" return content.\",\"type\":\"string\",\"enum\":[\"locator\",\"summary\",\"full\"]}},\"required\":[\"query\"]}"),
	},
	{
		Name:        "read",
		Description: "Read document content or a specific section by address (path#heading). Returns Markdown pedagogical digest (L1). Supports aspect parameter to filter by cognitive depth. Note: Tutorial text may simplify code for teaching clarity; if implementation fails or you suspect abstraction distortion, check the Provenance Beacon footer and drill down into verified physical AST facts or source code via read_symbol or read_source_file (L2 physical ground truth).",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"target\":{\"description\":\"Document path (e.g. \\\"docs/getting-started.md\\\") or section address (e.g. \\\"docs/getting-started.md#Installation\\\" or from search hits).\",\"type\":\"string\"},\"path\":{\"description\":\"Alias for \\\"target\\\".\",\"type\":\"string\"},\"aspect\":{\"default\":\"full\",\"description\":\"\\\"full\\\" (default) returns complete content; \\\"architecture\\\" extracts conceptual design & diagrams while collapsing verbose code; \\\"contract\\\" extracts API specs, code blocks & tables without prose.\",\"type\":\"string\",\"enum\":[\"full\",\"architecture\",\"contract\"]},\"repository\":{\"description\":\"Optional \\\"owner/repo\\\" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append \\\"@edition\\\" to target a specific edition.\",\"type\":\"string\"}}}"),
	},
	{
		Name:        "list_resources",
		Description: "List all tutorials/repositories on your bookshelf with tech stack, source URL, last synced date & best-used-for. Call FIRST to pick the right repository before searching or reading.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"category\":{\"description\":\"Optional category filter (e.g. \\\"Frontend\\\", \\\"AI\\\", \\\"Infrastructure\\\")\",\"type\":\"string\"},\"query\":{\"description\":\"Optional keyword to filter tutorials by name, tags, or description\",\"type\":\"string\"}}}"),
	},
	{
		Name:        "read_document",
		Description: "[Legacy alias: prefer outline / read] Read documentation outline (TOC) or fetch exact section content by Address (L1 pedagogical digest). Call without \"section\" to get the outline, or with \"section\" (path#headingPath) to fetch exact section text. Note: If implementation fails or content is suspected of simplification, do not loop—drill down into physical facts via read_symbol or read_source_file (L2 physical ground truth).",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"description\":\"Optional document path (e.g. \\\"docs/getting-started.md\\\"). When provided without \\\"section\\\", returns the internal TOC & content.\",\"type\":\"string\"},\"section\":{\"description\":\"Optional section address (e.g. \\\"docs/getting-started.md#Installation > Step 1\\\" or \\\"Installation\\\"). When provided, returns ONLY that exact section to save tokens.\",\"type\":\"string\"},\"repository\":{\"description\":\"Optional \\\"owner/repo\\\" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append \\\"@edition\\\" to target a specific edition.\",\"type\":\"string\"}}}"),
	},
	{
		Name:        "explore_concept",
		Description: "Explore knowledge graph concept definitions, neighbor dependencies, prerequisite learning paths, course map, system architecture topology (C4 L1/L2), or cross-tutorial skill coverage & recommendation.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"concept\":{\"description\":\"Concept name/slug, subsystem name (for action=\\\"architecture\\\"), or a short project description when action=\\\"recommend\\\" (e.g. \\\"Next.js 15 + Drizzle + auth 全栈项目\\\"). Required for \\\"details\\\", \\\"neighbors\\\", \\\"path\\\" and \\\"recommend\\\".\",\"type\":\"string\"},\"action\":{\"default\":\"details\",\"description\":\"Exploration action: \\\"details\\\" (full concept package), \\\"neighbors\\\" (prerequisite/related edges), \\\"path\\\" (learning path chain), \\\"course_map\\\" (teaching order), \\\"coverage\\\" (skill tree coverage), \\\"recommend\\\" (rank tutorials by concept coverage of a project description; concept carries the description), \\\"architecture\\\" (C4 L1 macro system context or C4 L2 subsystem component collaboration maps with verified AST call flows), \\\"quiz\\\" (structured companion quizzes of the concept chapter: question/options/answer/explanation), or \\\"editions\\\" (cross-edition comparison of the same concept across transcription editions).\",\"type\":\"string\",\"enum\":[\"details\",\"neighbors\",\"path\",\"course_map\",\"coverage\",\"recommend\",\"architecture\",\"quiz\",\"editions\"]}}}"),
	},
	{
		Name:        "check_breaking_changes",
		Description: "Check breaking changes & migration gotchas. Call BEFORE coding or upgrading.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"minLength\":1,\"description\":\"The code snippet, API call, or migration scenario being evaluated (e.g. \\\"Async request headers in Next.js 15\\\").\"},\"limit\":{\"default\":5,\"description\":\"Maximum number of breaking changes to return (default 5, max 5).\",\"type\":\"number\"},\"detail\":{\"default\":\"locator\",\"description\":\"\\\"locator\\\" (default) returns section addresses + snippets; \\\"full\\\" returns content.\",\"type\":\"string\",\"enum\":[\"locator\",\"full\"]},\"token_budget\":{\"default\":4000,\"description\":\"Maximum tokens for the response context window (used in full mode)\",\"type\":\"number\",\"minimum\":1}},\"required\":[\"query\"]}"),
	},
	{
		Name:        "read_symbol",
		Description: "Inspect exact source code snippet, line ranges, type signature, and callers for a verified code symbol (function, method, class, struct, type) from the repository AST. Defaults to aspect=\"contract\" for concise signatures saving tokens for fast LLM coding.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"symbol\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Exact symbol name (e.g. \\\"InitScheduler\\\", \\\"PageRank\\\")\"},\"file\":{\"description\":\"Optional file path (e.g. \\\"scheduler.go\\\") to disambiguate identical symbols\",\"type\":\"string\"},\"aspect\":{\"default\":\"contract\",\"description\":\"Cognitive detail level: \\\"contract\\\" (default) extracts compact type/function signatures without function bodies (saves ~80% tokens for fast coding); \\\"architecture\\\" returns role, PageRank centrality, inbound/outbound call flows & chapter context; \\\"implementation\\\" returns the full verbatim source code slice for debugging.\",\"type\":\"string\",\"enum\":[\"contract\",\"architecture\",\"implementation\"]},\"include_code\":{\"default\":true,\"description\":\"Whether to return the actual source code block\",\"type\":\"boolean\"},\"include_callers\":{\"default\":true,\"description\":\"Whether to list cross-file callers and incoming dependencies\",\"type\":\"boolean\"}},\"required\":[\"symbol\"]}"),
	},
	{
		Name:        "search_symbols",
		Description: "Fuzzy search and discover code symbols (functions, types, classes, structs) ranked by topological PageRank centrality and match relevance. Call without \"query\" to get the top architectural anchors and core contracts cheat-sheet.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"query\":{\"description\":\"Fuzzy symbol name, prefix, or keyword (e.g. \\\"sched\\\", \\\"Init\\\", \\\"Token\\\"). Leave empty to list top golden symbols.\",\"type\":\"string\"},\"file\":{\"description\":\"Optional file path filter to narrow results to a specific module (e.g. \\\"scheduler.go\\\")\",\"type\":\"string\"},\"role\":{\"default\":\"all\",\"description\":\"Filter by architectural role: \\\"core_contract\\\", \\\"entry_point\\\", \\\"pipeline_flow\\\", \\\"leaf_utility\\\", or \\\"all\\\"\",\"type\":\"string\",\"enum\":[\"all\",\"core_contract\",\"entry_point\",\"pipeline_flow\",\"leaf_utility\"]},\"limit\":{\"default\":10,\"description\":\"Maximum number of symbols to return (1-30, default 10)\",\"type\":\"integer\",\"minimum\":1,\"maximum\":30}}}"),
	},
	{
		Name:        "read_source_file",
		Description: "Read the raw source file content from the repository's frozen import archive. Pass an optional line range for targeted inspection of large files. Use read_symbol for symbol-level slices with AST-verified line ranges.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Repository-relative file path (e.g. \\\"internal/search/store_chunks.go\\\")\"},\"start_line\":{\"description\":\"Optional 1-based start line for a targeted window\",\"type\":\"integer\",\"minimum\":1,\"maximum\":9007199254740991},\"end_line\":{\"description\":\"Optional 1-based end line (inclusive); requires start_line\",\"type\":\"integer\",\"minimum\":1,\"maximum\":9007199254740991}},\"required\":[\"path\"]}"),
	},
	{
		Name:        "list_chapter_versions",
		Description: "List community chapter versions (relay/retranslation candidates with votes, pins and the currently effective one) for a chapter document path.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Chapter document path (e.g. \\\"ch01-intro.md\\\"; see outline for valid paths)\"}},\"required\":[\"path\"]}"),
	},
	{
		Name:        "dissect_code",
		Description: "Dissect a source file (or symbol window) into a mermaid component-collaboration diagram via deterministic Tree-sitter AST analysis (no LLM). Pass \"symbol\" or start_line/end_line to narrow the window.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Repository-relative source file path\"},\"symbol\":{\"description\":\"Optional symbol name to dissect a 40-line window around its definition\",\"type\":\"string\"},\"start_line\":{\"description\":\"Optional 1-based start line window\",\"type\":\"integer\",\"minimum\":1,\"maximum\":9007199254740991},\"end_line\":{\"description\":\"Optional 1-based end line (inclusive)\",\"type\":\"integer\",\"minimum\":1,\"maximum\":9007199254740991}},\"required\":[\"path\"]}"),
	},
	{
		Name:        "verify_claim",
		Description: "Verify whether a specific claim or code assumption is factually true against physical AST symbols and source code (L2 physical ground truth). Use when tutorial text seems outdated, contradictory, or ambiguous, or when compile errors suggest signature/behavior drift. Returns deterministic verdict (VERIFIED_TRUE, REFUTED_FALSE, or AMBIGUOUS) backed by exact code slice evidence and line ranges.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"claim\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Specific technical claim or assertion to verify (e.g. \\\"VerifyToken takes 3 arguments\\\", \\\"WorkerPool has Stop method\\\", \\\"Config.timeout defaults to 30s\\\")\"},\"symbol\":{\"description\":\"Optional function, class, type, or method name associated with the claim (e.g. \\\"VerifyToken\\\")\",\"type\":\"string\"},\"file\":{\"description\":\"Optional repository-relative source file path associated with the claim (e.g. \\\"src/auth/token.ts\\\")\",\"type\":\"string\"}},\"required\":[\"claim\"]}"),
	},
}

// NativeHubToolsList Hub 形态工具清单（repository/edition 追加形态）。
var NativeHubToolsList = []ToolDefinition{
	{
		Name:        "outline",
		Description: "Inspect system architecture topology, documentation table of contents (TOC), and structural hierarchy (L1 pedagogical digest). Call without \"path\" to view macro architecture topology, repository navigation tree, and key addresses, or with \"path\" to inspect internal headings of a specific document. Note: For concrete implementation facts, exact line ranges, or AST symbol contracts, drill down via read_symbol or read_source_file (L2 physical ground truth). Pass \"repository\" to scope; omit to search ALL tutorials on the Hub.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"description\":\"Optional document path (e.g. \\\"getting-started.md\\\") to inspect its internal section headings and Addresses.\",\"type\":\"string\"},\"depth\":{\"description\":\"Optional maximum tree depth for the outline.\",\"type\":\"number\"},\"repository\":{\"description\":\"Optional \\\"owner/repo\\\" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append \\\"@edition\\\" to target a specific edition.\",\"type\":\"string\"}}}"),
	},
	{
		Name:        "search",
		Description: "Deterministic search across documentation, code examples, architecture, concepts, or migration gotchas (L1 pedagogical digest). Pass concise keywords or symbols. Note: Returned content represents pedagogical synthesis; if code fails or implementation details are suspected of simplification, do not loop in search—drill down directly into physical AST/source ground truth using read_symbol or read_source_file. Pass \"repository\" to scope; omit to search ALL tutorials on the Hub.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Concise technical keyword, symbol, concept, or gotcha scenario (e.g. \\\"useState\\\", \\\"jwt auth\\\", \\\"Next.js 15 async headers\\\")\"},\"filter\":{\"default\":\"all\",\"description\":\"Search dimension: \\\"all\\\" (default), \\\"docs\\\", \\\"code\\\", \\\"architecture\\\", \\\"concept\\\", or \\\"gotchas\\\" (breaking changes & pitfalls).\",\"type\":\"string\",\"enum\":[\"all\",\"docs\",\"code\",\"architecture\",\"concept\",\"gotchas\"]},\"mode\":{\"description\":\"Legacy alias for \\\"filter\\\".\",\"type\":\"string\",\"enum\":[\"all\",\"docs\",\"code\",\"architecture\",\"concept\",\"gotchas\"]},\"token_budget\":{\"default\":4000,\"description\":\"Maximum tokens for the response context window\",\"type\":\"number\",\"minimum\":1},\"detail\":{\"default\":\"locator\",\"description\":\"\\\"locator\\\" (default) returns section addresses + snippets; \\\"summary\\\"/\\\"full\\\" return content.\",\"type\":\"string\",\"enum\":[\"locator\",\"summary\",\"full\"]},\"repository\":{\"description\":\"Optional \\\"owner/repo\\\" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append \\\"@edition\\\" to target a specific edition.\",\"type\":\"string\"},\"edition\":{\"description\":\"Optional edition key to pick a specific transcription edition of \\\"repository\\\"; omit for default.\",\"type\":\"string\"}},\"required\":[\"query\"]}"),
	},
	{
		Name:        "read",
		Description: "Read document content or a specific section by address (path#heading). Returns Markdown pedagogical digest (L1). Supports aspect parameter to filter by cognitive depth. Note: Tutorial text may simplify code for teaching clarity; if implementation fails or you suspect abstraction distortion, check the Provenance Beacon footer and drill down into verified physical AST facts or source code via read_symbol or read_source_file (L2 physical ground truth). On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"target\":{\"description\":\"Document path (e.g. \\\"docs/getting-started.md\\\") or section address (e.g. \\\"docs/getting-started.md#Installation\\\" or from search hits).\",\"type\":\"string\"},\"path\":{\"description\":\"Alias for \\\"target\\\".\",\"type\":\"string\"},\"aspect\":{\"default\":\"full\",\"description\":\"\\\"full\\\" (default) returns complete content; \\\"architecture\\\" extracts conceptual design & diagrams while collapsing verbose code; \\\"contract\\\" extracts API specs, code blocks & tables without prose.\",\"type\":\"string\",\"enum\":[\"full\",\"architecture\",\"contract\"]},\"repository\":{\"type\":\"string\",\"description\":\"Repository in \\\"owner/repo\\\" format or repository ID (see list_resources)\"},\"edition\":{\"description\":\"Optional edition key to pick a specific transcription edition of \\\"repository\\\"; omit for default.\",\"type\":\"string\"}},\"required\":[\"repository\"]}"),
	},
	{
		Name:        "list_resources",
		Description: "List all tutorials/repositories on your bookshelf with tech stack, source URL, last synced date & best-used-for. Call FIRST to pick the right repository before searching or reading.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"category\":{\"description\":\"Optional category filter (e.g. \\\"Frontend\\\", \\\"AI\\\", \\\"Infrastructure\\\")\",\"type\":\"string\"},\"query\":{\"description\":\"Optional keyword to filter tutorials by name, tags, or description\",\"type\":\"string\"}}}"),
	},
	{
		Name:        "read_document",
		Description: "[Legacy alias: prefer outline / read] Read documentation outline (TOC) or fetch exact section content by Address (L1 pedagogical digest). Call without \"section\" to get the outline, or with \"section\" (path#headingPath) to fetch exact section text. Note: If implementation fails or content is suspected of simplification, do not loop—drill down into physical facts via read_symbol or read_source_file (L2 physical ground truth). On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"description\":\"Optional document path (e.g. \\\"docs/getting-started.md\\\"). When provided without \\\"section\\\", returns the internal TOC & content.\",\"type\":\"string\"},\"section\":{\"description\":\"Optional section address (e.g. \\\"docs/getting-started.md#Installation > Step 1\\\" or \\\"Installation\\\"). When provided, returns ONLY that exact section to save tokens.\",\"type\":\"string\"},\"repository\":{\"type\":\"string\",\"description\":\"Repository in \\\"owner/repo\\\" format or repository ID (see list_resources)\"}},\"required\":[\"repository\"]}"),
	},
	{
		Name:        "explore_concept",
		Description: "Explore knowledge graph concept definitions, neighbor dependencies, prerequisite learning paths, course map, system architecture topology (C4 L1/L2), or cross-tutorial skill coverage & recommendation. Pass \"repository\" to scope; omit to search ALL tutorials on the Hub.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"concept\":{\"description\":\"Concept name/slug, subsystem name (for action=\\\"architecture\\\"), or a short project description when action=\\\"recommend\\\" (e.g. \\\"Next.js 15 + Drizzle + auth 全栈项目\\\"). Required for \\\"details\\\", \\\"neighbors\\\", \\\"path\\\" and \\\"recommend\\\".\",\"type\":\"string\"},\"action\":{\"default\":\"details\",\"description\":\"Exploration action: \\\"details\\\" (full concept package), \\\"neighbors\\\" (prerequisite/related edges), \\\"path\\\" (learning path chain), \\\"course_map\\\" (teaching order), \\\"coverage\\\" (skill tree coverage), \\\"recommend\\\" (rank tutorials by concept coverage of a project description; concept carries the description), \\\"architecture\\\" (C4 L1 macro system context or C4 L2 subsystem component collaboration maps with verified AST call flows), \\\"quiz\\\" (structured companion quizzes of the concept chapter: question/options/answer/explanation), or \\\"editions\\\" (cross-edition comparison of the same concept across transcription editions).\",\"type\":\"string\",\"enum\":[\"details\",\"neighbors\",\"path\",\"course_map\",\"coverage\",\"recommend\",\"architecture\",\"quiz\",\"editions\"]},\"repository\":{\"description\":\"Optional \\\"owner/repo\\\" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append \\\"@edition\\\" to target a specific edition.\",\"type\":\"string\"}}}"),
	},
	{
		Name:        "check_breaking_changes",
		Description: "Check breaking changes & migration gotchas. Call BEFORE coding or upgrading. Pass \"repository\" to scope; omit to search ALL tutorials on the Hub.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"minLength\":1,\"description\":\"The code snippet, API call, or migration scenario being evaluated (e.g. \\\"Async request headers in Next.js 15\\\").\"},\"limit\":{\"default\":5,\"description\":\"Maximum number of breaking changes to return (default 5, max 5).\",\"type\":\"number\"},\"detail\":{\"default\":\"locator\",\"description\":\"\\\"locator\\\" (default) returns section addresses + snippets; \\\"full\\\" returns content.\",\"type\":\"string\",\"enum\":[\"locator\",\"full\"]},\"token_budget\":{\"default\":4000,\"description\":\"Maximum tokens for the response context window (used in full mode)\",\"type\":\"number\",\"minimum\":1},\"repository\":{\"description\":\"Optional \\\"owner/repo\\\" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append \\\"@edition\\\" to target a specific edition.\",\"type\":\"string\"}},\"required\":[\"query\"]}"),
	},
	{
		Name:        "read_symbol",
		Description: "Inspect exact source code snippet, line ranges, type signature, and callers for a verified code symbol (function, method, class, struct, type) from the repository AST. Defaults to aspect=\"contract\" for concise signatures saving tokens for fast LLM coding. Pass \"repository\" to scope; omit to search ALL tutorials on the Hub.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"symbol\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Exact symbol name (e.g. \\\"InitScheduler\\\", \\\"PageRank\\\")\"},\"file\":{\"description\":\"Optional file path (e.g. \\\"scheduler.go\\\") to disambiguate identical symbols\",\"type\":\"string\"},\"aspect\":{\"default\":\"contract\",\"description\":\"Cognitive detail level: \\\"contract\\\" (default) extracts compact type/function signatures without function bodies (saves ~80% tokens for fast coding); \\\"architecture\\\" returns role, PageRank centrality, inbound/outbound call flows & chapter context; \\\"implementation\\\" returns the full verbatim source code slice for debugging.\",\"type\":\"string\",\"enum\":[\"contract\",\"architecture\",\"implementation\"]},\"include_code\":{\"default\":true,\"description\":\"Whether to return the actual source code block\",\"type\":\"boolean\"},\"include_callers\":{\"default\":true,\"description\":\"Whether to list cross-file callers and incoming dependencies\",\"type\":\"boolean\"},\"repository\":{\"description\":\"Optional \\\"owner/repo\\\" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append \\\"@edition\\\" to target a specific edition.\",\"type\":\"string\"}},\"required\":[\"symbol\"]}"),
	},
	{
		Name:        "search_symbols",
		Description: "Fuzzy search and discover code symbols (functions, types, classes, structs) ranked by topological PageRank centrality and match relevance. Call without \"query\" to get the top architectural anchors and core contracts cheat-sheet. Pass \"repository\" to scope; omit to search ALL tutorials on the Hub.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"query\":{\"description\":\"Fuzzy symbol name, prefix, or keyword (e.g. \\\"sched\\\", \\\"Init\\\", \\\"Token\\\"). Leave empty to list top golden symbols.\",\"type\":\"string\"},\"file\":{\"description\":\"Optional file path filter to narrow results to a specific module (e.g. \\\"scheduler.go\\\")\",\"type\":\"string\"},\"role\":{\"default\":\"all\",\"description\":\"Filter by architectural role: \\\"core_contract\\\", \\\"entry_point\\\", \\\"pipeline_flow\\\", \\\"leaf_utility\\\", or \\\"all\\\"\",\"type\":\"string\",\"enum\":[\"all\",\"core_contract\",\"entry_point\",\"pipeline_flow\",\"leaf_utility\"]},\"limit\":{\"default\":10,\"description\":\"Maximum number of symbols to return (1-30, default 10)\",\"type\":\"integer\",\"minimum\":1,\"maximum\":30},\"repository\":{\"description\":\"Optional \\\"owner/repo\\\" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append \\\"@edition\\\" to target a specific edition.\",\"type\":\"string\"}}}"),
	},
	{
		Name:        "read_source_file",
		Description: "Read the raw source file content from the repository's frozen import archive. Pass an optional line range for targeted inspection of large files. Use read_symbol for symbol-level slices with AST-verified line ranges. On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Repository-relative file path (e.g. \\\"internal/search/store_chunks.go\\\")\"},\"start_line\":{\"description\":\"Optional 1-based start line for a targeted window\",\"type\":\"integer\",\"minimum\":1,\"maximum\":9007199254740991},\"end_line\":{\"description\":\"Optional 1-based end line (inclusive); requires start_line\",\"type\":\"integer\",\"minimum\":1,\"maximum\":9007199254740991},\"repository\":{\"type\":\"string\",\"description\":\"Repository in \\\"owner/repo\\\" format or repository ID (see list_resources)\"}},\"required\":[\"path\",\"repository\"]}"),
	},
	{
		Name:        "list_chapter_versions",
		Description: "List community chapter versions (relay/retranslation candidates with votes, pins and the currently effective one) for a chapter document path. On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Chapter document path (e.g. \\\"ch01-intro.md\\\"; see outline for valid paths)\"},\"repository\":{\"type\":\"string\",\"description\":\"Repository in \\\"owner/repo\\\" format or repository ID (see list_resources)\"}},\"required\":[\"path\",\"repository\"]}"),
	},
	{
		Name:        "dissect_code",
		Description: "Dissect a source file (or symbol window) into a mermaid component-collaboration diagram via deterministic Tree-sitter AST analysis (no LLM). Pass \"symbol\" or start_line/end_line to narrow the window. On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Repository-relative source file path\"},\"symbol\":{\"description\":\"Optional symbol name to dissect a 40-line window around its definition\",\"type\":\"string\"},\"start_line\":{\"description\":\"Optional 1-based start line window\",\"type\":\"integer\",\"minimum\":1,\"maximum\":9007199254740991},\"end_line\":{\"description\":\"Optional 1-based end line (inclusive)\",\"type\":\"integer\",\"minimum\":1,\"maximum\":9007199254740991},\"repository\":{\"type\":\"string\",\"description\":\"Repository in \\\"owner/repo\\\" format or repository ID (see list_resources)\"}},\"required\":[\"path\",\"repository\"]}"),
	},
	{
		Name:        "verify_claim",
		Description: "Verify whether a specific claim or code assumption is factually true against physical AST symbols and source code (L2 physical ground truth). Use when tutorial text seems outdated, contradictory, or ambiguous, or when compile errors suggest signature/behavior drift. Returns deterministic verdict (VERIFIED_TRUE, REFUTED_FALSE, or AMBIGUOUS) backed by exact code slice evidence and line ranges. On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"claim\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Specific technical claim or assertion to verify (e.g. \\\"VerifyToken takes 3 arguments\\\", \\\"WorkerPool has Stop method\\\", \\\"Config.timeout defaults to 30s\\\")\"},\"symbol\":{\"description\":\"Optional function, class, type, or method name associated with the claim (e.g. \\\"VerifyToken\\\")\",\"type\":\"string\"},\"file\":{\"description\":\"Optional repository-relative source file path associated with the claim (e.g. \\\"src/auth/token.ts\\\")\",\"type\":\"string\"},\"repository\":{\"type\":\"string\",\"description\":\"Repository in \\\"owner/repo\\\" format or repository ID (see list_resources)\"}},\"required\":[\"claim\",\"repository\"]}"),
	},
}

// NativeBundleToolsList Bundle 清单 = bundle 特化 4 工具 + 深工具（hub 形态；实际由 Node 执行）。
var NativeBundleToolsList = []ToolDefinition{
	{
		Name:        "list_resources",
		Description: "List all repositories included in this MCP Bundle.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{}}"),
	},
	{
		Name:        "search",
		Description: "Fan-out FTS search across all repositories in this MCP Bundle. Filter by dimension: architecture / code / gotcha.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"description\":\"The search query or technical concept\"},\"dimension\":{\"description\":\"Optional content dimension filter\",\"type\":\"string\",\"enum\":[\"all\",\"architecture\",\"code\",\"gotcha\"]}},\"required\":[\"query\"]}"),
	},
	{
		Name:        "read_document",
		Description: "Fetch the full markdown content of a specific document inside any repository of this bundle.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"repository\":{\"type\":\"string\",\"description\":\"Repository name in owner/repo format, e.g., vercel/next.js\"},\"path\":{\"type\":\"string\",\"description\":\"Relative file path of the document, e.g., docs/getting-started.md\"}},\"required\":[\"repository\",\"path\"]}"),
	},
	{
		Name:        "check_breaking_changes",
		Description: "Search upgrade guides, migration notes & breaking-change warnings across the bundle.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"description\":\"The upgrade/migration search query (e.g. \\\"v4 to v5\\\")\"}},\"required\":[\"query\"]}"),
	},
	{
		Name:        "outline",
		Description: "Inspect system architecture topology, documentation table of contents (TOC), and structural hierarchy (L1 pedagogical digest). Call without \"path\" to view macro architecture topology, repository navigation tree, and key addresses, or with \"path\" to inspect internal headings of a specific document. Note: For concrete implementation facts, exact line ranges, or AST symbol contracts, drill down via read_symbol or read_source_file (L2 physical ground truth). Pass \"repository\" to scope; omit to search ALL tutorials on the Hub.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"description\":\"Optional document path (e.g. \\\"getting-started.md\\\") to inspect its internal section headings and Addresses.\",\"type\":\"string\"},\"depth\":{\"description\":\"Optional maximum tree depth for the outline.\",\"type\":\"number\"},\"repository\":{\"description\":\"Optional \\\"owner/repo\\\" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append \\\"@edition\\\" to target a specific edition.\",\"type\":\"string\"}}}"),
	},
	{
		Name:        "read",
		Description: "Read document content or a specific section by address (path#heading). Returns Markdown pedagogical digest (L1). Supports aspect parameter to filter by cognitive depth. Note: Tutorial text may simplify code for teaching clarity; if implementation fails or you suspect abstraction distortion, check the Provenance Beacon footer and drill down into verified physical AST facts or source code via read_symbol or read_source_file (L2 physical ground truth). On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"target\":{\"description\":\"Document path (e.g. \\\"docs/getting-started.md\\\") or section address (e.g. \\\"docs/getting-started.md#Installation\\\" or from search hits).\",\"type\":\"string\"},\"path\":{\"description\":\"Alias for \\\"target\\\".\",\"type\":\"string\"},\"aspect\":{\"default\":\"full\",\"description\":\"\\\"full\\\" (default) returns complete content; \\\"architecture\\\" extracts conceptual design & diagrams while collapsing verbose code; \\\"contract\\\" extracts API specs, code blocks & tables without prose.\",\"type\":\"string\",\"enum\":[\"full\",\"architecture\",\"contract\"]},\"repository\":{\"type\":\"string\",\"description\":\"Repository in \\\"owner/repo\\\" format or repository ID (see list_resources)\"},\"edition\":{\"description\":\"Optional edition key to pick a specific transcription edition of \\\"repository\\\"; omit for default.\",\"type\":\"string\"}},\"required\":[\"repository\"]}"),
	},
	{
		Name:        "explore_concept",
		Description: "Explore knowledge graph concept definitions, neighbor dependencies, prerequisite learning paths, course map, system architecture topology (C4 L1/L2), or cross-tutorial skill coverage & recommendation. Pass \"repository\" to scope; omit to search ALL tutorials on the Hub.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"concept\":{\"description\":\"Concept name/slug, subsystem name (for action=\\\"architecture\\\"), or a short project description when action=\\\"recommend\\\" (e.g. \\\"Next.js 15 + Drizzle + auth 全栈项目\\\"). Required for \\\"details\\\", \\\"neighbors\\\", \\\"path\\\" and \\\"recommend\\\".\",\"type\":\"string\"},\"action\":{\"default\":\"details\",\"description\":\"Exploration action: \\\"details\\\" (full concept package), \\\"neighbors\\\" (prerequisite/related edges), \\\"path\\\" (learning path chain), \\\"course_map\\\" (teaching order), \\\"coverage\\\" (skill tree coverage), \\\"recommend\\\" (rank tutorials by concept coverage of a project description; concept carries the description), \\\"architecture\\\" (C4 L1 macro system context or C4 L2 subsystem component collaboration maps with verified AST call flows), \\\"quiz\\\" (structured companion quizzes of the concept chapter: question/options/answer/explanation), or \\\"editions\\\" (cross-edition comparison of the same concept across transcription editions).\",\"type\":\"string\",\"enum\":[\"details\",\"neighbors\",\"path\",\"course_map\",\"coverage\",\"recommend\",\"architecture\",\"quiz\",\"editions\"]},\"repository\":{\"description\":\"Optional \\\"owner/repo\\\" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append \\\"@edition\\\" to target a specific edition.\",\"type\":\"string\"}}}"),
	},
	{
		Name:        "read_symbol",
		Description: "Inspect exact source code snippet, line ranges, type signature, and callers for a verified code symbol (function, method, class, struct, type) from the repository AST. Defaults to aspect=\"contract\" for concise signatures saving tokens for fast LLM coding. Pass \"repository\" to scope; omit to search ALL tutorials on the Hub.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"symbol\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Exact symbol name (e.g. \\\"InitScheduler\\\", \\\"PageRank\\\")\"},\"file\":{\"description\":\"Optional file path (e.g. \\\"scheduler.go\\\") to disambiguate identical symbols\",\"type\":\"string\"},\"aspect\":{\"default\":\"contract\",\"description\":\"Cognitive detail level: \\\"contract\\\" (default) extracts compact type/function signatures without function bodies (saves ~80% tokens for fast coding); \\\"architecture\\\" returns role, PageRank centrality, inbound/outbound call flows & chapter context; \\\"implementation\\\" returns the full verbatim source code slice for debugging.\",\"type\":\"string\",\"enum\":[\"contract\",\"architecture\",\"implementation\"]},\"include_code\":{\"default\":true,\"description\":\"Whether to return the actual source code block\",\"type\":\"boolean\"},\"include_callers\":{\"default\":true,\"description\":\"Whether to list cross-file callers and incoming dependencies\",\"type\":\"boolean\"},\"repository\":{\"description\":\"Optional \\\"owner/repo\\\" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append \\\"@edition\\\" to target a specific edition.\",\"type\":\"string\"}},\"required\":[\"symbol\"]}"),
	},
	{
		Name:        "search_symbols",
		Description: "Fuzzy search and discover code symbols (functions, types, classes, structs) ranked by topological PageRank centrality and match relevance. Call without \"query\" to get the top architectural anchors and core contracts cheat-sheet. Pass \"repository\" to scope; omit to search ALL tutorials on the Hub.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"query\":{\"description\":\"Fuzzy symbol name, prefix, or keyword (e.g. \\\"sched\\\", \\\"Init\\\", \\\"Token\\\"). Leave empty to list top golden symbols.\",\"type\":\"string\"},\"file\":{\"description\":\"Optional file path filter to narrow results to a specific module (e.g. \\\"scheduler.go\\\")\",\"type\":\"string\"},\"role\":{\"default\":\"all\",\"description\":\"Filter by architectural role: \\\"core_contract\\\", \\\"entry_point\\\", \\\"pipeline_flow\\\", \\\"leaf_utility\\\", or \\\"all\\\"\",\"type\":\"string\",\"enum\":[\"all\",\"core_contract\",\"entry_point\",\"pipeline_flow\",\"leaf_utility\"]},\"limit\":{\"default\":10,\"description\":\"Maximum number of symbols to return (1-30, default 10)\",\"type\":\"integer\",\"minimum\":1,\"maximum\":30},\"repository\":{\"description\":\"Optional \\\"owner/repo\\\" or repository ID to scope search; omit to search across ALL tutorials on the Hub. Append \\\"@edition\\\" to target a specific edition.\",\"type\":\"string\"}}}"),
	},
	{
		Name:        "read_source_file",
		Description: "Read the raw source file content from the repository's frozen import archive. Pass an optional line range for targeted inspection of large files. Use read_symbol for symbol-level slices with AST-verified line ranges. On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Repository-relative file path (e.g. \\\"internal/search/store_chunks.go\\\")\"},\"start_line\":{\"description\":\"Optional 1-based start line for a targeted window\",\"type\":\"integer\",\"minimum\":1,\"maximum\":9007199254740991},\"end_line\":{\"description\":\"Optional 1-based end line (inclusive); requires start_line\",\"type\":\"integer\",\"minimum\":1,\"maximum\":9007199254740991},\"repository\":{\"type\":\"string\",\"description\":\"Repository in \\\"owner/repo\\\" format or repository ID (see list_resources)\"}},\"required\":[\"path\",\"repository\"]}"),
	},
	{
		Name:        "list_chapter_versions",
		Description: "List community chapter versions (relay/retranslation candidates with votes, pins and the currently effective one) for a chapter document path. On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Chapter document path (e.g. \\\"ch01-intro.md\\\"; see outline for valid paths)\"},\"repository\":{\"type\":\"string\",\"description\":\"Repository in \\\"owner/repo\\\" format or repository ID (see list_resources)\"}},\"required\":[\"path\",\"repository\"]}"),
	},
	{
		Name:        "dissect_code",
		Description: "Dissect a source file (or symbol window) into a mermaid component-collaboration diagram via deterministic Tree-sitter AST analysis (no LLM). Pass \"symbol\" or start_line/end_line to narrow the window. On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Repository-relative source file path\"},\"symbol\":{\"description\":\"Optional symbol name to dissect a 40-line window around its definition\",\"type\":\"string\"},\"start_line\":{\"description\":\"Optional 1-based start line window\",\"type\":\"integer\",\"minimum\":1,\"maximum\":9007199254740991},\"end_line\":{\"description\":\"Optional 1-based end line (inclusive)\",\"type\":\"integer\",\"minimum\":1,\"maximum\":9007199254740991},\"repository\":{\"type\":\"string\",\"description\":\"Repository in \\\"owner/repo\\\" format or repository ID (see list_resources)\"}},\"required\":[\"path\",\"repository\"]}"),
	},
	{
		Name:        "verify_claim",
		Description: "Verify whether a specific claim or code assumption is factually true against physical AST symbols and source code (L2 physical ground truth). Use when tutorial text seems outdated, contradictory, or ambiguous, or when compile errors suggest signature/behavior drift. Returns deterministic verdict (VERIFIED_TRUE, REFUTED_FALSE, or AMBIGUOUS) backed by exact code slice evidence and line ranges. On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"claim\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Specific technical claim or assertion to verify (e.g. \\\"VerifyToken takes 3 arguments\\\", \\\"WorkerPool has Stop method\\\", \\\"Config.timeout defaults to 30s\\\")\"},\"symbol\":{\"description\":\"Optional function, class, type, or method name associated with the claim (e.g. \\\"VerifyToken\\\")\",\"type\":\"string\"},\"file\":{\"description\":\"Optional repository-relative source file path associated with the claim (e.g. \\\"src/auth/token.ts\\\")\",\"type\":\"string\"},\"repository\":{\"type\":\"string\",\"description\":\"Repository in \\\"owner/repo\\\" format or repository ID (see list_resources)\"}},\"required\":[\"claim\",\"repository\"]}"),
	},
}

// NativeAllToolNames 有序工具名（bundle discovery GET 消费；与 MCP_AVAILABLE_TOOLS 同序）。
var NativeAllToolNames = []string{
	"outline",
	"search",
	"read",
	"list_resources",
	"read_document",
	"explore_concept",
	"check_breaking_changes",
	"read_symbol",
	"search_symbols",
	"read_source_file",
	"list_chapter_versions",
	"dissect_code",
	"verify_claim",
}

// toolCanonicalNameGen 共享别名交集（仅原生可执行 canonical；Go 特有 overlay 见 server_dispatch.go）。
var toolCanonicalNameGen = map[string]string{
	"breaking_change": "check_breaking_changes",
	"breaking_changes": "check_breaking_changes",
	"cat_document": "read",
	"cat_file": "read_source_file",
	"check_breaking_change": "check_breaking_changes",
	"check_breaking_changes": "check_breaking_changes",
	"concept_details": "explore_concept",
	"concept_neighbors": "explore_concept",
	"concept_search": "search",
	"course_map": "explore_concept",
	"explore_concept": "explore_concept",
	"find_symbol": "search_symbols",
	"find_symbols": "search_symbols",
	"get_code_context": "read_symbol",
	"get_concept_details": "explore_concept",
	"get_doc": "read",
	"get_document": "read",
	"get_file": "read_source_file",
	"get_outline": "outline",
	"get_source": "read_source_file",
	"get_symbol": "read_symbol",
	"get_tutorial_detail": "read",
	"inspect_symbol": "read_symbol",
	"learning_path": "explore_concept",
	"list_doc": "outline",
	"list_docs": "outline",
	"list_documents": "outline",
	"list_resources": "list_resources",
	"list_tool": "outline",
	"list_tutorial": "list_resources",
	"list_tutorials": "list_resources",
	"lookup_symbol": "read_symbol",
	"outline": "outline",
	"read": "read",
	"read_code": "read_source_file",
	"read_doc": "read",
	"read_file": "read_source_file",
	"read_section": "read",
	"read_source_file": "read_source_file",
	"read_symbol": "read_symbol",
	"recommend_tutorial": "explore_concept",
	"search": "search",
	"search_across_hub": "search",
	"search_architecture": "search",
	"search_code_examples": "search",
	"search_doc": "search",
	"search_docs": "search",
	"search_symbol": "search_symbols",
	"search_symbols": "search_symbols",
	"show_outline": "outline",
	"skill_coverage": "explore_concept",
	"symbol": "read_symbol",
	"symbol_search": "search_symbols",
	"table_of_contents": "outline",
	"toc": "outline",
	"view_document": "read",
	"view_source": "read_source_file",
}

// ── MCP Prompts 协议面（prompts/list 与 prompts/get） ──

type PromptArgument struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Required    bool   `json:"required,omitempty"`
}

type PromptDefinition struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Arguments   []PromptArgument `json:"arguments,omitempty"`
	Aliases     []string         `json:"aliases,omitempty"`
}

type PromptsListResult struct {
	Prompts []PromptDefinition `json:"prompts"`
	modernResultFields
}

type PromptMessage struct {
	Role    string        `json:"role"`
	Content PromptContent `json:"content"`
}

type PromptContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type GetPromptResult struct {
	Description string          `json:"description,omitempty"`
	Messages    []PromptMessage `json:"messages"`
	modernResultFields
}

// NativePromptsList 官方推荐 4 大核心工程 Prompt 清单。
var NativePromptsList = []PromptDefinition{
	{
		Name:        "deep_dive",
		Aliases:     []string{"explain-architecture"},
		Description: "Deep dive into architecture and core implementation: locate architecture docs, read key sections, and synthesize structured explanation with layered diagram and design decisions.",
		Arguments: []PromptArgument{
			{
				Name:        "topic",
				Description: "The module, concept, or system to explain (defaults to the whole project)",
				Required:    false,
			},
			{
				Name:        "detail",
				Description: "\"brief\" = short 3-5 bullet summary; \"deep\" = layered diagram + responsibilities + design decisions",
				Required:    false,
			},
			{
				Name:        "repository",
				Description: "Optional repository in owner/repo format",
				Required:    false,
			},
		},
	},
	{
		Name:        "code_review",
		Aliases:     []string{"scaffold-project"},
		Description: "Plan project architecture, scaffold new codebase, and audit implementation against best practices from documentation.",
		Arguments: []PromptArgument{
			{
				Name:        "goal",
				Description: "The project you want to scaffold or review (e.g. Next.js 15 + Drizzle full-stack app)",
				Required:    true,
			},
			{
				Name:        "repository",
				Description: "Optional repository in owner/repo format",
				Required:    false,
			},
		},
	},
	{
		Name:        "breaking_changes",
		Aliases:     []string{"audit-breaking-changes"},
		Description: "Audit breaking changes and migration risks before upgrading: scan gotchas and breaking changes to generate a checklist.",
		Arguments: []PromptArgument{
			{
				Name:        "target",
				Description: "The code snippet, API call, or migration scenario to audit (e.g. Next.js 15 async headers)",
				Required:    true,
			},
			{
				Name:        "repository",
				Description: "Optional repository in owner/repo format",
				Required:    false,
			},
		},
	},
	{
		Name:        "explore_concept",
		Aliases:     []string{"learn-path"},
		Description: "Progressively master a target concept: resolve prerequisite chain via knowledge graph, read each step in order, and confirm understanding.",
		Arguments: []PromptArgument{
			{
				Name:        "concept",
				Description: "The target concept to master (e.g. context-window-design)",
				Required:    true,
			},
			{
				Name:        "repository",
				Description: "Optional repository in owner/repo format",
				Required:    false,
			},
		},
	},
}
