package webdoc

import (
	"context"

	"golang.org/x/net/html"
)

type WebDocDiffRequest struct {
	RootURL     string            `json:"rootUrl"`
	PrevETag    string            `json:"prevEtag,omitempty"`
	PrevLastMod map[string]string `json:"prevLastMod,omitempty"`
	TimeoutMs   int               `json:"timeoutMs,omitempty"`
}

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

type FastPathHeading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
	ID    string `json:"id"`
}

type FastPathDocument struct {
	Path        string            `json:"path"`
	Title       string            `json:"title"`
	Markdown    string            `json:"markdown"`
	URL         string            `json:"url"`
	ContentHash string            `json:"contentHash"`
	Headings    []FastPathHeading `json:"headings"`
	Metadata    map[string]any    `json:"metadata"`
}

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

type ContainerMappingRule struct {
	ContainerSelector string `json:"containerSelector"`
	Role              string `json:"role"`
	CalloutType       string `json:"calloutType,omitempty"`
	TitleSelector     string `json:"titleSelector,omitempty"`
	EyebrowSelector   string `json:"eyebrowSelector,omitempty"`
	BodySelector      string `json:"bodySelector,omitempty"`
	LinkSelector      string `json:"linkSelector,omitempty"`
}

type ContainerSkeleton struct {
	Signature   string `json:"signature"`
	Count       int    `json:"count"`
	MinimalHTML string `json:"minimalHtml"`
}

type FastPathScanResult struct {
	IsStatic        bool                 `json:"isStatic"`
	Document        *FastPathDocument    `json:"document,omitempty"`
	RawHTML         string               `json:"rawHtml,omitempty"`
	DiscoveredURLs  []string             `json:"discoveredUrls,omitempty"`
	NavOrderURLs    []string             `json:"navOrderUrls,omitempty"`
	SidebarSections []WebDocSection      `json:"sidebarSections,omitempty"`
	Telemetry       ContentLiftTelemetry `json:"telemetry,omitempty"`
}

type FirecrawlHeading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
	ID    string `json:"id"`
}

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

type ModuleTab struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Path  string `json:"path"`
	Kind  string `json:"kind"`
}

type CandidateNavBlock struct {
	ID          string       `json:"id"`
	RegionHint  string       `json:"regionHint"`
	LinkCount   int          `json:"linkCount"`
	SampleLinks []HeaderLink `json:"sampleLinks"`
	node        *html.Node
}

type SidebarTrackHints struct {
	AnchorHrefs []string
}

type SiteTopologyDecision struct {
	PrimaryDocPrefix        string          `json:"primaryDocPrefix"`
	ApiReferenceURL         string          `json:"apiReferenceUrl,omitempty"`
	ExcludePrefixes         []string        `json:"excludePrefixes"`
	ModuleTabs              []ModuleTab     `json:"moduleTabs"`
	SidebarBlockID          string          `json:"sidebarBlockId,omitempty"`
	ResolvedSidebarSections []WebDocSection `json:"-"`
	SidebarAnchorHrefs      []string        `json:"-"`
}

type HeaderLink struct {
	Text string `json:"text"`
	Href string `json:"href"`
}

type WebDocNavItem struct {
	Title    string          `json:"title"`
	Href     string          `json:"href"`
	Order    int             `json:"order"`
	Children []WebDocNavItem `json:"children,omitempty"`
}

type WebDocSection struct {
	Title string          `json:"title"`
	Order int             `json:"order"`
	Items []WebDocNavItem `json:"items"`
}

type LandingTopology struct {
	EntryURL          string              `json:"entryUrl"`
	SiteTitle         string              `json:"siteTitle"`
	HeaderLinks       []HeaderLink        `json:"headerLinks"`
	CandidatePrefixes []string            `json:"candidatePrefixes"`
	NavBlocks         []CandidateNavBlock `json:"navBlocks,omitempty"`
	SidebarHeadings   []string            `json:"sidebarHeadings"`
	SidebarSections   []WebDocSection     `json:"sidebarSections,omitempty"`
}

type OutlineNode struct {
	Title      string `json:"title"`
	NodeType   string `json:"nodeType"`
	SourcePath string `json:"sourcePath"`
}

type StoredOutlineChapter struct {
	Title         string        `json:"title"`
	ChapterType   string        `json:"chapterType"`
	TeachingOrder int           `json:"teachingOrder"`
	Nodes         []OutlineNode `json:"nodes"`
	PartTitle     string        `json:"partTitle,omitempty"`
	Summary       *string       `json:"summary,omitempty"`
}

type OutlinePart struct {
	Title         string  `json:"title"`
	TeachingOrder int     `json:"teachingOrder"`
	Summary       *string `json:"summary,omitempty"`
}

type OutlineDraft struct {
	Parts    []OutlinePart          `json:"parts"`
	Chapters []StoredOutlineChapter `json:"chapters"`
}

type CrawlOptions struct {
	MaxPages         int
	PrimaryDocPrefix string
	AllowedPrefixes  []string
	ExcludePrefixes  []string
	SeedScan         *FastPathScanResult
	SidebarHints     *SidebarTrackHints
	Emit             func(eventType string, payload map[string]any)
}

type CrawlFilters struct {
	IncludePaths []string `json:"includePaths,omitempty"`
	ExcludePaths []string `json:"excludePaths,omitempty"`
}

type FirecrawlAPI interface {
	ScrapeUrl(ctx context.Context, targetURL string) (*FirecrawlDoc, error)
	Crawl(ctx context.Context, rootURL string, limit int, filters *CrawlFilters) ([]FirecrawlDoc, error)
}
