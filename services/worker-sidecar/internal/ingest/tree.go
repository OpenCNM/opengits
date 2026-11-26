package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
	ghclient "github.com/opengits/worker-sidecar/internal/platform/client"
)

func resolveViaGit(ctx context.Context, owner, repo, branch string) (string, error) {
	targetBranch := branch
	if targetBranch == "" {
		targetBranch = "HEAD"
	}
	repoURL := fmt.Sprintf("https://github.com/%s/%s.git", owner, repo)
	// Fetch full ls-remote list without ref pattern because HTTP proxies often strip smart-HTTP ref-filter args.
	cmd := exec.CommandContext(ctx, "git", "ls-remote", repoURL)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git ls-remote failed: %w", err)
	}
	lines := strings.Split(stdout.String(), "\n")
	for _, line := range lines {
		fields := strings.Fields(line)
		// Accept both 40-char SHA-1 and 64-char SHA-256 hashes and match target ref suffix.
		if len(fields) >= 2 && (len(fields[0]) == 40 || len(fields[0]) == 64) && isHex(fields[0]) {
			if refMatchesTarget(fields[1], targetBranch) {
				return fields[0], nil
			}
		}
	}
	return "", fmt.Errorf("git ls-remote returned no valid SHA for ref %q", targetBranch)
}

func isHex(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func refMatchesTarget(ref, target string) bool {
	if target == "" || target == "HEAD" {
		return ref == "HEAD"
	}
	for _, prefix := range []string{"refs/heads/", "refs/tags/"} {
		if strings.HasPrefix(ref, prefix) && ref[len(prefix):] == target {
			return true
		}
	}
	return ref == target
}

func fetchBranchHead(ctx context.Context, cfg Config, owner, repo, branch string) (string, error) {
	apiBase := cfg.GitHubAPIBase
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	u := fmt.Sprintf("%s/repos/%s/%s/commits/%s",
		apiBase, url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if cfg.UserAgent != "" {
		req.Header.Set("User-Agent", cfg.UserAgent)
	}
	if cfg.GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.GitHubToken)
	}
	resp, err := ghclient.GithubProbeHTTP.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		// Fall back to /branches/{branch} because some HTTP proxies break /commits/{ref} resolution with 422.
		if sha2, err2 := fetchBranchHeadViaBranches(ctx, cfg, ghclient.GithubProbeHTTP, owner, repo, branch); err2 == nil && sha2 != "" {
			return sha2, nil
		}
		if gitSha, gitErr := resolveViaGit(ctx, owner, repo, branch); gitErr == nil && gitSha != "" {
			return gitSha, nil
		}
		if err != nil {
			return "", fmt.Errorf("[ingest] probe failed for %s/%s@%s: %w", owner, repo, branch, err)
		}
		return "", fmt.Errorf("[ingest] failed to resolve sha for %s/%s@%s: HTTP %d", owner, repo, branch, resp.StatusCode)
	}
	defer resp.Body.Close()
	var data struct {
		SHA string `json:"sha"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&data); err != nil {
		if gitSha, gitErr := resolveViaGit(ctx, owner, repo, branch); gitErr == nil && gitSha != "" {
			return gitSha, nil
		}
		return "", fmt.Errorf("[ingest] malformed commit response for %s/%s@%s: %w", owner, repo, branch, err)
	}
	if data.SHA == "" {
		if gitSha, gitErr := resolveViaGit(ctx, owner, repo, branch); gitErr == nil && gitSha != "" {
			return gitSha, nil
		}
		return "", fmt.Errorf("[ingest] empty sha returned for %s/%s@%s", owner, repo, branch)
	}
	return data.SHA, nil
}

func ResolveLatestSha(ctx context.Context, cfg Config, owner, repo, branch string) (string, error) {
	return fetchBranchHead(ctx, cfg, owner, repo, branch)
}

func fetchBranchHeadViaBranches(ctx context.Context, cfg Config, client *http.Client, owner, repo, branch string) (string, error) {
	apiBase := cfg.GitHubAPIBase
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	u := fmt.Sprintf("%s/repos/%s/%s/branches/%s",
		apiBase, url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(branch))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if cfg.UserAgent != "" {
		req.Header.Set("User-Agent", cfg.UserAgent)
	}
	if cfg.GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.GitHubToken)
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("[ingest] branches endpoint HTTP %d", resp.StatusCode)
	}
	var data struct {
		Commit struct {
			Sha string `json:"sha"`
		} `json:"commit"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&data); err != nil {
		return "", err
	}
	if len(data.Commit.Sha) < 40 {
		return "", fmt.Errorf("[ingest] branches endpoint returned invalid sha %q", data.Commit.Sha)
	}
	return data.Commit.Sha, nil
}

func FetchRepoStars(ctx context.Context, cfg Config, owner, repo string) (int, error) {
	apiBase := cfg.GitHubAPIBase
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	u := fmt.Sprintf("%s/repos/%s/%s",
		apiBase, url.PathEscape(owner), url.PathEscape(repo))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if cfg.UserAgent != "" {
		req.Header.Set("User-Agent", cfg.UserAgent)
	}
	if cfg.GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.GitHubToken)
	}
	starCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req = req.WithContext(starCtx)
	resp, err := ghclient.GithubProbeHTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("[ingest] failed to fetch repo stars for %s/%s: HTTP %d", owner, repo, resp.StatusCode)
	}
	var data struct {
		StargazersCount int `json:"stargazers_count"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&data); err != nil {
		return 0, err
	}
	return data.StargazersCount, nil
}

type ArchiveClient struct {
	ensureService *archive.EnsureService
	baseURL       string
	token         string
	http          *http.Client
}

func NewLocalArchiveClient(service *archive.EnsureService) *ArchiveClient {
	return &ArchiveClient{ensureService: service}
}

func NewArchiveClient(baseURL, token string) *ArchiveClient {
	return &ArchiveClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 11 * time.Minute},
	}
}

func (c *ArchiveClient) Ensure(ctx context.Context, owner, repo, sha string) bool {
	return c.EnsureWithCap(ctx, owner, repo, sha, 0)
}

func (c *ArchiveClient) EnsureWithProgress(ctx context.Context, owner, repo, sha string, maxCapBytes int64, onProgress archive.ProgressCallback, prefixScope ...string) bool {
	if onProgress != nil {
		ctx = archive.WithProgress(ctx, onProgress)
	}
	return c.EnsureWithCap(ctx, owner, repo, sha, maxCapBytes, prefixScope...)
}

func (c *ArchiveClient) EnsureWithCap(ctx context.Context, owner, repo, sha string, maxCapBytes int64, prefixScope ...string) bool {
	var prefix string
	if len(prefixScope) > 0 {
		prefix = prefixScope[0]
	}
	if c.ensureService != nil {
		dir, _, err := c.ensureService.EnsureWithCap(ctx, owner, repo, sha, 0, "", maxCapBytes, prefix)
		return err == nil && dir != ""
	}
	if c.baseURL != "" {
		payload := map[string]any{"owner": owner, "repo": repo, "sha": sha}
		if maxCapBytes > 0 {
			payload["maxCapBytes"] = maxCapBytes
		}
		if prefix != "" {
			payload["prefixScope"] = prefix
		}
		if allowed := archive.AllowedFilesFromContext(ctx); len(allowed) > 0 {
			filesList := make([]string, 0, len(allowed))
			for f := range allowed {
				filesList = append(filesList, f)
			}
			payload["allowedFiles"] = filesList
		}
		body, _ := json.Marshal(payload)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/archive/ensure", bytes.NewReader(body))
		if err != nil {
			return false
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-internal-token", c.token)
		resp, err := c.http.Do(req)
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return resp.StatusCode == http.StatusOK
	}
	return false
}

func ArchiveDirFor(root, owner, repo, sha string) string {
	return filepath.Join(root, owner, repo, sha)
}

type WalkArchiveTreeOptions struct {
	SkipDirFn func(relPath string) bool
}

func StreamTreeFromArchive(archiveRoot, owner, repo, sha string, fn func(GitNode) error) bool {
	return WalkArchiveTree(archiveRoot, owner, repo, sha, WalkArchiveTreeOptions{}, fn)
}

func WalkArchiveTree(archiveRoot, owner, repo, sha string, opts WalkArchiveTreeOptions, fn func(GitNode) error) bool {
	finalDir := ArchiveDirFor(archiveRoot, owner, repo, sha)
	info, err := os.Stat(finalDir)
	if err != nil || !info.IsDir() {
		return false
	}

	type frame struct {
		dir string
		rel string
	}
	stack := []frame{{dir: finalDir, rel: ""}}
	for len(stack) > 0 {
		f := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, err := os.ReadDir(f.dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if f.rel == "" && entry.Name() == archive.ScopedMarkerFile {
				continue
			}
			relPath := entry.Name()
			if f.rel != "" {
				relPath = f.rel + "/" + entry.Name()
			}
			full := filepath.Join(f.dir, entry.Name())
			if entry.IsDir() {
				if opts.SkipDirFn != nil && opts.SkipDirFn(relPath) {
					continue
				}
				node := GitNode{Path: relPath, Type: "tree"}
				if err := fn(node); err != nil {
					return true
				}
				stack = append(stack, frame{dir: full, rel: relPath})
			} else if entry.Type() == 0 || entry.Type().IsRegular() {
				st, err := os.Stat(full)
				if err != nil {
					continue
				}
				node := GitNode{Path: relPath, Type: "blob", Size: st.Size()}
				if err := fn(node); err != nil {
					return true
				}
			}
		}
	}
	return true
}

func TreeFromArchive(archiveRoot, owner, repo, sha string) ([]GitNode, bool) {
	if archive.IsScopedArchiveDir(ArchiveDirFor(archiveRoot, owner, repo, sha)) ||
		archive.IsScopedArchive(archiveRoot, owner, repo, sha) {
		return nil, false
	}
	var nodes []GitNode
	ok := StreamTreeFromArchive(archiveRoot, owner, repo, sha, func(n GitNode) error {
		nodes = append(nodes, n)
		return nil
	})
	if !ok {
		return nil, false
	}
	return nodes, true
}

type ScanArchiveResult struct {
	Nodes      []GitNode
	Scale      ScaleDecision
	ReadmePath string
	IsGiant    bool
}

func isVendorNoiseFile(path string) bool {
	lower := strings.ToLower(path)
	if strings.HasSuffix(lower, ".min.js") ||
		strings.HasSuffix(lower, ".min.css") ||
		strings.HasSuffix(lower, ".pb.go") ||
		strings.HasSuffix(lower, "_pb2.py") ||
		strings.HasSuffix(lower, ".bundle.js") ||
		strings.HasSuffix(lower, ".map") {
		return true
	}
	parts := strings.Split(lower, "/")
	base := parts[len(parts)-1]
	switch base {
	case "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock", "cargo.lock", "go.sum", "gemfile.lock", "poetry.lock":
		return true
	}
	return false
}

// Always retain keepPaths (customOutline files) even when giant-repo node buffering truncates.
func ScanArchiveStream(archiveRoot, owner, repo, sha string, patterns *IngestPatterns, keepPaths map[string]bool) (*ScanArchiveResult, bool) {
	scaleAcc := NewScaleAccumulator(patterns)
	var nodes []GitNode
	readmePath := ""

	ok := WalkArchiveTree(archiveRoot, owner, repo, sha, WalkArchiveTreeOptions{
		SkipDirFn: func(relPath string) bool {
			return patterns.IsNonContentDir(relPath)
		},
	}, func(node GitNode) error {
		if node.Type == "blob" {
			if isVendorNoiseFile(node.Path) && !(keepPaths != nil && keepPaths[node.Path]) {
				return nil
			}
			scaleAcc.IngestPath(node.Path)
			if readmePath == "" && patterns.IsReadme(node.Path) {
				readmePath = node.Path
			}
			isGiant := scaleAcc.IsGiantNow()
			if !isGiant || (keepPaths != nil && keepPaths[node.Path]) {
				nodes = append(nodes, node)
			}
		} else {
			nodes = append(nodes, node)
		}
		return nil
	})
	if !ok {
		return nil, false
	}

	scale := scaleAcc.Decision()

	return &ScanArchiveResult{
		Nodes:      nodes,
		Scale:      scale,
		ReadmePath: readmePath,
		IsGiant:    scale.Scale == "giant",
	}, true
}
