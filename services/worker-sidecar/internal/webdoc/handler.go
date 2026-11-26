package webdoc

import (
	"container/list"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

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

type TopologyRequest struct {
	URL         string `json:"url"`
	UserID      string `json:"userId"`
	BypassCache bool   `json:"bypassCache,omitempty"`
}

type TopologyResponse struct {
	SiteTitle         string      `json:"siteTitle"`
	EntryURL          string      `json:"entryUrl"`
	NaturalPrefix     string      `json:"naturalPrefix"`
	PrimaryDocPrefix  string      `json:"primaryDocPrefix"`
	CandidatePrefixes []string    `json:"candidatePrefixes"`
	ModuleTabs        []ModuleTab `json:"moduleTabs"`
	ExcludePrefixes   []string    `json:"excludePrefixes"`
	ApiReferenceURL   string      `json:"apiReferenceUrl,omitempty"`
	SidebarHeadings   []string    `json:"sidebarHeadings"`
	ScoutStatus       string      `json:"scoutStatus"`
	FailureReason     string      `json:"failureReason,omitempty"`
}

// Enforce 14s scan budget inside 25s handler timeout so 8s LLM intent resolution retains headroom.
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

type TopologyHandler struct {
	llm LLMGenerator
}

func NewTopologyHandler(llm LLMGenerator) *TopologyHandler {
	return &TopologyHandler{llm: llm}
}

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
