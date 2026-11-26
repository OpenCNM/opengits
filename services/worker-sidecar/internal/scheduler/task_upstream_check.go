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

type BranchHeadProbe struct {
	Status string
	SHA    string
	ETag   string
}

var gwPolicy = policy.NewGatewayPolicy()

func ResetGatewayPolicyForTest() {
	gwPolicy.Reset()
}

func isEmergencyReadOnly(ctx context.Context, store policy.EmergencyReadOnlyReader) bool {
	return gwPolicy.IsEmergencyReadOnly(ctx, store)
}

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

func CheckUpstreamOnce(ctx context.Context, cfg Config, store TaskStore) {
	if isEmergencyReadOnly(ctx, store) {
		log.Printf("[upstream-check] emergency read-only active, skip this cycle")
		return
	}
	intervalMin := envIntervalMinOr("UPSTREAM_CHECK_INTERVAL_MIN", 360)
	if !acquireLease(ctx, store, "upstream-check", leaseTtlFromInterval(time.Duration(intervalMin)*time.Minute)) {
		log.Printf("[upstream-check] lease held elsewhere, skip this cycle")
		return
	}

	repos, err := store.ReposForUpstreamCheck(ctx, cfg.UpstreamMaxReposPerCycle)
	if err != nil {
		log.Printf("[upstream-check] repository list failed: %v", err)
		return
	}

	type webProbeOutcome struct {
		hasChanges        bool
		etag              string
		sitemapLastModMap map[string]string
		valid             bool
	}
	probedWebGroups := map[string]webProbeOutcome{}

	type webGroup struct {
		origURL    string
		etag       string
		lastModMap map[string]string
		firstRepo  RepoRow
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
			_ = g
			continue
		}
		webGroupByKey[origURL] = &webGroup{origURL: origURL, etag: derefStr(repo.Etag), lastModMap: lastModMap, firstRepo: repo}
		webGroupOrder = append(webGroupOrder, origURL)
	}
	if len(webGroupOrder) > 0 {
		var wg sync.WaitGroup
		sem := make(chan struct{}, 4)
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

	type probeOutcome struct {
		kind  string
		sha   string
		etag  string
		valid bool
	}
	probedGroups := map[string]probeOutcome{}

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
	// Group probes by distinct repo/URL before serializing DB writes to cut tail latency without write races.
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
					log.Printf("[upstream-check] probe failed for %s/%s: %v", g.owner, g.repo, err)
					return
				}
				probedGroups[g.key] = probeOutcome{kind: probe.Status, sha: probe.SHA, etag: probe.ETag, valid: true}
			}()
		}
		wg.Wait()
	}

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
			var etagPtr *string
			if outcome.etag != "" {
				etagPtr = &outcome.etag
			}
			if err := store.TouchUpstreamChecked(ctx, repo.Owner, repo.Repo, repo.Branch, etagPtr); err != nil {
				log.Printf("[upstream-check] touch-304 failed for %s/%s: %v", repo.Owner, repo.Repo, err)
			}
			continue
		}

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
