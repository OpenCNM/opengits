package chunker

type CodeChunk struct {
	Heading     string `json:"heading"`
	HeadingPath string `json:"headingPath"`
	Content     string `json:"content"`
	ContentType string `json:"contentType"`
	SourceFile  string `json:"sourceFile,omitempty"`
}

type CodeModuleChunkRequest struct {
	ModuleName    string   `json:"moduleName"`
	MdxContent    string   `json:"mdxContent"`
	SourceFiles   []string `json:"sourceFiles,omitempty"`
	MaxChars      int      `json:"maxChars,omitempty"`
	OverviewLabel string   `json:"overviewLabel,omitempty"`
}

type CodeModuleChunkResponse struct {
	Chunks []CodeChunk `json:"chunks"`
}

type MarkdownChunk struct {
	Heading     string  `json:"heading"`
	HeadingPath *string `json:"headingPath"`
	Content     string  `json:"content"`
	ContentType string  `json:"contentType,omitempty"`
}

type MarkdownChunkRequest struct {
	Content     string `json:"content"`
	MaxTokens   int    `json:"maxTokens,omitempty"`
	Overlap     int    `json:"overlap,omitempty"`
	DocPath     string `json:"docPath,omitempty"`
	ParentTitle string `json:"parentTitle,omitempty"`
}

type MarkdownChunkResponse struct {
	Chunks []MarkdownChunk `json:"chunks"`
}
