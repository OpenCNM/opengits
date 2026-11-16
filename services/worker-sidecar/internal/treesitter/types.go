package treesitter

// SymbolMatch represents an extracted symbol declaration.
type SymbolMatch struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"` // "function" | "type"
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	StartCol  int    `json:"startCol"`
	EndCol    int    `json:"endCol"`
}

// CallMatch represents an extracted function/method call invocation.
type CallMatch struct {
	Name string `json:"name"`
	Line int    `json:"line"`
}

// ImportMatch represents an extracted module import and its imported symbol bindings.
type ImportMatch struct {
	Module   string   `json:"module"`
	Bindings []string `json:"bindings,omitempty"`
}

// ExtractionResult contains all AST symbols, call sites, and imports from a source file.
type ExtractionResult struct {
	Symbols   []SymbolMatch `json:"symbols"`
	CallSites []CallMatch   `json:"callSites"`
	Imports   []ImportMatch `json:"imports,omitempty"`
}
