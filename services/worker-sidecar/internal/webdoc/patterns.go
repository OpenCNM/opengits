package webdoc

import (
	"log"
	"regexp"
	"sync"

	"github.com/andybalholm/cascadia"
	"golang.org/x/net/html"
)

// ─────────────────────────────────────────────────────────────
// web-doc 抓取选择器注册表消费端。
//
// 单一事实源：apps/client/src/engine/web-doc/selectors.ts →
// scripts/export-ingest-patterns.ts → ingest-patterns.json →
// ingest.WebDocPatterns（daemon 注入本包）。本包不复制任何选择器字面量；
// 选择器经 cascadia 完整 CSS 语义求值（复合/层级/属性选择器天然支持，
// 替代历史手写 tag/class/id 三形态匹配器）。
// ─────────────────────────────────────────────────────────────

// ContentPatterns 正文定位 / 噪声移除 / 资产过滤模式（由 daemon 从
// ingest.WebDocPatterns 转换注入；ingest → webdoc 存在既有依赖方向，
// 此处只持有数据不回引 ingest，避免环）。
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

// SetContentPatternsProvider 注入注册表访问器（daemon 启动时调用一次；
// 生产路径唯一来源；测试注入夹具选择器同用此口）。
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

// isLinkAssetPath 注册表资产扩展名过滤（模式未注入时不滤除——见上方告警）。
func isLinkAssetPath(re *regexp.Regexp, path string) bool {
	return re != nil && re.MatchString(path)
}

// selectorCache cascadia 编译缓存（进程级；选择器字符串为键，注册表
// 内容变更时按新键自然失效）。
var selectorCache sync.Map // string -> cascadia.Selector

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
