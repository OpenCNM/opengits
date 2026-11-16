package armor

// ArmorFileRef 句柄还原的文件引用（仅需要 path）。
type ArmorFileRef struct {
	Path string `json:"path"`
}

// ArmorSourceFile 配比分配的源文件输入。
type ArmorSourceFile struct {
	Path       string `json:"path"`
	TotalLines int    `json:"totalLines"`
	RawContent string `json:"rawContent"`
}

// ArmorAllocatedSnippet 与 TS 分配产物对齐。
type ArmorAllocatedSnippet struct {
	Path       string `json:"path"`
	TotalLines int    `json:"totalLines"`
	Snippet    string `json:"snippet"`
}

// ArmorResolveHandlesRequest POST /v1/armor/resolve-handles 请求体。
type ArmorResolveHandlesRequest struct {
	MdxContent string         `json:"mdxContent"`
	Files      []ArmorFileRef `json:"files"`
}

// ArmorResolveHandlesResponse 句柄还原响应体。
type ArmorResolveHandlesResponse struct {
	OK       bool   `json:"ok"`
	Resolved string `json:"resolved"`
	Error    string `json:"error,omitempty"`
}

// ArmorSanitizeRequest POST /v1/armor/sanitize 请求体。
type ArmorSanitizeRequest struct {
	MdxContent string `json:"mdxContent"`
}

// ArmorSanitizeResponse MDX 语法消毒响应体。
type ArmorSanitizeResponse struct {
	OK        bool   `json:"ok"`
	Sanitized string `json:"sanitized"`
	Error     string `json:"error,omitempty"`
}

// ArmorAllocateRequest POST /v1/armor/allocate-snippets 请求体。
type ArmorAllocateRequest struct {
	Files            []ArmorSourceFile `json:"files"`
	TotalBudgetChars int               `json:"totalBudgetChars,omitempty"`
}

// ArmorAllocateResponse 代码材料平滑分配响应体。
type ArmorAllocateResponse struct {
	OK       bool                    `json:"ok"`
	Snippets []ArmorAllocatedSnippet `json:"snippets"`
	Error    string                  `json:"error,omitempty"`
}

