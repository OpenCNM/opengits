package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────
// GitHub API 最小共享客户端（对齐 apps/client/src/lib/github/client.ts
// 的纯 HTTP 段 + engine/fetcher.ts getRepoTree 重试语义；DB 令牌池轮换
// 不在本移植面——调度量小，单令牌 + 限流退避足够）：
// - 3 次尝试；限流（429 / Retry-After / remaining=0）→ 睡眠 Retry-After
//   （默认 2s）后重试
// - 响应体传输中断（大树 JSON 中途截断/连接被掐）与连接失败同属瞬态，
//   参与重试；完整体 JSON 解码失败才是终态，立即失败
// - 409 → 空仓立即；404 → 仅末次判空仓
// - 其余非 2xx 立即错误
// ─────────────────────────────────────────────────────────────

// errGithubEmptyRepo 空仓库（409 或末次 404）——对齐 Node EmptyRepoError。
type errGithubEmptyRepo struct {
	Status int
}

func (e *errGithubEmptyRepo) Error() string {
	return fmt.Sprintf("仓库没有任何可读内容（空仓库或全部文件被忽略）(HTTP %d)", e.Status)
}

// IsGithubEmptyRepo 空仓判定。
func IsGithubEmptyRepo(err error) bool {
	var e *errGithubEmptyRepo
	return errors.As(err, &e)
}

const githubMaxAttempts = 3

// githubBodyLimit 响应体物理上限。GitHub Trees API 仅在条目数超过 100,000
// 时置 truncated 截断，完整响应无字节上限（实测 openclaw/openclaw 递归树：
// 63,220 条目 = 16.1MB 解压后完整送达、truncated=false——旧 8MiB 限在解码
// 器内表现为 unexpected EOF，被误判为网络瞬断）。按 100k 条目 × ~256B ≈
// 26MB 物理上限加余量取 64MiB：容纳最大完整响应，超出即异常体 fail-fast。
const githubBodyLimit = 64 << 20

// github404RetryDelay 404 单次短退避：吸收 GitHub 对新建仓/新 SHA 的最终一致
// 窗口（亚秒~秒级），不与限流 Retry-After 共用 2s 缺省——扫描型 miss 少付延迟。
const github404RetryDelay = 800 * time.Millisecond

// github404MaxRetries 404 至多重试一次：总调用 ≤ 2（配额保护），持续 404 终态。
const github404MaxRetries = 1

// GithubProbeHTTP 包级共享 GitHub HTTP 客户端：上游 api.github.com 为单
// host，共享 Transport 的 keep-alive 连接池消除每调用一次 TCP+TLS 握手；
// token/UA 均为请求级 Header，client 无每调用可变状态。供 GithubGetJSON
// 与分支头/星标探测（scheduler、ingest）共用。
var GithubProbeHTTP = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	},
}

// GithubGetJSON GET rawURL 并解码 JSON 到 out（共享限流重试语义）。
func GithubGetJSON(ctx context.Context, rawURL, token, userAgent string, out any) error {
	if userAgent == "" {
		userAgent = "OpenGits-Engine/1.0"
	}
	client := GithubProbeHTTP

	var lastErr error
	for attempt := 1; attempt <= githubMaxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("User-Agent", userAgent)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}

		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("github request failed: %w", err)
			continue // 网络瞬断参与剩余尝试
		}

		if resp.StatusCode == http.StatusConflict {
			resp.Body.Close()
			return &errGithubEmptyRepo{Status: resp.StatusCode}
		}
		if resp.StatusCode == http.StatusNotFound {
			resp.Body.Close()
			// 404 有界重试：GitHub 对刚创建仓库/刚 push 的 SHA 存在最终一致性窗口的
			// 瞬时 404（scout 解析 SHA → ingest 立即回查 commits 的典型时序）。
			// 单次短退避重试吸收该窗口；持续 404 仍按空仓/不存在终态——不再烧满
			// 全部 3 次尝试（旧 ILIKE 时代扫描型 miss 每次烧 3 个配额单位的问题不回潮）。
			if attempt <= github404MaxRetries {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(github404RetryDelay):
				}
				lastErr = fmt.Errorf("github api transient 404 for %s", rawURL)
				continue
			}
			return &errGithubEmptyRepo{Status: resp.StatusCode}
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			// 限流识别：429 / Retry-After 头 / remaining=0（对齐 isRateLimited）
			if isGithubRateLimited(resp) && attempt < githubMaxAttempts {
				resp.Body.Close()
				if err := sleepGithubRetryAfter(ctx, resp.Header.Get("Retry-After")); err != nil {
					return err
				}
				lastErr = fmt.Errorf("github api rate limited (status %d)", resp.StatusCode)
				continue
			}
			resp.Body.Close()
			return fmt.Errorf("github api returned status %d for %s", resp.StatusCode, rawURL)
		}

		// 先读全体再解码：多 MB 大树 JSON 跨不可靠链路传输，中途截断
		// （unexpected EOF / connection reset）发生在 Read 阶段——属瞬态，
		// 必须落入本次循环参与剩余尝试；而 Content-Length 完整送达后仍
		// 解码失败才是终态（schema 漂移 fail-fast，不重试）。
		buf, readErr := io.ReadAll(io.LimitReader(resp.Body, githubBodyLimit+1))
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("github response body read failed: %w", readErr)
			continue
		}
		if len(buf) > githubBodyLimit {
			return fmt.Errorf("github response exceeds %d-byte body limit for %s", githubBodyLimit, rawURL)
		}
		if err := json.Unmarshal(buf, out); err != nil {
			return fmt.Errorf("github response decode failed for %s: %w", rawURL, err)
		}
		return nil
	}
	return lastErr
}

// isGithubRateLimited 429；或 403 + Retry-After / x-ratelimit-remaining=0。
func isGithubRateLimited(resp *http.Response) bool {
	if resp.StatusCode == http.StatusTooManyRequests {
		return true
	}
	if resp.StatusCode != http.StatusForbidden {
		return false
	}
	if resp.Header.Get("Retry-After") != "" {
		return true
	}
	return resp.Header.Get("x-ratelimit-remaining") == "0"
}

// sleepGithubRetryAfter 睡眠 Retry-After 秒（缺省 2s；0 立即；上限 120s 防恶意头）。
func sleepGithubRetryAfter(ctx context.Context, retryAfter string) error {
	secs := 2
	if v, err := strconv.Atoi(strings.TrimSpace(retryAfter)); err == nil && v >= 0 {
		secs = v
	}
	if secs > 120 {
		secs = 120
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(time.Duration(secs) * time.Second):
		return nil
	}
}

// GitTreeEntry Git 树节点条目。
type GitTreeEntry struct {
	Path string `json:"path"`
	Mode string `json:"mode,omitempty"`
	Type string `json:"type"` // "blob" or "tree"
	SHA  string `json:"sha,omitempty"`
	Size int64  `json:"size,omitempty"`
	URL  string `json:"url,omitempty"`
}

// GitTreeResponse Git 树响应。
type GitTreeResponse struct {
	SHA       string         `json:"sha"`
	URL       string         `json:"url"`
	Tree      []GitTreeEntry `json:"tree"`
	Truncated bool           `json:"truncated"`
}

// GithubFetchTreeRecursive 递归获取仓库完整 Git 树（带 gzip 支持与 64MiB 缓冲保护）。
func GithubFetchTreeRecursive(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*GitTreeResponse, error) {
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	ref := sha
	if ref == "" {
		ref = "main"
	}
	rawURL := fmt.Sprintf("%s/repos/%s/%s/git/trees/%s?recursive=1",
		strings.TrimRight(apiBase, "/"),
		url.PathEscape(owner),
		url.PathEscape(repo),
		url.PathEscape(ref),
	)
	var resp GitTreeResponse
	if err := GithubGetJSON(ctx, rawURL, token, userAgent, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// GithubBatchGetBlobsGraphQL 使用单次 GraphQL 查询批量拉取指定路径的文件文本内容（O(1) API 调用，防 N+1 限流）。
func GithubBatchGetBlobsGraphQL(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, error) {
	if len(paths) == 0 {
		return map[string]string{}, nil
	}
	if token == "" {
		return nil, errors.New("github token is required for graphql batch fetch")
	}
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	if userAgent == "" {
		userAgent = "OpenGits-Engine/1.0"
	}

	// 保护帽：单次至多抓取 25 个别名 f0..f24（AI-Directed Dynamic Sampling v2.0；
	// 与并发分块拉取器的 blobFetchBatchSize 共用同一 SSOT 常量）
	if len(paths) > blobFetchBatchSize {
		paths = paths[:blobFetchBatchSize]
	}

	rev := sha
	if rev == "" {
		rev = "HEAD"
	}

	var fields strings.Builder
	for i, p := range paths {
		exprBytes, err := json.Marshal(fmt.Sprintf("%s:%s", rev, strings.TrimPrefix(p, "/")))
		if err != nil {
			continue
		}
		fmt.Fprintf(&fields, "    f%d: object(expression: %s) { ... on Blob { text isBinary byteSize } }\n", i, string(exprBytes))
	}

	query := fmt.Sprintf(`query BatchGetFiles($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
%s
  }
}`, fields.String())

	reqPayload, err := json.Marshal(map[string]any{
		"query": query,
		"variables": map[string]any{
			"owner": owner,
			"repo":  repo,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to encode graphql payload: %w", err)
	}

	rawURL := strings.TrimRight(apiBase, "/") + "/graphql"
	client := GithubProbeHTTP

	var lastErr error
	for attempt := 1; attempt <= githubMaxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, bytes.NewReader(reqPayload))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Authorization", "Bearer "+token)

		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("github graphql request failed: %w", err)
			continue
		}

		if resp.StatusCode == http.StatusUnauthorized {
			resp.Body.Close()
			return nil, fmt.Errorf("github graphql unauthorized (invalid token)")
		}
		if resp.StatusCode == http.StatusNotFound {
			resp.Body.Close()
			return nil, &errGithubEmptyRepo{Status: resp.StatusCode}
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			remStr := resp.Header.Get("x-ratelimit-remaining")
			if remStr != "" {
				if rem, rErr := strconv.Atoi(strings.TrimSpace(remStr)); rErr == nil && rem < 20 {
					resp.Body.Close()
					return nil, fmt.Errorf("github graphql rate limit nearly exhausted (%d remaining)", rem)
				}
			}
			if isGithubRateLimited(resp) && attempt < githubMaxAttempts {
				resp.Body.Close()
				if err := sleepGithubRetryAfter(ctx, resp.Header.Get("Retry-After")); err != nil {
					return nil, err
				}
				lastErr = fmt.Errorf("github graphql rate limited (status %d)", resp.StatusCode)
				continue
			}
			resp.Body.Close()
			return nil, fmt.Errorf("github graphql returned status %d", resp.StatusCode)
		}

		buf, readErr := io.ReadAll(io.LimitReader(resp.Body, githubBodyLimit+1))
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("github graphql response read failed: %w", readErr)
			continue
		}
		if len(buf) > githubBodyLimit {
			return nil, fmt.Errorf("github graphql response exceeds %d-byte body limit", githubBodyLimit)
		}

		var ghResp struct {
			Data struct {
				Repository map[string]*struct {
					Text     *string `json:"text"`
					IsBinary bool    `json:"isBinary"`
					ByteSize int64   `json:"byteSize"`
				} `json:"repository"`
			} `json:"data"`
			Errors []struct {
				Message string `json:"message"`
				Type    string `json:"type"`
			} `json:"errors"`
		}

		if err := json.Unmarshal(buf, &ghResp); err != nil {
			return nil, fmt.Errorf("github graphql decode failed: %w", err)
		}

		if ghResp.Data.Repository == nil {
			if len(ghResp.Errors) > 0 {
				return nil, fmt.Errorf("github graphql error: %s", ghResp.Errors[0].Message)
			}
			return nil, errors.New("github graphql error: repository not found or null")
		}

		out := make(map[string]string)
		for i, p := range paths {
			key := fmt.Sprintf("f%d", i)
			if item, ok := ghResp.Data.Repository[key]; ok && item != nil && !item.IsBinary && item.Text != nil {
				if item.ByteSize > 500*1024 {
					continue // 严格过滤超限文件 (>500KB)
				}
				cleanP := strings.TrimPrefix(filepath.ToSlash(p), "/")
				out[p] = *item.Text
				if cleanP != p {
					out[cleanP] = *item.Text
				}
			}
		}
		return out, nil
	}

		return nil, lastErr
}

// ─────────────────────────────────────────────────────────────
// GraphQL 并发分块拉取器（契约 C2，冻结签名）：
// - 在 GithubBatchGetBlobsGraphQL（25 别名硬帽 + 既有限流重试）之上按
//   blobFetchBatchSize 个/批拆块，有界并发池并行发起
// - 硬墙钟（默认 8s）到点立即返回已成功批次的聚合结果 + truncated=true；
//   部分批次失败同样聚合成功部分 + truncated=true，绝不整体丢弃；
//   全部批次失败才返回 err
// - 打包产物/二进制扩展名黑名单在分块前剔除，直接跳过不拉取
// ─────────────────────────────────────────────────────────────

// blobFetchBatchSize 单批路径数：与 GithubBatchGetBlobsGraphQL 的别名硬帽
// 一致（f0..f24），两条路径共用同一 SSOT 常量防漂移。
const blobFetchBatchSize = 25

// blobSkipExtBlacklist 打包产物/二进制扩展名黑名单（中心化常量表，346 准则
// 零散落）：键为小写点后缀，含 .min.js 复合后缀——普通 .js 源码不受影响。
// 命中即跳过不拉取：AI 编排对打包产物/二进制零消费价值，省 fetch 配额与墙钟预算。
var blobSkipExtBlacklist = map[string]struct{}{
	// 打包产物 / 快照 / SourceMap
	".min.js": {}, ".map": {}, ".snap": {},
	// 图片 / 图标
	".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".webp": {}, ".bmp": {}, ".svg": {}, ".ico": {},
	// 字体
	".woff": {}, ".woff2": {}, ".ttf": {}, ".otf": {}, ".eot": {},
	// 文档 / 媒体
	".pdf": {}, ".mp4": {}, ".mp3": {}, ".wav": {}, ".mov": {}, ".webm": {},
	// 原生二进制 / 归档
	".bin": {}, ".exe": {}, ".dll": {}, ".so": {}, ".dylib": {}, ".wasm": {},
	".zip": {}, ".gz": {}, ".tgz": {}, ".tar": {}, ".jar": {},
	// 锁文件
	".lock": {},
}

// isSkippableBlobPath 路径命中黑名单后缀（大小写不敏感；后缀匹配天然覆盖
// 子目录路径与 .min.js 复合后缀）。
func isSkippableBlobPath(path string) bool {
	name := strings.ToLower(filepath.ToSlash(path))
	if name == "" {
		return false
	}
	for suffix := range blobSkipExtBlacklist {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}

// blobFetchDefaultConcurrency 有界并发池默认批次并发数。
const blobFetchDefaultConcurrency = 6

// blobFetchDefaultWallclock 整体硬墙钟默认预算：到点即收割已成功批次，绝不无限等待。
const blobFetchDefaultWallclock = 8 * time.Second

// blobFetchConcurrency 并发池大小。
// 优先级: 显式覆盖值 > 环境变量 BLOB_FETCH_CONCURRENCY > 默认值 blobFetchDefaultConcurrency。
func blobFetchConcurrency(override ...int) int {
	if len(override) > 0 && override[0] > 0 {
		return override[0]
	}
	if v := os.Getenv("BLOB_FETCH_CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return blobFetchDefaultConcurrency
}

// blobFetchWallclock 硬墙钟预算。
// 优先级: 显式覆盖值 > 环境变量 BLOB_FETCH_WALLCLOCK_MS > 默认值 blobFetchDefaultWallclock。
func blobFetchWallclock(override ...time.Duration) time.Duration {
	if len(override) > 0 && override[0] > 0 {
		return override[0]
	}
	if v := os.Getenv("BLOB_FETCH_WALLCLOCK_MS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Millisecond
		}
	}
	return blobFetchDefaultWallclock
}

// GithubConcurrentBatchGetBlobsGraphQL 并发分块批量拉取指定路径的文件文本内容
// （契约 C2，冻结签名）。按 25 个/批拆块复用 GithubBatchGetBlobsGraphQL（保持
// 别名机制与既有重试），有界并发池并行发起；硬墙钟到点立即返回已成功批次聚合
// 结果 + truncated=true——部分批次失败同样聚合成功部分 + truncated=true，
// 绝不整体丢弃；全部批次失败才返回 err。
func GithubConcurrentBatchGetBlobsGraphQL(ctx context.Context, apiBase, owner, repo, sha string,
	paths []string, token, userAgent string) (contents map[string]string, truncated bool, err error) {
	if len(paths) == 0 {
		return map[string]string{}, false, nil
	}
	if token == "" {
		return nil, false, errors.New("github token is required for graphql batch fetch")
	}
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	if userAgent == "" {
		userAgent = "OpenGits-Engine/1.0"
	}

	// 黑名单预过滤：打包产物/二进制在分块前剔除，不占批次别名名额
	fetchable := make([]string, 0, len(paths))
	for _, p := range paths {
		if !isSkippableBlobPath(p) {
			fetchable = append(fetchable, p)
		}
	}
	if len(fetchable) == 0 {
		return map[string]string{}, false, nil
	}

	// 按 25 个/批拆块，保持原顺序便于确定性测试
	batches := make([][]string, 0, (len(fetchable)+blobFetchBatchSize-1)/blobFetchBatchSize)
	for start := 0; start < len(fetchable); start += blobFetchBatchSize {
		end := min(start+blobFetchBatchSize, len(fetchable))
		batches = append(batches, fetchable[start:end])
	}

	concurrency := min(blobFetchConcurrency(), len(batches))
	wallCtx, cancel := context.WithTimeout(ctx, blobFetchWallclock())
	defer cancel()

	merged := make(map[string]string, len(fetchable))
	var (
		mu        sync.Mutex
		failedCnt int
		lastErr   error
	)
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for _, batch := range batches {
		sem <- struct{}{} // 有界并发池：占满即阻塞，天然限流
		wg.Add(1)
		go func(batch []string) {
			defer func() {
				<-sem
				wg.Done()
			}()
			// 墙钟已到：不再发起新批次，记为失败参与 truncated 判定
			if wallCtx.Err() != nil {
				mu.Lock()
				failedCnt++
				mu.Unlock()
				return
			}
			res, batchErr := GithubBatchGetBlobsGraphQL(wallCtx, apiBase, owner, repo, sha, batch, token, userAgent)
			mu.Lock()
			defer mu.Unlock()
			if batchErr != nil {
				failedCnt++
				lastErr = batchErr
				return
			}
			for k, v := range res {
				merged[k] = v
			}
		}(batch)
	}
	wg.Wait()

	if failedCnt == len(batches) {
		return nil, false, fmt.Errorf("github concurrent blob fetch: all %d batches failed (concurrency=%d), last error: %w",
			len(batches), concurrency, lastErr)
	}
	// 任一批次失败/被墙钟掐断即如实上浮截断标志——聚合结果绝不整体丢弃
	return merged, failedCnt > 0, nil
}
