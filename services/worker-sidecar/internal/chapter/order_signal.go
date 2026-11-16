package chapter

import (
	"regexp"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// ─────────────────────────────────────────────────────────────
// 顺序信号探测策略族（Strategy Pattern）
// ─────────────────────────────────────────────────────────────

type orderSignalDetectorContext struct {
	scopedTree  []ChapterMapNode
	idx         chapterTreeIndex
	prefixSlash string
	tocContent  string
	readmeHead  string
	patterns    *ingestPatterns
}

type orderSignalStrategy interface {
	Detect(ctx orderSignalDetectorContext) (OrderSignal, bool)
}

type tocSidecarStrategy struct{}

func (s tocSidecarStrategy) Detect(ctx orderSignalDetectorContext) (OrderSignal, bool) {
	if ctx.tocContent == "" {
		return OrderSignal{}, false
	}
	seq := parseMarkdownLinkSequence(ctx.tocContent, ctx.idx, ctx.prefixSlash)
	if len(seq) >= TocMinIntersection {
		return OrderSignal{Type: "toc", Sequence: seq}, true
	}
	return OrderSignal{}, false
}

type readmeHeadStrategy struct{}

func (s readmeHeadStrategy) Detect(ctx orderSignalDetectorContext) (OrderSignal, bool) {
	if ctx.readmeHead == "" {
		return OrderSignal{}, false
	}
	seq := parseMarkdownLinkSequence(ctx.readmeHead, ctx.idx, ctx.prefixSlash)
	if len(seq) >= TocMinIntersection {
		return OrderSignal{Type: "toc", Sequence: seq}, true
	}
	return OrderSignal{}, false
}

type numericPrefixStrategy struct{}

func (s numericPrefixStrategy) Detect(ctx orderSignalDetectorContext) (OrderSignal, bool) {
	type numericEntry struct {
		path string
		num  int
	}
	numeric := []numericEntry{}
	numRegex := regexp.MustCompile(`^(\d+)[._\-\s]+`)
	if ctx.patterns != nil && ctx.patterns.Sniffer.numericPrefix != nil {
		numRegex = ctx.patterns.Sniffer.numericPrefix
	}

	for _, n := range ctx.scopedTree {
		if n.Type != "blob" {
			continue
		}
		parts := strings.Split(n.Path, "/")
		fileName := parts[len(parts)-1]
		lastDir := ""
		if len(parts) > 1 {
			lastDir = parts[len(parts)-2]
		}
		m := numRegex.FindStringSubmatch(fileName)
		if m == nil {
			m = numRegex.FindStringSubmatch(lastDir)
		}
		if m != nil {
			numeric = append(numeric, numericEntry{path: n.Path, num: parseIntSafe(m[1])})
		}
	}
	if len(numeric) >= TocMinIntersection {
		sort.SliceStable(numeric, func(i, j int) bool {
			if numeric[i].num != numeric[j].num {
				return numeric[i].num < numeric[j].num
			}
			return mdpat.JsLocaleCompare(numeric[i].path, numeric[j].path) < 0
		})
		seq := make([]string, len(numeric))
		for i, e := range numeric {
			seq[i] = e.path
		}
		return OrderSignal{Type: "numeric", Sequence: seq}, true
	}
	return OrderSignal{}, false
}

func parseIntSafe(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return n
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// DetectOrderSignal 与 TS detectOrderSignal 对齐（优先级 TOC → 数字前缀 → 无）。
func DetectOrderSignal(
	scopedTree []ChapterMapNode,
	tocContent string,
	readmeHead string,
	prefix string,
) OrderSignal {
	return getDefaultPatterns().DetectOrderSignal(scopedTree, tocContent, readmeHead, prefix)
}

// DetectOrderSignal 在 ingestPatterns 实例上探测顺序信号（策略模式装配执行）。
func (p *ingestPatterns) DetectOrderSignal(
	scopedTree []ChapterMapNode,
	tocContent string,
	readmeHead string,
	prefix string,
) OrderSignal {
	idx := indexChapterTree(scopedTree)
	prefix = strings.TrimRight(prefix, "/")
	prefixSlash := ""
	if prefix != "" {
		prefixSlash = prefix + "/"
	}

	ctx := orderSignalDetectorContext{
		scopedTree:  scopedTree,
		idx:         idx,
		prefixSlash: prefixSlash,
		tocContent:  tocContent,
		readmeHead:  readmeHead,
		patterns:    p,
	}

	strategies := []orderSignalStrategy{
		tocSidecarStrategy{},
		readmeHeadStrategy{},
		numericPrefixStrategy{},
	}

	for _, strategy := range strategies {
		if signal, ok := strategy.Detect(ctx); ok {
			return signal
		}
	}
	return OrderSignal{Type: "none", Sequence: []string{}}
}
