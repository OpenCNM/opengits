package armor

type ArmorFileRef struct {
	Path string `json:"path"`
}

type ArmorSourceFile struct {
	Path       string `json:"path"`
	TotalLines int    `json:"totalLines"`
	RawContent string `json:"rawContent"`
}

type ArmorAllocatedSnippet struct {
	Path       string `json:"path"`
	TotalLines int    `json:"totalLines"`
	Snippet    string `json:"snippet"`
}

type ArmorResolveHandlesRequest struct {
	MdxContent string         `json:"mdxContent"`
	Files      []ArmorFileRef `json:"files"`
}

type ArmorResolveHandlesResponse struct {
	OK       bool   `json:"ok"`
	Resolved string `json:"resolved"`
	Error    string `json:"error,omitempty"`
}

type ArmorSanitizeRequest struct {
	MdxContent string `json:"mdxContent"`
}

type ArmorSanitizeResponse struct {
	OK        bool   `json:"ok"`
	Sanitized string `json:"sanitized"`
	Error     string `json:"error,omitempty"`
}

type ArmorAllocateRequest struct {
	Files            []ArmorSourceFile `json:"files"`
	TotalBudgetChars int               `json:"totalBudgetChars,omitempty"`
}

type ArmorAllocateResponse struct {
	OK       bool                    `json:"ok"`
	Snippets []ArmorAllocatedSnippet `json:"snippets"`
	Error    string                  `json:"error,omitempty"`
}
