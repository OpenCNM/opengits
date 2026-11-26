package mcp

import "encoding/json"

type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

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

type DiscoverResult struct {
	SupportedVersions []string           `json:"supportedVersions"`
	Capabilities      ServerCapabilities `json:"capabilities"`
	modernResultFields
}

type ToolsListResult struct {
	Tools []ToolDefinition `json:"tools"`
	modernResultFields
}

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

var NativeToolsList = []ToolDefinition{
	{
		Name:        "browse",
		Description: "Browse tutorials, repository navigation trees, document table of contents (TOC), or C4 architecture topology (L1 pedagogical index). Call without \"repository\" on Hub/Bundle to list available tutorials (filterable via category/query); pass \"repository\" for repo outline, \"path\" for document section headings, or view=\"architecture\" for C4 component call flows. For concrete implementation facts or AST signatures, drill down via read_code.",
		InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"path":{"description":"Optional document path (e.g. \"docs/getting-started.md\") to inspect section headings and Addresses, or a subsystem name when view=\"architecture\".","type":"string"},"view":{"default":"outline","description":"Navigation view: \"outline\" (default: nav tree + concepts or doc TOC), \"architecture\" (C4 L1/L2 system/subsystem topology & AST call flows), \"course_map\" (ordered curriculum chapters), \"resources\" (repository summary), \"recommend\" (rank Hub tutorials by query), or \"coverage\" (skill coverage for query).","type":"string","enum":["outline","architecture","course_map","resources","coverage","recommend"]},"token_budget":{"default":4000,"description":"Maximum tokens for the response context window","type":"number","minimum":1}}}`),
	},
	{
		Name:        "search",
		Description: "Unified search across documentation, architecture, concepts, breaking-change gotchas, and AST code symbols (L1/L2 hybrid router). Set filter=\"gotchas\" before coding/upgrading to audit breaking changes, or filter=\"symbols\" to discover PageRank-ranked code symbols (omit query to list golden anchors). Note: If doc snippets appear simplified, verify physical AST contracts with read_code.",
		InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"query":{"description":"Concise technical keyword, symbol, concept, or gotcha scenario (e.g. \"useState\", \"jwt auth\", \"Next.js 15 async headers\"). Required unless filter=\"symbols\" (omit query to list top PageRank architectural symbols).","type":"string"},"filter":{"default":"all","description":"Search mode: \"all\" (default hybrid FTS+concepts), \"docs\", \"code\", \"architecture\", \"concept\", \"gotchas\" (breaking changes & migration pitfalls), or \"symbols\" (topological PageRank AST symbol index).","type":"string","enum":["all","docs","code","architecture","concept","gotchas","symbols"]},"mode":{"description":"Legacy alias for \"filter\".","type":"string","enum":["all","docs","code","architecture","concept","gotchas","symbols"]},"file":{"description":"Optional file path filter when filter=\"symbols\" (e.g. \"scheduler.go\").","type":"string"},"role":{"description":"Optional AST role filter when filter=\"symbols\": \"core_contract\", \"entry_point\", \"pipeline_flow\", \"leaf_utility\", or \"all\".","type":"string","enum":["all","core_contract","entry_point","pipeline_flow","leaf_utility"]},"token_budget":{"default":4000,"description":"Maximum tokens for the response context window","type":"number","minimum":1},"detail":{"default":"locator","description":"\"locator\" (default) returns section addresses + snippets; \"summary\"/\"full\" return richer content.","type":"string","enum":["locator","summary","full"]},"limit":{"description":"Maximum hits for filter=\"gotchas\" (default 5) or filter=\"symbols\" (1-30, default 10).","type":"integer","minimum":1,"maximum":30}}}`),
	},
	{
		Name:        "read",
		Description: "Read pedagogical document content or a specific section by address (path#heading), OR explore a knowledge-graph concept card, prerequisite graph, learning path, quizzes, and cross-edition diff (L1 pedagogical digest). Pass \"target\" for doc/section reading (supports aspect=\"full\"|\"architecture\"|\"contract\"), or \"concept\" (+ action) for graph exploration. Drill into physical code truth via read_code.",
		InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"target":{"description":"Document path (e.g. \"docs/getting-started.md\") or section address (e.g. \"docs/getting-started.md#Installation\" from search/browse).","type":"string"},"path":{"description":"Alias for \"target\".","type":"string"},"concept":{"description":"Knowledge-graph concept name or slug (e.g. \"event-loop\") to inspect its definition, prerequisites, learning path, quizzes, or editions.","type":"string"},"action":{"default":"details","description":"Concept mode when \"concept\" is provided: \"details\" (default full concept card), \"neighbors\" (prerequisite/related edges), \"path\" (learning order chain), \"quiz\" (self-check quizzes), or \"editions\" (cross-edition comparison).","type":"string","enum":["details","neighbors","path","quiz","editions"]},"aspect":{"default":"full","description":"Cognitive slicing when reading a document/section: \"full\" (default) returns complete content; \"architecture\" keeps design & diagrams; \"contract\" keeps API specs, code blocks & tables.","type":"string","enum":["full","architecture","contract"]},"token_budget":{"default":4000,"description":"Maximum tokens for the response context window","type":"number","minimum":1},"repository":{"description":"Optional \"owner/repo\" or repository ID to scope; omit on Hub/Bundle to list or search ALL tutorials. Append \"@edition\" to target a specific edition.","type":"string"}}}`),
	},
	{
		Name:        "read_code",
		Description: "Inspect L2 physical source ground truth from the repository AST and pinned import archive. Pass \"symbol\" (optionally with \"path\") to inspect AST signatures, PageRank role, callers, and code slices (defaults to aspect=\"contract\" for concise ~80% token savings), OR pass \"path\" (+ optional start_line/end_line) without \"symbol\" to read raw source lines.",
		InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"symbol":{"description":"Exact AST symbol name (function, method, class, struct, type; e.g. \"InitScheduler\") to inspect signature, role, callers, and code slice.","type":"string"},"path":{"description":"Repository-relative source file path (e.g. \"internal/search/store_chunks.go\"). With \"symbol\": disambiguates matching symbol; without \"symbol\": reads raw source lines.","type":"string"},"file":{"description":"Legacy alias for \"path\".","type":"string"},"start_line":{"description":"Optional 1-based start line when reading raw source by \"path\".","type":"integer","minimum":1},"end_line":{"description":"Optional 1-based end line (inclusive); requires start_line.","type":"integer","minimum":1},"aspect":{"default":"contract","description":"Detail level when inspecting a symbol: \"contract\" (default) extracts compact type/function signatures (~80% token savings); \"architecture\" returns PageRank, role, call flows & chapter context; \"implementation\" returns full verbatim source code.","type":"string","enum":["contract","architecture","implementation"]},"include_code":{"default":true,"description":"Whether to include the source code block when inspecting a symbol.","type":"boolean"},"include_callers":{"default":true,"description":"Whether to list cross-file callers and incoming dependencies when inspecting a symbol.","type":"boolean"},"token_budget":{"default":4000,"description":"Maximum tokens for the response context window","type":"number","minimum":1},"repository":{"description":"Optional \"owner/repo\" or repository ID to scope; omit on Hub/Bundle to list or search ALL tutorials. Append \"@edition\" to target a specific edition.","type":"string"}}}`),
	},
}

var NativeHubToolsList = []ToolDefinition{
	{
		Name:        "browse",
		Description: "Browse tutorials, repository navigation trees, document table of contents (TOC), or C4 architecture topology (L1 pedagogical index). Call without \"repository\" on Hub/Bundle to list available tutorials (filterable via category/query); pass \"repository\" for repo outline, \"path\" for document section headings, or view=\"architecture\" for C4 component call flows. For concrete implementation facts or AST signatures, drill down via read_code. Pass \"repository\" to scope; omit to search ALL tutorials on the Hub.",
		InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"path":{"description":"Optional document path (e.g. \"docs/getting-started.md\") to inspect section headings and Addresses, or a subsystem name when view=\"architecture\".","type":"string"},"view":{"default":"outline","description":"Navigation view when \"repository\" is provided: \"outline\" (default), \"architecture\" (C4 L1/L2 topology), \"course_map\" (curriculum chapters), or \"resources\". Without \"repository\", lists available tutorials (or ranks/checks coverage when view=\"recommend\"/\"coverage\").","type":"string","enum":["outline","architecture","course_map","resources","coverage","recommend"]},"category":{"description":"Optional category filter when listing tutorials without \"repository\" (e.g. \"Frontend\", \"AI\", \"Infrastructure\").","type":"string"},"query":{"description":"Optional keyword filter when listing tutorials without \"repository\", or skill/project description when view=\"coverage\"/\"recommend\".","type":"string"},"token_budget":{"default":4000,"description":"Maximum tokens for the response context window","type":"number","minimum":1},"repository":{"description":"Optional \"owner/repo\" or repository ID to scope; omit on Hub/Bundle to list or search ALL tutorials. Append \"@edition\" to target a specific edition.","type":"string"},"edition":{"description":"Optional edition key to pick a specific transcription edition of \"repository\"; omit for default.","type":"string"}}}`),
	},
	{
		Name:        "search",
		Description: "Unified search across documentation, architecture, concepts, breaking-change gotchas, and AST code symbols (L1/L2 hybrid router). Set filter=\"gotchas\" before coding/upgrading to audit breaking changes, or filter=\"symbols\" to discover PageRank-ranked code symbols (omit query to list golden anchors). Note: If doc snippets appear simplified, verify physical AST contracts with read_code. Pass \"repository\" to scope; omit to search ALL tutorials on the Hub.",
		InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"query":{"description":"Concise technical keyword, symbol, concept, or gotcha scenario (e.g. \"useState\", \"jwt auth\", \"Next.js 15 async headers\"). Required unless filter=\"symbols\" (omit query to list top PageRank architectural symbols).","type":"string"},"filter":{"default":"all","description":"Search mode: \"all\" (default hybrid FTS+concepts), \"docs\", \"code\", \"architecture\", \"concept\", \"gotchas\" (breaking changes & migration pitfalls), or \"symbols\" (topological PageRank AST symbol index).","type":"string","enum":["all","docs","code","architecture","concept","gotchas","symbols"]},"mode":{"description":"Legacy alias for \"filter\".","type":"string","enum":["all","docs","code","architecture","concept","gotchas","symbols"]},"file":{"description":"Optional file path filter when filter=\"symbols\" (e.g. \"scheduler.go\").","type":"string"},"role":{"description":"Optional AST role filter when filter=\"symbols\": \"core_contract\", \"entry_point\", \"pipeline_flow\", \"leaf_utility\", or \"all\".","type":"string","enum":["all","core_contract","entry_point","pipeline_flow","leaf_utility"]},"token_budget":{"default":4000,"description":"Maximum tokens for the response context window","type":"number","minimum":1},"detail":{"default":"locator","description":"\"locator\" (default) returns section addresses + snippets; \"summary\"/\"full\" return richer content.","type":"string","enum":["locator","summary","full"]},"limit":{"description":"Maximum hits for filter=\"gotchas\" (default 5) or filter=\"symbols\" (1-30, default 10).","type":"integer","minimum":1,"maximum":30},"repository":{"description":"Optional \"owner/repo\" or repository ID to scope; omit on Hub/Bundle to list or search ALL tutorials. Append \"@edition\" to target a specific edition.","type":"string"},"edition":{"description":"Optional edition key to pick a specific transcription edition of \"repository\"; omit for default.","type":"string"}}}`),
	},
	{
		Name:        "read",
		Description: "Read pedagogical document content or a specific section by address (path#heading), OR explore a knowledge-graph concept card, prerequisite graph, learning path, quizzes, and cross-edition diff (L1 pedagogical digest). Pass \"target\" for doc/section reading (supports aspect=\"full\"|\"architecture\"|\"contract\"), or \"concept\" (+ action) for graph exploration. Drill into physical code truth via read_code. On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"target":{"description":"Document path (e.g. \"docs/getting-started.md\") or section address (e.g. \"docs/getting-started.md#Installation\" from search/browse).","type":"string"},"path":{"description":"Alias for \"target\".","type":"string"},"concept":{"description":"Knowledge-graph concept name or slug (e.g. \"event-loop\") to inspect its definition, prerequisites, learning path, quizzes, or editions.","type":"string"},"action":{"default":"details","description":"Concept mode when \"concept\" is provided: \"details\" (default full concept card), \"neighbors\" (prerequisite/related edges), \"path\" (learning order chain), \"quiz\" (self-check quizzes), or \"editions\" (cross-edition comparison).","type":"string","enum":["details","neighbors","path","quiz","editions"]},"aspect":{"default":"full","description":"Cognitive slicing when reading a document/section: \"full\" (default) returns complete content; \"architecture\" keeps design & diagrams; \"contract\" keeps API specs, code blocks & tables.","type":"string","enum":["full","architecture","contract"]},"token_budget":{"default":4000,"description":"Maximum tokens for the response context window","type":"number","minimum":1},"repository":{"description":"Repository in \"owner/repo\" format or repository ID (see browse)","type":"string"},"edition":{"description":"Optional edition key to pick a specific transcription edition of \"repository\"; omit for default.","type":"string"}},"required":["repository"]}`),
	},
	{
		Name:        "read_code",
		Description: "Inspect L2 physical source ground truth from the repository AST and pinned import archive. Pass \"symbol\" (optionally with \"path\") to inspect AST signatures, PageRank role, callers, and code slices (defaults to aspect=\"contract\" for concise ~80% token savings), OR pass \"path\" (+ optional start_line/end_line) without \"symbol\" to read raw source lines. On the Hub, \"repository\" is required.",
		InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"symbol":{"description":"Exact AST symbol name (function, method, class, struct, type; e.g. \"InitScheduler\") to inspect signature, role, callers, and code slice.","type":"string"},"path":{"description":"Repository-relative source file path (e.g. \"internal/search/store_chunks.go\"). With \"symbol\": disambiguates matching symbol; without \"symbol\": reads raw source lines.","type":"string"},"file":{"description":"Legacy alias for \"path\".","type":"string"},"start_line":{"description":"Optional 1-based start line when reading raw source by \"path\".","type":"integer","minimum":1},"end_line":{"description":"Optional 1-based end line (inclusive); requires start_line.","type":"integer","minimum":1},"aspect":{"default":"contract","description":"Detail level when inspecting a symbol: \"contract\" (default) extracts compact type/function signatures (~80% token savings); \"architecture\" returns PageRank, role, call flows & chapter context; \"implementation\" returns full verbatim source code.","type":"string","enum":["contract","architecture","implementation"]},"include_code":{"default":true,"description":"Whether to include the source code block when inspecting a symbol.","type":"boolean"},"include_callers":{"default":true,"description":"Whether to list cross-file callers and incoming dependencies when inspecting a symbol.","type":"boolean"},"token_budget":{"default":4000,"description":"Maximum tokens for the response context window","type":"number","minimum":1},"repository":{"description":"Repository in \"owner/repo\" format or repository ID (see browse)","type":"string"},"edition":{"description":"Optional edition key to pick a specific transcription edition of \"repository\"; omit for default.","type":"string"}},"required":["repository"]}`),
	},
}

var NativeBundleToolsList = []ToolDefinition{
	{
		Name:        "browse",
		Description: "List all repositories in this MCP Bundle (when \"repository\" is omitted), or inspect a specific bundled repository's outline, document TOC, or C4 architecture topology (when \"repository\" is passed).",
		InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"path":{"description":"Optional document path (e.g. \"docs/getting-started.md\") to inspect section headings and Addresses, or a subsystem name when view=\"architecture\".","type":"string"},"view":{"default":"outline","description":"Navigation view when \"repository\" is provided: \"outline\" (default), \"architecture\" (C4 L1/L2 topology), \"course_map\" (curriculum chapters), or \"resources\". Without \"repository\", lists available tutorials (or ranks/checks coverage when view=\"recommend\"/\"coverage\").","type":"string","enum":["outline","architecture","course_map","resources","coverage","recommend"]},"category":{"description":"Optional category filter when listing tutorials without \"repository\" (e.g. \"Frontend\", \"AI\", \"Infrastructure\").","type":"string"},"query":{"description":"Optional keyword filter when listing tutorials without \"repository\", or skill/project description when view=\"coverage\"/\"recommend\".","type":"string"},"token_budget":{"default":4000,"description":"Maximum tokens for the response context window","type":"number","minimum":1},"repository":{"description":"Optional \"owner/repo\" or repository ID to scope; omit on Hub/Bundle to list or search ALL tutorials. Append \"@edition\" to target a specific edition.","type":"string"},"edition":{"description":"Optional edition key to pick a specific transcription edition of \"repository\"; omit for default.","type":"string"}}}`),
	},
	{
		Name:        "search",
		Description: "Search across all repositories in this MCP Bundle (or scope via \"repository\"). Set filter=\"gotchas\" to audit breaking changes across the bundle, or filter=\"symbols\" (with \"repository\") to search AST code symbols.",
		InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"query":{"description":"Concise technical keyword, symbol, concept, or gotcha scenario (e.g. \"useState\", \"jwt auth\", \"Next.js 15 async headers\"). Required unless filter=\"symbols\" (omit query to list top PageRank architectural symbols).","type":"string"},"filter":{"default":"all","description":"Search mode: \"all\" (default hybrid FTS+concepts), \"docs\", \"code\", \"architecture\", \"concept\", \"gotchas\" (breaking changes & migration pitfalls), or \"symbols\" (topological PageRank AST symbol index).","type":"string","enum":["all","docs","code","architecture","concept","gotchas","symbols"]},"mode":{"description":"Legacy alias for \"filter\".","type":"string","enum":["all","docs","code","architecture","concept","gotchas","symbols"]},"dimension":{"description":"Legacy alias for \"filter\" on bundle search.","type":"string","enum":["all","architecture","code","gotcha"]},"file":{"description":"Optional file path filter when filter=\"symbols\" (e.g. \"scheduler.go\").","type":"string"},"role":{"description":"Optional AST role filter when filter=\"symbols\": \"core_contract\", \"entry_point\", \"pipeline_flow\", \"leaf_utility\", or \"all\".","type":"string","enum":["all","core_contract","entry_point","pipeline_flow","leaf_utility"]},"token_budget":{"default":4000,"description":"Maximum tokens for the response context window","type":"number","minimum":1},"detail":{"default":"locator","description":"\"locator\" (default) returns section addresses + snippets; \"summary\"/\"full\" return richer content.","type":"string","enum":["locator","summary","full"]},"limit":{"description":"Maximum hits for filter=\"gotchas\" (default 5) or filter=\"symbols\" (1-30, default 10).","type":"integer","minimum":1,"maximum":30},"repository":{"description":"Optional \"owner/repo\" or repository ID to scope; omit on Hub/Bundle to list or search ALL tutorials. Append \"@edition\" to target a specific edition.","type":"string"},"edition":{"description":"Optional edition key to pick a specific transcription edition of \"repository\"; omit for default.","type":"string"}}}`),
	},
	{
		Name:        "read",
		Description: "Read pedagogical document content (target=\"path#heading\") or explore knowledge-graph concepts (concept=\"...\", action=\"details\"|\"neighbors\"|\"path\") inside any repository of this bundle (\"repository\" is required).",
		InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"target":{"description":"Document path (e.g. \"docs/getting-started.md\") or section address (e.g. \"docs/getting-started.md#Installation\" from search/browse).","type":"string"},"path":{"description":"Alias for \"target\".","type":"string"},"concept":{"description":"Knowledge-graph concept name or slug (e.g. \"event-loop\") to inspect its definition, prerequisites, learning path, quizzes, or editions.","type":"string"},"action":{"default":"details","description":"Concept mode when \"concept\" is provided: \"details\" (default full concept card), \"neighbors\" (prerequisite/related edges), \"path\" (learning order chain), \"quiz\" (self-check quizzes), or \"editions\" (cross-edition comparison).","type":"string","enum":["details","neighbors","path","quiz","editions"]},"aspect":{"default":"full","description":"Cognitive slicing when reading a document/section: \"full\" (default) returns complete content; \"architecture\" keeps design & diagrams; \"contract\" keeps API specs, code blocks & tables.","type":"string","enum":["full","architecture","contract"]},"token_budget":{"default":4000,"description":"Maximum tokens for the response context window","type":"number","minimum":1},"repository":{"description":"Repository in \"owner/repo\" format or repository ID (see browse)","type":"string"},"edition":{"description":"Optional edition key to pick a specific transcription edition of \"repository\"; omit for default.","type":"string"}},"required":["repository"]}`),
	},
	{
		Name:        "read_code",
		Description: "Inspect L2 physical AST symbol signatures/callers (via \"symbol\") or raw source file lines (via \"path\") inside any repository of this bundle (\"repository\" is required).",
		InputSchema: json.RawMessage(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"symbol":{"description":"Exact AST symbol name (function, method, class, struct, type; e.g. \"InitScheduler\") to inspect signature, role, callers, and code slice.","type":"string"},"path":{"description":"Repository-relative source file path (e.g. \"internal/search/store_chunks.go\"). With \"symbol\": disambiguates matching symbol; without \"symbol\": reads raw source lines.","type":"string"},"file":{"description":"Legacy alias for \"path\".","type":"string"},"start_line":{"description":"Optional 1-based start line when reading raw source by \"path\".","type":"integer","minimum":1},"end_line":{"description":"Optional 1-based end line (inclusive); requires start_line.","type":"integer","minimum":1},"aspect":{"default":"contract","description":"Detail level when inspecting a symbol: \"contract\" (default) extracts compact type/function signatures (~80% token savings); \"architecture\" returns PageRank, role, call flows & chapter context; \"implementation\" returns full verbatim source code.","type":"string","enum":["contract","architecture","implementation"]},"include_code":{"default":true,"description":"Whether to include the source code block when inspecting a symbol.","type":"boolean"},"include_callers":{"default":true,"description":"Whether to list cross-file callers and incoming dependencies when inspecting a symbol.","type":"boolean"},"token_budget":{"default":4000,"description":"Maximum tokens for the response context window","type":"number","minimum":1},"repository":{"description":"Repository in \"owner/repo\" format or repository ID (see browse)","type":"string"},"edition":{"description":"Optional edition key to pick a specific transcription edition of \"repository\"; omit for default.","type":"string"}},"required":["repository"]}`),
	},
}

var NativeAllToolNames = []string{
	"browse",
	"search",
	"read",
	"read_code",
}

var toolCanonicalNameGen = map[string]string{
	"breaking_change":        "search",
	"breaking_changes":       "search",
	"browse":                 "browse",
	"cat_document":           "read",
	"cat_file":               "read_code",
	"check_breaking_change":  "search",
	"check_breaking_changes": "search",
	"concept_details":        "read",
	"concept_neighbors":      "read",
	"concept_search":         "search",
	"course_map":             "browse",
	"explore_concept":        "read",
	"find_symbol":            "search",
	"find_symbols":           "search",
	"get_code_context":       "read_code",
	"get_concept_details":    "read",
	"get_doc":                "read",
	"get_document":           "read",
	"get_file":               "read_code",
	"get_outline":            "browse",
	"get_source":             "read_code",
	"get_symbol":             "read_code",
	"get_tutorial_detail":    "read",
	"inspect_symbol":         "read_code",
	"learning_path":          "read",
	"list_doc":               "browse",
	"list_docs":              "browse",
	"list_documents":         "browse",
	"list_resources":         "browse",
	"list_tool":              "browse",
	"list_tutorial":          "browse",
	"list_tutorials":         "browse",
	"lookup_symbol":          "read_code",
	"outline":                "browse",
	"read":                   "read",
	"read_code":              "read_code",
	"read_doc":               "read",
	"read_file":              "read_code",
	"read_section":           "read",
	"read_source_file":       "read_code",
	"read_symbol":            "read_code",
	"recommend_tutorial":     "browse",
	"search":                 "search",
	"search_across_hub":      "search",
	"search_architecture":    "search",
	"search_code_examples":   "search",
	"search_doc":             "search",
	"search_docs":            "search",
	"search_symbol":          "search",
	"search_symbols":         "search",
	"show_outline":           "browse",
	"skill_coverage":         "browse",
	"symbol":                 "read_code",
	"symbol_search":          "search",
	"table_of_contents":      "browse",
	"toc":                    "browse",
	"view_document":          "read",
	"view_source":            "read_code",
}

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

var NativePromptsList = []PromptDefinition{
	{
		Name:        "deep_dive",
		Aliases:     []string{"explain-architecture"},
		Description: "Deep dive into architecture and core implementation: browse C4 topology, search architecture sections, read key concepts/chapters, and inspect AST contracts via read_code.",
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
		Description: "Plan project architecture, browse tutorial course_map, search breaking gotchas, and scaffold/review implementation against best practices.",
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
		Description: "Audit breaking changes and migration risks before upgrading: scan gotchas via search(filter=\"gotchas\") and read affected sections.",
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
		Description: "Progressively master a target concept: resolve prerequisite chain via read(concept=..., action=\"path\"), read each step in order, and confirm understanding.",
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
