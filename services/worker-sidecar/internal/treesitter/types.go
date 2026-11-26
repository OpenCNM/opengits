package treesitter

type SymbolMatch struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	StartCol  int    `json:"startCol"`
	EndCol    int    `json:"endCol"`
	IsMethod  bool   `json:"isMethod,omitempty"`
}

type CallMatch struct {
	Name       string `json:"name"`
	Line       int    `json:"line"`
	Qualifier  string `json:"qualifier,omitempty"`
	IsSelector bool   `json:"isSelector,omitempty"`
}

type ImportMatch struct {
	Module   string   `json:"module"`
	Bindings []string `json:"bindings,omitempty"`
	Blank    bool     `json:"blank,omitempty"`
	Dot      bool     `json:"dot,omitempty"`
}

type ExtractionResult struct {
	PackageName string        `json:"packageName,omitempty"`
	Symbols     []SymbolMatch `json:"symbols"`
	CallSites   []CallMatch   `json:"callSites"`
	Imports     []ImportMatch `json:"imports,omitempty"`
}
