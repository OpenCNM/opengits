package chunker

// CodeChunk represents a chunked segment of an AI-generated code lesson MDX.
type CodeChunk struct {
	Heading     string `json:"heading"`
	HeadingPath string `json:"headingPath"`
	Content     string `json:"content"`
	ContentType string `json:"contentType"`
	SourceFile  string `json:"sourceFile,omitempty"`
}

// CodeModuleChunkRequest represents the payload for POST /v1/chunk/code-module.
type CodeModuleChunkRequest struct {
	ModuleName    string   `json:"moduleName"`
	MdxContent    string   `json:"mdxContent"`
	SourceFiles   []string `json:"sourceFiles,omitempty"`
	MaxChars      int      `json:"maxChars,omitempty"`
	OverviewLabel string   `json:"overviewLabel,omitempty"`
}

// CodeModuleChunkResponse represents the response for POST /v1/chunk/code-module.
type CodeModuleChunkResponse struct {
	Chunks []CodeChunk `json:"chunks"`
}

// MarkdownChunk represents a chunked segment of a documentation markdown file.
type MarkdownChunk struct {
	Heading     string  `json:"heading"`
	HeadingPath *string `json:"headingPath"`
	Content     string  `json:"content"`
	ContentType string  `json:"contentType,omitempty"`
}

// MarkdownChunkRequest represents the payload for POST /v1/chunk/markdown.
type MarkdownChunkRequest struct {
	Content     string `json:"content"`
	MaxTokens   int    `json:"maxTokens,omitempty"`
	Overlap     int    `json:"overlap,omitempty"`
	DocPath     string `json:"docPath,omitempty"`
	ParentTitle string `json:"parentTitle,omitempty"`
}

// MarkdownChunkResponse represents the response for POST /v1/chunk/markdown.
type MarkdownChunkResponse struct {
	Chunks []MarkdownChunk `json:"chunks"`
}
