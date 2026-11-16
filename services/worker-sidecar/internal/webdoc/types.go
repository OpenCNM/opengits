package webdoc

import (
	"context"

	"golang.org/x/net/html"
)

// WebDocDiffRequest 增量差分检测入参。
type WebDocDiffRequest struct {
	RootURL     string            `json:"rootUrl"`
	PrevETag    string            `json:"prevEtag,omitempty"`
	PrevLastMod map[string]string `json:"prevLastMod,omitempty"`
	TimeoutMs   int               `json:"timeoutMs,omitempty"`
}

// WebDocDiffResult 增量差分检测出参。
type WebDocDiffResult struct {
	HasChanges        bool              `json:"hasChanges"`
	ETag              string            `json:"etag,omitempty"`
	SitemapLastModMap map[string]string `json:"sitemapLastModMap,omitempty"`
	TotalPages        int               `json:"totalPages"`
	PagesToAdd        []string          `json:"pagesToAdd"`
	PagesToUpdate     []string          `json:"pagesToUpdate"`
	PagesToRemove     []string          `json:"pagesToRemove"`
	TotalChanged      int               `json:"totalChanged"`
}

// FastPathHeading 快道大纲节点。
type FastPathHeading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
	ID    string `json:"id"`
}

// FastPathDocument 快道提取出的文档。
type FastPathDocument struct {
	Path        string            `json:"path"`
	Title       string            `json:"title"`
	Markdown    string            `json:"markdown"`
	URL         string            `json:"url"`
	ContentHash string            `json:"contentHash"`
	Headings    []FastPathHeading `json:"headings"`
	Metadata    map[string]any    `json:"metadata"`
}

// ContentLiftTelemetry 记录正文 DOM 升维、验证门熔断、SVG 治理与 Goldmark 后验重写可观测计数（Phase 4 R-7）。
type ContentLiftTelemetry struct {
	PagesScanned         int `json:"pagesScanned,omitempty"`
	CardGroupsLifted     int `json:"cardGroupsLifted,omitempty"`
	CardsLifted          int `json:"cardsLifted,omitempty"`
	CardGateFailures     int `json:"cardGateFailures,omitempty"`
	AnchorDegradations   int `json:"anchorDegradations,omitempty"`
	GoldmarkLinkRewrites int `json:"goldmarkLinkRewrites,omitempty"`
	CalloutsLifted       int `json:"calloutsLifted,omitempty"`
	CodeGroupsLifted     int `json:"codeGroupsLifted,omitempty"`
	AccordionsLifted     int `json:"accordionsLifted,omitempty"`
	StepsLifted          int `json:"stepsLifted,omitempty"`
	SvgsStripped         int `json:"svgsStripped,omitempty"`
	SvgsAssetized        int `json:"svgsAssetized,omitempty"`
	ProbedRulesApplied   int `json:"probedRulesApplied,omitempty"`
}

// Merge 将另一组遥测计数累加至当前遥测实体。
func (t *ContentLiftTelemetry) Merge(other ContentLiftTelemetry) {
	if t == nil {
		return
	}
	t.PagesScanned += other.PagesScanned
	t.CardGroupsLifted += other.CardGroupsLifted
	t.CardsLifted += other.CardsLifted
	t.CardGateFailures += other.CardGateFailures
	t.AnchorDegradations += other.AnchorDegradations
	t.GoldmarkLinkRewrites += other.GoldmarkLinkRewrites
	t.CalloutsLifted += other.CalloutsLifted
	t.CodeGroupsLifted += other.CodeGroupsLifted
	t.AccordionsLifted += other.AccordionsLifted
	t.StepsLifted += other.StepsLifted
	t.SvgsStripped += other.SvgsStripped
	t.SvgsAssetized += other.SvgsAssetized
	t.ProbedRulesApplied += other.ProbedRulesApplied
}

// ContainerMappingRule Phase 4 站点级未知容器骨架探测返回的角色映射规则（仅结构槽位，禁止改写正文）。
type ContainerMappingRule struct {
	ContainerSelector string `json:"containerSelector"`
	Role              string `json:"role"` // "card" | "callout" | "ignore"
	CalloutType       string `json:"calloutType,omitempty"`
	TitleSelector     string `json:"titleSelector,omitempty"`
	EyebrowSelector   string `json:"eyebrowSelector,omitempty"`
	BodySelector      string `json:"bodySelector,omitempty"`
	LinkSelector      string `json:"linkSelector,omitempty"`
}

// ContainerSkeleton Phase 4 提取的重复未知容器脱敏最小 DOM 骨架。
type ContainerSkeleton struct {
	Signature   string `json:"signature"`
	Count       int    `json:"count"`
	MinimalHTML string `json:"minimalHtml"`
}

// FastPathScanResult 快道扫描结果。
type FastPathScanResult struct {
	IsStatic        bool                 `json:"isStatic"`
	Document        *FastPathDocument    `json:"document,omitempty"`
	RawHTML         string               `json:"rawHtml,omitempty"`
	DiscoveredURLs  []string             `json:"discoveredUrls,omitempty"`
	NavOrderURLs    []string             `json:"navOrderUrls,omitempty"`
	SidebarSections []WebDocSection        `json:"sidebarSections,omitempty"`
	Telemetry       ContentLiftTelemetry `json:"telemetry,omitempty"`
}

// FirecrawlHeading Firecrawl 兼容大纲节点。
type FirecrawlHeading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
	ID    string `json:"id"`
}

// FirecrawlDoc 网页抓取统一文档实体。
type FirecrawlDoc struct {
	Path        string                `json:"path"`
	Title       string                `json:"title"`
	Markdown    string                `json:"markdown"`
	URL         string                `json:"url"`
	ContentHash string                `json:"contentHash"`
	Headings    []FirecrawlHeading    `json:"headings"`
	Metadata    map[string]any        `json:"metadata"`
	Telemetry   *ContentLiftTelemetry `json:"telemetry,omitempty"`
}

// ModuleTab 识别出的顶层多 Tab 业务维度。
type ModuleTab struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Path  string `json:"path"`
	Kind  string `json:"kind"` // 'doc' | 'api' | 'changelog' | 'external'
}

// CandidateNavBlock 非正文高密度导航候选块（Frame 0 供 LLM 语义裁决，零私有框架硬编码）。
type CandidateNavBlock struct {
	ID          string       `json:"id"`
	RegionHint  string       `json:"regionHint"` // "header" | "sidebar_std" | "outside_main"
	LinkCount   int          `json:"linkCount"`
	SampleLinks []HeaderLink `json:"sampleLinks"`
	node        *html.Node   // 内部 DOM 节点指针，仅供同进程直接提取，不序列化
}

// SidebarTrackHints Frame 0 选定侧栏块的锚点追踪提示（后续内页 0-token 确定性追踪）。
type SidebarTrackHints struct {
	AnchorHrefs []string
}

// SiteTopologyDecision 单次轻量 LLM 拓扑意图裁决契约。
type SiteTopologyDecision struct {
	PrimaryDocPrefix string      `json:"primaryDocPrefix"`
	ApiReferenceURL  string      `json:"apiReferenceUrl,omitempty"`
	ExcludePrefixes  []string    `json:"excludePrefixes"`
	ModuleTabs       []ModuleTab `json:"moduleTabs"`
	SidebarBlockID   string      `json:"sidebarBlockId,omitempty"`
	// 内部物化产物（由 ResolveSiteTopologyIntent 原地消费 SidebarBlockID 产出，不上 wire）
	ResolvedSidebarSections []WebDocSection `json:"-"`
	SidebarAnchorHrefs      []string        `json:"-"`
}

// HeaderLink 页面顶部/导航栏提取出的链接元组。
type HeaderLink struct {
	Text string `json:"text"`
	Href string `json:"href"`
}

// WebDocNavItem 侧栏条目（对应 OutlineChapter / OutlineNode）。
type WebDocNavItem struct {
	Title    string          `json:"title"`
	Href     string          `json:"href"`
	Order    int             `json:"order"`
	Children []WebDocNavItem `json:"children,omitempty"`
}

// WebDocSection 侧栏分组（对应系统正典 OutlinePart）。
type WebDocSection struct {
	Title string          `json:"title"` // 如 "Introduction", "Build", "Integrate"
	Order int             `json:"order"`
	Items []WebDocNavItem `json:"items"`
}

// LandingTopology 落地页 DOM 轻量探测提取的骨架特征（Frame 0）。
type LandingTopology struct {
	EntryURL          string              `json:"entryUrl"`
	SiteTitle         string              `json:"siteTitle"`
	HeaderLinks       []HeaderLink        `json:"headerLinks"`
	CandidatePrefixes []string            `json:"candidatePrefixes"`
	NavBlocks         []CandidateNavBlock `json:"navBlocks,omitempty"`
	// SidebarHeadings 侧栏桶（<aside> 子树 + 非顶栏 nav）链接文本，即站点章节名预览。
	// 仅展示型数据（确认卡"章节已包含"安心感），不参与作用域裁决；cap 10 是截断上限而非站点事实。
	SidebarHeadings []string        `json:"sidebarHeadings"`
	SidebarSections []WebDocSection `json:"sidebarSections,omitempty"`
}

// OutlineNode OutlineDraft 节点。
type OutlineNode struct {
	Title      string `json:"title"`
	NodeType   string `json:"nodeType"`
	SourcePath string `json:"sourcePath"`
}

// StoredOutlineChapter 数据库持久化章。
type StoredOutlineChapter struct {
	Title         string        `json:"title"`
	ChapterType   string        `json:"chapterType"`
	TeachingOrder int           `json:"teachingOrder"`
	Nodes         []OutlineNode `json:"nodes"`
	PartTitle     string        `json:"partTitle,omitempty"`
	Summary       *string       `json:"summary,omitempty"`
}

// OutlinePart 大类。
type OutlinePart struct {
	Title         string  `json:"title"`
	TeachingOrder int     `json:"teachingOrder"`
	Summary       *string `json:"summary,omitempty"`
}

// OutlineDraft 大纲草稿。
type OutlineDraft struct {
	Parts    []OutlinePart          `json:"parts"`
	Chapters []StoredOutlineChapter `json:"chapters"`
}

// CrawlOptions fast-path BFS 批量抓取配置（支持前缀作用域收敛与黑洞拦截）。
type CrawlOptions struct {
	MaxPages         int
	PrimaryDocPrefix string
	AllowedPrefixes  []string
	ExcludePrefixes  []string
	SeedScan         *FastPathScanResult
	SidebarHints     *SidebarTrackHints
	Emit             func(eventType string, payload map[string]any)
}

// CrawlFilters 爬取路径过滤规则。
type CrawlFilters struct {
	IncludePaths []string `json:"includePaths,omitempty"`
	ExcludePaths []string `json:"excludePaths,omitempty"`
}

// FirecrawlAPI 爬虫抓取接口。
type FirecrawlAPI interface {
	ScrapeUrl(ctx context.Context, targetURL string) (*FirecrawlDoc, error)
	Crawl(ctx context.Context, rootURL string, limit int, filters *CrawlFilters) ([]FirecrawlDoc, error)
}
