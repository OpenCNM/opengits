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
	// 不带 ref pattern：部分网络路径（HTTP 代理）会破坏 git 智能 HTTP 的
	// ref 过滤协商——`ls-remote repo main` 返回空但全量列表正常。全量拉取
	// 后本地匹配，对代理免疫且语义等价（GitHub 端过滤 vs 客户端过滤）。
	cmd := exec.CommandContext(ctx, "git", "ls-remote", repoURL)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git ls-remote failed: %w", err)
	}
	lines := strings.Split(stdout.String(), "\n")
	for _, line := range lines {
		fields := strings.Fields(line)
		// SHA-1 = 40 位、SHA-256 对象格式 = 64 位（硬编码 40 会使 SHA-256
		// 仓在此回退路径永远解析失败）；且必须匹配目标 ref 尾段——
		// ls-remote 多 ref 输出时首行可能属于其他 ref。
		if len(fields) >= 2 && (len(fields[0]) == 40 || len(fields[0]) == 64) && isHex(fields[0]) {
			if refMatchesTarget(fields[1], targetBranch) {
				return fields[0], nil
			}
		}
	}
	return "", fmt.Errorf("git ls-remote returned no valid SHA for ref %q", targetBranch)
}

// isHex 判定全十六进制（sha 形态守卫，防止把其他哈希/错误输出当 sha）。
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

// refMatchesTarget ls-remote ref 形态匹配：refs/heads/<b>、refs/tags/<b>、
// HEAD 及裸分支名（pattern 匹配时 git 会回显通配形态，取尾段比较）。
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

// ─────────────────────────────────────────────────────────────
// ingest 树获取侧（刀 3b）：
// - ResolveLatestSha：GitHub commits API（复用 upstream-check 的条件探测形态）
// - ArchiveEnsure：HTTP 调 archive 容器 /v1/archive/ensure（下载/解压已在
//   Go 侧car 实现，此处只触发 + 读共享卷）——返回 false = 超限跳过/不可用，
//   调用方回退 GitHub Tree API 路径（留子进程）
// - TreeFromArchive：解压目录遍历 → GitNodes（与 tree-parse.ts 逐字对齐，
//   0 网络；归档缺失返回 false）
// ─────────────────────────────────────────────────────────────

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
		// 回退 1：/branches/{branch} 端点——部分网络路径（HTTP 代理）会破坏
		// /commits/{ref} 的解析（真实分支也返回 422），但 /branches 正常。
		if sha2, err2 := fetchBranchHeadViaBranches(ctx, cfg, ghclient.GithubProbeHTTP, owner, repo, branch); err2 == nil && sha2 != "" {
			return sha2, nil
		}
		// 回退 2：git ls-remote（智能 HTTP；ref 过滤协商同样可能被代理破坏，
		// resolveViaGit 内部已做全量列表本地匹配）
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

// ResolveLatestSha GET /repos/{o}/{r}/commits/{branch} → sha。
func ResolveLatestSha(ctx context.Context, cfg Config, owner, repo, branch string) (string, error) {
	return fetchBranchHead(ctx, cfg, owner, repo, branch)
}

// fetchBranchHeadViaBranches GET /repos/{o}/{r}/branches/{branch}（跟随重定向）。
// /commits/{ref} 被代理破坏时的等价端点。
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

// FetchRepoStars GET /repos/{o}/{r} → stargazers_count。
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
	// 共享 30s 客户端 + 请求级 15s deadline，保留星标探测原有的更紧上限
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

// ArchiveClient 归档客户端（支持进程内 direct Ensure 与 HTTP 远端回退）。
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

// Ensure 触发归档下载/解压；ok=false 表示超限跳过（dir=null 语义）或
// 传输失败——调用方回落子进程（语义对齐 ensureArchiveViaSidecar）。
func (c *ArchiveClient) Ensure(ctx context.Context, owner, repo, sha string) bool {
	return c.EnsureWithCap(ctx, owner, repo, sha, 0)
}

// EnsureWithProgress 带有实时进度监听回调的 EnsureWithCap 客户端入口。
func (c *ArchiveClient) EnsureWithProgress(ctx context.Context, owner, repo, sha string, maxCapBytes int64, onProgress archive.ProgressCallback, prefixScope ...string) bool {
	if onProgress != nil {
		ctx = archive.WithProgress(ctx, onProgress)
	}
	return c.EnsureWithCap(ctx, owner, repo, sha, maxCapBytes, prefixScope...)
}

// EnsureWithCap 带有动态配额上限与子卷定向解压的归档下载/解压客户端入口。
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

// ArchiveDirFor 与 archive-store.archiveDirFor 布局一致（{owner}/{repo}/{sha}）。
func ArchiveDirFor(root, owner, repo, sha string) string {
	return filepath.Join(root, owner, repo, sha)
}

// WalkArchiveTreeOptions 控制归档遍历与修剪行为。
type WalkArchiveTreeOptions struct {
	// SkipDirFn 目录剪枝回调（例如命中非内容目录模式时立即跳过整棵子树，避免遍历数万垃圾文件）
	SkipDirFn func(relPath string) bool
}

// StreamTreeFromArchive 流式遍历归档树（内存友好，支持 10k~100k 巨仓低 RSS 流式处理）。
// 归档不存在返回 false。
func StreamTreeFromArchive(archiveRoot, owner, repo, sha string, fn func(GitNode) error) bool {
	return WalkArchiveTree(archiveRoot, owner, repo, sha, WalkArchiveTreeOptions{}, fn)
}

// WalkArchiveTree 携带过滤与剪枝选项流式遍历归档树。
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

// TreeFromArchive 解压目录遍历 → GitNodes（与 tree-parse.ts 逐字对齐：
// tree+blob、blob 带 size；归档不存在返回 false）。
func TreeFromArchive(archiveRoot, owner, repo, sha string) ([]GitNode, bool) {
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

// ScanArchiveResult 归档流式探测结果：
// 区分 normal 规模（nodes 缓冲完毕，零内存溢出）与 giant 规模（nodes 被截断保护）。
type ScanArchiveResult struct {
	Nodes      []GitNode
	Scale      ScaleDecision
	ReadmePath string
	IsGiant    bool
}

// isVendorNoiseFile 微秒级过滤打包产物、protobuf 生成代码及大型依赖锁文件（防无意义 AST 扫描拖死导入）。
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

// ScanArchiveStream 流式扫描归档，完成剪枝与规模判定（内存封顶，支持 10k~100k 巨仓低 RSS 流式处理）。
// keepPaths 非空时（customOutline 作用域）：命中文件恒入节点集——巨仓截断
// 不吞用户大纲引用的文件；规模统计仍按全量流计算。
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
