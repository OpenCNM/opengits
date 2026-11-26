package cognitive

type Handler struct {
	archiveRoot string
	patternsFn  func() Patterns
	extractorFn func() SymbolExtractor
}

func NewHandler(archiveRoot string, patternsFn func() Patterns, extractorFn ...func() SymbolExtractor) *Handler {
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}
	if patternsFn == nil {
		patternsFn = func() Patterns {
			p, _ := LoadIngestPatterns("")
			return p
		}
	}
	var extFn func() SymbolExtractor
	if len(extractorFn) > 0 {
		extFn = extractorFn[0]
	}
	return &Handler{
		archiveRoot: archiveRoot,
		patternsFn:  patternsFn,
		extractorFn: extFn,
	}
}

func (h *Handler) getPatterns() Patterns {
	if h.patternsFn != nil {
		if p := h.patternsFn(); p != nil {
			return p
		}
	}
	p, _ := LoadIngestPatterns("")
	return p
}

func (h *Handler) getSymbolExtractor() SymbolExtractor {
	if h.extractorFn != nil {
		return h.extractorFn()
	}
	return nil
}
