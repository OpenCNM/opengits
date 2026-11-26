package webdoc

import (
	"log"
	"regexp"
	"sync"

	"github.com/andybalholm/cascadia"
	"golang.org/x/net/html"
)

// Hold injected WebDocPatterns data without importing ingest to avoid package cycles.
type ContentPatterns struct {
	MainContentSelectors []string
	NoiseSelectors       []string
	LinkAsset            *regexp.Regexp
}

var (
	patternsMu       sync.RWMutex
	patternsProvider func() ContentPatterns
	providerWarnOnce sync.Once
)

func SetContentPatternsProvider(p func() ContentPatterns) {
	patternsMu.Lock()
	defer patternsMu.Unlock()
	patternsProvider = p
}

func currentPatterns() ContentPatterns {
	patternsMu.RLock()
	defer patternsMu.RUnlock()
	if patternsProvider == nil {
		providerWarnOnce.Do(func() {
			log.Printf("[webdoc] content patterns provider not wired — main-content selectors empty (body fallback) and link-asset filter disabled")
		})
		return ContentPatterns{}
	}
	return patternsProvider()
}

func isLinkAssetPath(re *regexp.Regexp, path string) bool {
	return re != nil && re.MatchString(path)
}

var selectorCache sync.Map

func compileSelector(sel string) cascadia.Selector {
	if v, ok := selectorCache.Load(sel); ok {
		return v.(cascadia.Selector)
	}
	compiled, err := cascadia.Compile(sel)
	if err != nil {
		log.Printf("[webdoc] selector not compilable, treated as never-match: %q: %v", sel, err)
		compiled = cascadia.Selector(func(*html.Node) bool { return false })
	}
	selectorCache.Store(sel, compiled)
	return compiled
}
