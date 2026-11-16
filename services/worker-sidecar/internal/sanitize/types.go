package sanitize

// SanitizeRequest represents incoming MDX sanitize payload.
type SanitizeRequest struct {
	Content string `json:"content"`
}

// SanitizeResponse represents successful MDX sanitize response.
type SanitizeResponse struct {
	Ok      bool   `json:"ok"`
	Content string `json:"content"`
}

// CodeBlock represents a masked code block in markdown.
type CodeBlock struct {
	Text   string
	Fenced bool
}
