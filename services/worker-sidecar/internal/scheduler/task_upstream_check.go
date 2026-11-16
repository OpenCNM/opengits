package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/platform/policy"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

// ─────────────────────────────────────────────────────────────
// 上游变更提醒探测（原移植自 TS upstream-check.ts 的 checkUpstreamOnce；TS 原体已退役，本包为唯一实现；
// GitHub 分支头条件探测 If-None-Match → 304 零配额 / 200 比对红点；
// Web 官方文档站由 Go 原生 DetectWebDocDiff 探测接管，消除探测窗口饿死风险）。
// 讲法维度：同 (owner, repo, branch) 组内只调一次 GitHub API，结果写回组内所有行；
// 同一 originalUrl 的 web 库组内只调一次 Sitemap 差分探测。
// ─────────────────────────────────────────────────────────────

// RepoRow upstream-check 的仓行 select（对齐 upstream-check.ts findMany select）。
type RepoRow struct {
	ID          string
	Owner       string
	Repo        string
	Branch      string
	GitSha      *string
	HasUpd      bool
	Etag        *string
	ProfileJSON []byte
}

// BranchHeadProbe 对齐 github-api.ts BranchHeadProbe。
type BranchHeadProbe struct {
	// Status: changed=有新 commit（sha 必有）；not-modified=304
	Status string
	SHA    string
	// ETag 响应原文（含 W/"…" 引号）；304 且响应无 ETag 时沿用传入的 previousEtag
	ETag string
}

var gwPolicy = policy.NewGatewayPolicy()

// ResetGatewayPolicyForTest 重置网关策略缓存供测试使用。
func ResetGatewayPolicyForTest() {
	gwPolicy.Reset()
}

func isEmergencyReadOnly(ctx context.Context, store policy.EmergencyReadOnlyReader) bool {
	return gwPolicy.IsEmergencyReadOnly(ctx, store)
}

// FetchBranchHead GET /repos/{o}/{r}/commits/{branch}，支持 If-None-Match。
// 非 200/304 一律抛错（限流/网络/私仓不可见），调用方保留旧状态不动。
func FetchBranchHead(ctx context.Context, cfg Config, owner, repo, branch, ifNoneMatch string) (BranchHeadProbe, error) {
	u := fmt.Sprintf("%s/repos/%s/%s/commits/%s",
		cfg.GitHubAPIBase, url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return BranchHeadProbe{}, err
	}
	req.Header.Set("User-Agent", cfg.UserAgent)
	if cfg.GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.GitHubToken)
	}
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	resp, err := client.GithubProbeHTTP.Do(req)
	if err != nil {
		return BranchHeadProbe{}, fmt.Errorf("[RepoTarball] probe failed for %s/%s@%s: %w", owner, repo, branch, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified {
		etag := resp.Header.Get("ETag")
		if etag == "" {
			etag = ifNoneMatch
		}
		return BranchHeadProbe{Status: "not-modified", ETag: etag}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return BranchHeadProbe{}, fmt.Errorf("[RepoTarball] Failed to resolve sha for %s/%s@%s: HTTP %d", owner, repo, branch, resp.StatusCode)
	}
	var data struct {
		SHA string `json:"sha"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&data); err != nil {
		return BranchHeadProbe{}, err
	}
	if data.SHA == "" {
		return BranchHeadProbe{}, fmt.Errorf("[RepoTarball] No sha returned for %s/%s@%s", owner, repo, branch)
	}
	return BranchHeadProbe{Status: "changed", SHA: data.SHA, ETag: resp.Header.Get("ETag")}, nil
}

func fetchBranchHead(ctx context.Context, cfg Config, owner, repo, branch, ifNoneMatch string) (BranchHeadProbe, error) {
	return FetchBranchHead(ctx, cfg, owner, repo, branch, ifNoneMatch)
}

// profileSourceType 解析 repoProfile.sourceType（容错：坏 JSON 视为非 web）。
func profileSourceType(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var p struct {
		SourceType string `json:"sourceType"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return ""
	}
	return p.SourceType
}

// parseWebProfile 解析 repoProfile 中的 originalUrl 与 sitemapLastModMap。
func parseWebProfile(raw []byte) (string, map[string]string) {
	if len(raw) == 0 {
		return "", nil
	}
	var p struct {
		SourceType        string            `json:"sourceType"`
		OriginalURL       string            `json:"originalUrl"`
		SitemapLastModMap map[string]string `json:"sitemapLastModMap"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return "", nil
	}
	if p.SourceType != "web" {
		return "", nil
	}
	return p.OriginalURL, p.SitemapLastModMap
}

// CheckUpstreamOnce 单轮执行上游变更提醒探测（GitHub 与 Web 文档站）。
func CheckUpstreamOnce(ctx context.Context, cfg Config, store TaskStore) {
	// 紧急只读熔断：跳过本轮探测与红点写入（策略库故障 fail-open）
	if isEmergencyReadOnly(ctx, store) {
		log.Printf("[upstream-check] emergency read-only active, skip this cycle")
		return
	}
	intervalMin := envIntervalMinOr("UPSTREAM_CHECK_INTERVAL_MIN", 360)
	// leader 租约：与 Node upstream-check 同 key（探测配额与写放大都不可双跑）
	if !acquireLease(ctx, store, "upstream-check", leaseTtlFromInterval(time.Duration(intervalMin)*time.Minute)) {
		log.Printf("[upstream-check] lease held elsewhere, skip this cycle")
		return
	}

	repos, err := store.ReposForUpstreamCheck(ctx, cfg.UpstreamMaxReposPerCycle)
	if err != nil {
		log.Printf("[upstream-check] repository list failed: %v", err)
		return
	}

	// ── Web 文档站原生差分探测 ──
	type webProbeOutcome struct {
		hasChanges        bool
		etag              string
		sitemapLastModMap map[string]string
		valid             bool
	}
	probedWebGroups := map[string]webProbeOutcome{}

	// ── Phase A：distinct 组并发探测（此前逐仓串行，一轮尾延迟=最慢仓）──
	type webGroup struct {
		origURL     string
		etag        string
		lastModMap  map[string]string
		firstRepo   RepoRow
	}
	webGroupOrder := []string{}
	webGroupByKey := map[string]*webGroup{}
	for _, repo := range repos {
		if profileSourceType(repo.ProfileJSON) != "web" {
			continue
		}
		origURL, lastModMap := parseWebProfile(repo.ProfileJSON)
		if origURL == "" {
			continue
		}
		if g, ok := webGroupByKey[origURL]; ok {
			// 组内任一行存的 etag 都可作条件凭证——沿用首行
			_ = g
			continue
		}
		webGroupByKey[origURL] = &webGroup{origURL: origURL, etag: derefStr(repo.Etag), lastModMap: lastModMap, firstRepo: repo}
		webGroupOrder = append(webGroupOrder, origURL)
	}
	if len(webGroupOrder) > 0 {
		var wg sync.WaitGroup
		sem := make(chan struct{}, 4) // 有界并发：GitHub client 自带 429 退避
		for _, origURL := range webGroupOrder {
			g := webGroupByKey[origURL]
			wg.Add(1)
			go func() {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				diff, err := webdoc.DetectWebDocDiff(ctx, g.origURL, g.etag, g.lastModMap, 15*time.Second)
				if err != nil {
					log.Printf("[upstream-check] web probe failed for %s/%s (%s): %v", g.firstRepo.Owner, g.firstRepo.Repo, g.origURL, err)
					return
				}
				// 写侧并发安全：distinct 组互不相交的 key
				probedWebGroups[g.origURL] = webProbeOutcome{
					hasChanges:        diff.HasChanges,
					etag:              diff.ETag,
					sitemapLastModMap: diff.SitemapLastModMap,
					valid:             true,
				}
			}()
		}
		wg.Wait()
	}

	// ── Phase B：串行写回（组内复用探测结果，写序与旧串行版一致）──
	for _, repo := range repos {
		if profileSourceType(repo.ProfileJSON) != "web" {
			continue
		}
		origURL, _ := parseWebProfile(repo.ProfileJSON)
		if origURL == "" {
			continue
		}
		outcome, hasGroup := probedWebGroups[origURL]
		if !hasGroup || !outcome.valid {
			continue
		}

		var etagPtr *string
		if outcome.etag != "" {
			etagPtr = &outcome.etag
		}
		if err := store.WriteUpstreamWebChecked(ctx, repo.ID, outcome.hasChanges, etagPtr, outcome.sitemapLastModMap); err != nil {
			log.Printf("[upstream-check] write web upstream checked failed for %s/%s: %v", repo.Owner, repo.Repo, err)
		}
	}

	// ── GitHub 代码仓上游探测 ──
	type probeOutcome struct {
		kind  string // not-modified | changed
		sha   string
		etag  string
		valid bool
	}
	probedGroups := map[string]probeOutcome{}

	// Phase A：distinct (owner/repo@branch) 组并发探测
	type ghGroup struct {
		key       string
		owner     string
		repo      string
		branch    string
		etag      string
		firstRepo RepoRow
	}
	ghGroupOrder := []string{}
	ghGroupByKey := map[string]*ghGroup{}
	for _, repo := range repos {
		if profileSourceType(repo.ProfileJSON) == "web" {
			continue
		}
		groupKey := repo.Owner + "/" + repo.Repo + "@" + repo.Branch
		if _, ok := ghGroupByKey[groupKey]; ok {
			continue
		}
		ghGroupByKey[groupKey] = &ghGroup{key: groupKey, owner: repo.Owner, repo: repo.Repo, branch: repo.Branch, etag: derefStr(repo.Etag), firstRepo: repo}
		ghGroupOrder = append(ghGroupOrder, groupKey)
	}
	if len(ghGroupOrder) > 0 {
		var wg sync.WaitGroup
		sem := make(chan struct{}, 4)
		for _, groupKey := range ghGroupOrder {
			g := ghGroupByKey[groupKey]
			wg.Add(1)
			go func() {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				probe, err := fetchBranchHead(ctx, cfg, g.owner, g.repo, g.branch, g.etag)
				if err != nil {
					// 单仓探测失败保留原标记与旧 etag，不动
					log.Printf("[upstream-check] probe failed for %s/%s: %v", g.owner, g.repo, err)
					return
				}
				probedGroups[g.key] = probeOutcome{kind: probe.Status, sha: probe.SHA, etag: probe.ETag, valid: true}
			}()
		}
		wg.Wait()
	}

	// Phase B：串行写回（写序与旧串行版一致）
	for _, repo := range repos {
		if profileSourceType(repo.ProfileJSON) == "web" {
			continue
		}

		groupKey := repo.Owner + "/" + repo.Repo + "@" + repo.Branch
		outcome, hasGroup := probedGroups[groupKey]
		if !hasGroup || !outcome.valid {
			continue
		}

		if outcome.kind == "not-modified" {
			// 304 快路径：零配额确认"没变"，仅刷新检查时间（不动红点冻结语义）
			var etagPtr *string
			if outcome.etag != "" {
				etagPtr = &outcome.etag
			}
			if err := store.TouchUpstreamChecked(ctx, repo.Owner, repo.Repo, repo.Branch, etagPtr); err != nil {
				log.Printf("[upstream-check] touch-304 failed for %s/%s: %v", repo.Owner, repo.Repo, err)
			}
			continue
		}

		// changed：比对 gitSha 置/清小红点 + 落新 sha 头的 etag
		hasUpdate := repo.GitSha != nil && *repo.GitSha != "" && *repo.GitSha != outcome.sha
		var etagPtr *string
		if outcome.etag != "" {
			etagPtr = &outcome.etag
		}
		if err := store.WriteUpstreamChanged(ctx, repo.Owner, repo.Repo, repo.Branch, hasUpdate, etagPtr); err != nil {
			log.Printf("[upstream-check] write-reddot failed for %s/%s: %v", repo.Owner, repo.Repo, err)
		}
	}
}

func checkUpstreamOnce(ctx context.Context, cfg Config, store TaskStore) {
	CheckUpstreamOnce(ctx, cfg, store)
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}
