package chapter

import (
	"github.com/opengits/worker-sidecar/internal/mdpat"

	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
)

// ─────────────────────────────────────────────────────────────
// 模式注册表与文件类型判定（ingestPatterns）
// ─────────────────────────────────────────────────────────────

// ingestPatterns 章节引擎匹配模式注册表。
type ingestPatterns struct {
	DocExtensions  map[string]bool
	CodeExtensions map[string]bool
	tocSidecar     []*regexp.Regexp
	Sniffer        struct {
		numericPrefix *regexp.Regexp
	}
}

var (
	defaultPatternsOnce sync.Once
	defaultPatterns     *ingestPatterns
	defaultPatternsMu   sync.RWMutex
)

// loadIngestPatterns loads and compiles ingestPatterns from the given JSON file.
// If path is empty, returns fallbackPatterns.
// If path is non-empty but unreadable, fails closed and returns an error.
func loadIngestPatterns(path string) (*ingestPatterns, error) {
	if path == "" {
		return fallbackPatterns(), nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("[chapter] explicit ingest patterns path %q specified but unreadable: %w", path, err)
	}

	var doc struct {
		DocExtensions          []string        `json:"docExtensions"`
		CodeExtensions         []string        `json:"codeExtensions"`
		TocSidecarFilePatterns []mdpat.JsRegex `json:"tocSidecarFilePatterns"`
		Sniffer                struct {
			NumericPrefixPattern mdpat.JsRegex `json:"numericPrefixPattern"`
		} `json:"sniffer"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}

	docExts := make(map[string]bool, len(doc.DocExtensions))
	for _, ext := range doc.DocExtensions {
		docExts[strings.ToLower(strings.TrimPrefix(ext, "."))] = true
	}
	codeExts := make(map[string]bool, len(doc.CodeExtensions))
	for _, ext := range doc.CodeExtensions {
		codeExts[strings.ToLower(strings.TrimPrefix(ext, "."))] = true
	}

	p := &ingestPatterns{
		DocExtensions:  docExts,
		CodeExtensions: codeExts,
		tocSidecar:     mdpat.CompileJSRegexes(doc.TocSidecarFilePatterns, "chapter"),
	}
	if doc.Sniffer.NumericPrefixPattern.Source != "" {
		np := mdpat.CompileJSRegexes([]mdpat.JsRegex{doc.Sniffer.NumericPrefixPattern}, "chapter")
		if len(np) > 0 {
			p.Sniffer.numericPrefix = np[0]
		}
	}
	return p, nil
}

func fallbackPatterns() *ingestPatterns {
	p := &ingestPatterns{
		DocExtensions: map[string]bool{
			"md":       true,
			"mdx":      true,
			"markdown": true,
		},
		CodeExtensions: map[string]bool{
			"ts": true, "tsx": true, "js": true, "jsx": true, "mjs": true, "cjs": true,
			"go": true, "py": true, "rs": true, "java": true, "c": true, "cpp": true,
			"h": true, "hpp": true, "rb": true, "php": true, "swift": true, "kt": true,
		},
		tocSidecar: mdpat.CompileJSRegexes([]mdpat.JsRegex{
			{Source: `^(?i)(?:summary|toc|table[-_]of[-_]contents|menu|index)\.(?:md|markdown|txt)$`, Flags: "i"},
		}, "chapter"),
	}
	p.Sniffer.numericPrefix = regexp.MustCompile(`^(\d+)[._\-\s]+`)
	return p
}

// getDefaultPatterns returns the singleton ingestPatterns loaded from disk or fallback.
func getDefaultPatterns() *ingestPatterns {
	defaultPatternsMu.RLock()
	p := defaultPatterns
	defaultPatternsMu.RUnlock()
	if p != nil {
		return p
	}

	defaultPatternsOnce.Do(func() {
		loaded, _ := loadIngestPatterns("")
		if loaded == nil {
			loaded = fallbackPatterns()
		}
		defaultPatternsMu.Lock()
		defaultPatterns = loaded
		defaultPatternsMu.Unlock()
	})

	defaultPatternsMu.RLock()
	res := defaultPatterns
	defaultPatternsMu.RUnlock()
	return res
}

func (p *ingestPatterns) isDocFilePath(path string) bool {
	if p == nil || path == "" {
		return false
	}
	ext := strings.TrimPrefix(mdpat.ExtractExtensionLower(path), ".")
	return p.DocExtensions[ext]
}

func (p *ingestPatterns) isCodeFilePath(path string) bool {
	if p == nil || path == "" {
		return false
	}
	ext := strings.TrimPrefix(mdpat.ExtractExtensionLower(path), ".")
	return ext != "" && p.CodeExtensions[ext]
}
