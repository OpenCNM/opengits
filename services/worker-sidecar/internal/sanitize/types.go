package sanitize

type SanitizeRequest struct {
	Content string `json:"content"`
}

type SanitizeResponse struct {
	Ok      bool   `json:"ok"`
	Content string `json:"content"`
}

type CodeBlock struct {
	Text   string
	Fenced bool
}
