package cognitive

// （认知投影/事实锚定的 HTTP 端点 /v1/cognitive/project 与
//  /v1/fact-grounding/verify 已随 TS cognitive-driver 退役下线（2026-11 收口），
//  本 Handler 仅承载 /v1/outline/* 四端点；投影与锚定纯函数由
//  internal/cognitive（projector.go / fact_grounding.go）进程内供转录管线消费。）

// Handler manages HTTP endpoints for outline generation.
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
