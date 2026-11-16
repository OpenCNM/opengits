package webdoc

import (
	"container/list"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// ─────────────────────────────────────────────────────────────
// WebDoc HTTP Handler (内部微服务端点)
// 挂载于 /v1/web-doc/*，全部经 s.internal 鉴权保护
// 接入 internal/platform/httpx 统一限流与错误信封规范
// ─────────────────────────────────────────────────────────────

// HandleDiff handles POST /v1/web-doc/diff (增量差分检测).
func HandleDiff(w http.ResponseWriter, r *http.Request) {
	var req WebDocDiffRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if req.RootURL == "" {
		httpx.Error(w, http.StatusBadRequest, "rootUrl is required")
		return
	}

	timeout := 8 * time.Second
	if req.TimeoutMs > 0 {
		timeout = time.Duration(req.TimeoutMs) * time.Millisecond
	}

	res, err := DetectWebDocDiff(r.Context(), req.RootURL, req.PrevETag, req.PrevLastMod, timeout)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "diff detection failed: "+err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, res)
}

// ─────────────────────────────────────────────────────────────
// 拓扑探测端点（导入确认页 scout 数据源）
// ─────────────────────────────────────────────────────────────

// TopologyRequest POST /v1/web-doc/topology 入参。
// 无客户端可调超时旋钮：内部硬预算 = 快道扫描 14s + LLM 裁决自限 8s（总代理超时 25s）。
type TopologyRequest struct {
	URL         string `json:"url"`
	UserID      string `json:"userId"` // BYOK 网关按 userId 解析用户 key；空 = 匿名（fail-closed 至默认决策）
	BypassCache bool   `json:"bypassCache,omitempty"`
}

// TopologyResponse 落地页拓扑探测响应：确认页 Chips、推荐作用域与
// naturalPrefix 的唯一数据源（前端不在本地重复推导自然前缀）。
type TopologyResponse struct {
	SiteTitle         string      `json:"siteTitle"`
	EntryURL          string      `json:"entryUrl"`
	NaturalPrefix     string      `json:"naturalPrefix"`
	PrimaryDocPrefix  string      `json:"primaryDocPrefix"`
	CandidatePrefixes []string    `json:"candidatePrefixes"`
	ModuleTabs        []ModuleTab `json:"moduleTabs"`
	ExcludePrefixes   []string    `json:"excludePrefixes"`
	ApiReferenceURL   string      `json:"apiReferenceUrl,omitempty"`
	// SidebarHeadings 侧栏章节名预览（展示型数据，不参与作用域裁决）
	SidebarHeadings []string `json:"sidebarHeadings"`
	ScoutStatus     string   `json:"scoutStatus"`             // "multi_module" | "single_module" | "scan_failed"
	FailureReason   string   `json:"failureReason,omitempty"`
}

// topologyScanBudget 单页快道扫描硬预算 14s（LLM 裁决另有 ResolveSiteTopologyIntent 内部 8s 自限）。
const topologyScanBudget = 14 * time.Second

const (
	seedCacheTTL              = 2 * time.Minute
	seedCacheMaxEntries       = 32
	seedCacheMaxRawBytes      = 32 << 20
	seedCacheSingleRawMaxSize = 4 << 20
)

type seedTopologyEntry struct {
	key         string
	seedScan    *FastPathScanResult
	landingTopo *LandingTopology
	decision    *SiteTopologyDecision
	rawBytes    int
	expiresAt   time.Time
}

type seedTopologyLRU struct {
	mu         sync.Mutex
	entries    map[string]*list.Element
	order      *list.List
	totalBytes int
}

var seedTopoCache = &seedTopologyLRU{
	entries: make(map[string]*list.Element),
	order:   list.New(),
}

func resetSeedTopologyCache() {
	seedTopoCache.mu.Lock()
	seedTopoCache.entries = make(map[string]*list.Element)
	seedTopoCache.order = list.New()
	seedTopoCache.totalBytes = 0
	seedTopoCache.mu.Unlock()
}

func (c *seedTopologyLRU) removeElement(el *list.Element) {
	if el == nil {
		return
	}
	entry := el.Value.(*seedTopologyEntry)
	c.order.Remove(el)
	delete(c.entries, entry.key)
	c.totalBytes -= entry.rawBytes
	if c.totalBytes < 0 {
		c.totalBytes = 0
	}
}

func (c *seedTopologyLRU) Get(rawURL string) *seedTopologyEntry {
	key := normalizeCrawlURL(rawURL)
	if key == "" {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.entries[key]
	if !ok {
		return nil
	}
	entry := el.Value.(*seedTopologyEntry)
	if time.Now().After(entry.expiresAt) {
		c.removeElement(el)
		return nil
	}
	return entry
}

func (c *seedTopologyLRU) Set(rawURL string, scan *FastPathScanResult, topo *LandingTopology, dec *SiteTopologyDecision) {
	key := normalizeCrawlURL(rawURL)
	if key == "" || scan == nil || scan.Document == nil {
		return
	}
	storedScan := scan
	rawLen := len(scan.RawHTML)
	if rawLen > seedCacheSingleRawMaxSize {
		cp := *scan
		cp.RawHTML = ""
		if cp.Document != nil {
			docCp := *cp.Document
			cp.Document = &docCp
		}
		storedScan = &cp
		rawLen = 0
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.entries[key]; ok {
		c.removeElement(existing)
	}
	entry := &seedTopologyEntry{
		key:         key,
		seedScan:    storedScan,
		landingTopo: topo,
		decision:    dec,
		rawBytes:    rawLen,
		expiresAt:   time.Now().Add(seedCacheTTL),
	}
	el := c.order.PushBack(entry)
	c.entries[key] = el
	c.totalBytes += rawLen

	for c.order.Len() > seedCacheMaxEntries || c.totalBytes > seedCacheMaxRawBytes {
		oldest := c.order.Front()
		if oldest == nil {
			break
		}
		c.removeElement(oldest)
	}
}

func flattenSidebarHeadings(sections []WebDocSection, maxCap int) []string {
	if len(sections) == 0 || maxCap <= 0 {
		return nil
	}
	seen := make(map[string]bool, maxCap)
	out := make([]string, 0, maxCap)
	var walkItems func([]WebDocNavItem)
	walkItems = func(items []WebDocNavItem) {
		for _, it := range items {
			if len(out) >= maxCap {
				return
			}
			t := strings.TrimSpace(it.Title)
			if len(t) > 120 {
				t = truncateRunes(t, 120)
			}
			if t != "" && !seen[t] {
				seen[t] = true
				out = append(out, t)
			}
			if len(it.Children) > 0 && len(out) < maxCap {
				walkItems(it.Children)
			}
		}
	}
	for _, sec := range sections {
		if len(out) >= maxCap {
			break
		}
		walkItems(sec.Items)
	}
	return out
}

// TopologyHandler 轻量拓扑探测处理器（构造期注入 LLM，daemon.Run 装配）。
type TopologyHandler struct {
	llm LLMGenerator
}

// NewTopologyHandler 构造期确定性接线 LLM 裁决器（llm 可为 nil：确定性短路直接返回默认决策）。
func NewTopologyHandler(llm LLMGenerator) *TopologyHandler {
	return &TopologyHandler{llm: llm}
}

// HandleTopology handles POST /v1/web-doc/topology.
// 抓取失败显式返回 scoutStatus=scan_failed，成功时区分 multi_module / single_module，不抛 5xx。
func (h *TopologyHandler) HandleTopology(w http.ResponseWriter, r *http.Request) {
	var req TopologyRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}
	if req.URL == "" {
		httpx.Error(w, http.StatusBadRequest, "url is required")
		return
	}

	natural := DeriveNaturalPrefix(req.URL)
	resp := TopologyResponse{
		EntryURL:          req.URL,
		NaturalPrefix:     natural,
		PrimaryDocPrefix:  natural,
		CandidatePrefixes: []string{},
		ModuleTabs:        []ModuleTab{},
		ExcludePrefixes:   []string{},
		SidebarHeadings:   []string{},
		ScoutStatus:       "scan_failed",
	}

	buildReadyResp := func(landingTopo *LandingTopology, decision *SiteTopologyDecision) {
		if landingTopo.SiteTitle != "" {
			resp.SiteTitle = landingTopo.SiteTitle
		}
		if len(landingTopo.CandidatePrefixes) > 0 {
			resp.CandidatePrefixes = landingTopo.CandidatePrefixes
		}
		if len(landingTopo.SidebarHeadings) > 0 {
			resp.SidebarHeadings = landingTopo.SidebarHeadings
		}
		if decision != nil {
			resp.PrimaryDocPrefix = decision.PrimaryDocPrefix
			resp.ModuleTabs = decision.ModuleTabs
			resp.ExcludePrefixes = decision.ExcludePrefixes
			resp.ApiReferenceURL = decision.ApiReferenceURL
			if len(decision.ResolvedSidebarSections) > 0 {
				if headings := flattenSidebarHeadings(decision.ResolvedSidebarSections, 10); len(headings) > 0 {
					resp.SidebarHeadings = headings
				}
			}
		}
		if len(resp.ModuleTabs) >= 2 {
			resp.ScoutStatus = "multi_module"
		} else {
			resp.ScoutStatus = "single_module"
		}
		resp.FailureReason = ""
	}

	if !req.BypassCache {
		if cached := seedTopoCache.Get(req.URL); cached != nil && cached.landingTopo != nil {
			buildReadyResp(cached.landingTopo, cached.decision)
			httpx.WriteJSON(w, http.StatusOK, resp)
			return
		}
	}

	// 落地页快道扫描（网络栈内置 SSRF 拦截与礼貌延迟，此处不重复校验）
	scan, err := ScanFastPathPage(r.Context(), req.URL, topologyScanBudget)
	if err != nil {
		resp.FailureReason = err.Error()
		httpx.WriteJSON(w, http.StatusOK, resp)
		return
	}
	if scan == nil || scan.Document == nil {
		resp.FailureReason = "landing page fetch timed out or non-static"
		httpx.WriteJSON(w, http.StatusOK, resp)
		return
	}
	seedHtml := scan.RawHTML
	if seedHtml == "" {
		if rawHtml, ok := scan.Document.Metadata["html"].(string); ok {
			seedHtml = rawHtml
		} else if rawHtml, ok := scan.Document.Metadata["rawHtml"].(string); ok {
			seedHtml = rawHtml
		}
	}
	if seedHtml == "" {
		resp.FailureReason = "empty html response"
		httpx.WriteJSON(w, http.StatusOK, resp)
		return
	}

	landingTopo := ExtractLandingTopology(seedHtml, req.URL)
	if landingTopo == nil {
		resp.FailureReason = "topology extraction returned nil"
		httpx.WriteJSON(w, http.StatusOK, resp)
		return
	}

	var uidPtr *string
	if req.UserID != "" {
		uidPtr = &req.UserID
	}
	decision := ResolveSiteTopologyIntent(r.Context(), h.llm, landingTopo, uidPtr)
	if decision != nil && len(decision.ResolvedSidebarSections) > 0 {
		landingTopo.SidebarSections = decision.ResolvedSidebarSections
		scanCp := *scan
		scanCp.SidebarSections = decision.ResolvedSidebarSections
		scan = &scanCp
	}

	buildReadyResp(landingTopo, decision)
	seedTopoCache.Set(req.URL, scan, landingTopo, decision)

	httpx.WriteJSON(w, http.StatusOK, resp)
}
