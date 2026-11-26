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

type errGithubEmptyRepo struct {
	Status int
}

func (e *errGithubEmptyRepo) Error() string {
	return fmt.Sprintf("仓库没有任何可读内容（空仓库或全部文件被忽略）(HTTP %d)", e.Status)
}

func IsGithubEmptyRepo(err error) bool {
	var e *errGithubEmptyRepo
	return errors.As(err, &e)
}

const githubMaxAttempts = 3

// Trees API omits truncation below 100k entries (~26MB); 64MiB avoids false EOF without unbounded OOM.
const githubBodyLimit = 64 << 20

// Single short 404 retry absorbs GitHub eventual consistency on newly pushed SHAs without burning 3 quota units.
const github404RetryDelay = 800 * time.Millisecond

const github404MaxRetries = 1

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
			continue
		}

		if resp.StatusCode == http.StatusConflict {
			resp.Body.Close()
			return &errGithubEmptyRepo{Status: resp.StatusCode}
		}
		if resp.StatusCode == http.StatusNotFound {
			resp.Body.Close()
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

		// Buffer the full body before JSON decoding so mid-stream EOF/resets retry as transient network errors.
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

type GitTreeEntry struct {
	Path string `json:"path"`
	Mode string `json:"mode,omitempty"`
	Type string `json:"type"`
	SHA  string `json:"sha,omitempty"`
	Size int64  `json:"size,omitempty"`
	URL  string `json:"url,omitempty"`
}

type GitTreeResponse struct {
	SHA       string         `json:"sha"`
	URL       string         `json:"url"`
	Tree      []GitTreeEntry `json:"tree"`
	Truncated bool           `json:"truncated"`
}

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
					continue
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

const blobFetchBatchSize = 25

// Exclude bundle and binary extensions upfront so GraphQL 25-alias slots stay reserved for source code.
var blobSkipExtBlacklist = map[string]struct{}{
	".min.js": {}, ".map": {}, ".snap": {},
	".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".webp": {}, ".bmp": {}, ".svg": {}, ".ico": {},
	".woff": {}, ".woff2": {}, ".ttf": {}, ".otf": {}, ".eot": {},
	".pdf": {}, ".mp4": {}, ".mp3": {}, ".wav": {}, ".mov": {}, ".webm": {},
	".bin": {}, ".exe": {}, ".dll": {}, ".so": {}, ".dylib": {}, ".wasm": {},
	".zip": {}, ".gz": {}, ".tgz": {}, ".tar": {}, ".jar": {},
	".lock": {},
}

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

const blobFetchDefaultConcurrency = 6

const blobFetchDefaultWallclock = 8 * time.Second

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

// Return partial results with truncated=true on wallclock or chunk failure instead of discarding fetched blobs.
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

	fetchable := make([]string, 0, len(paths))
	for _, p := range paths {
		if !isSkippableBlobPath(p) {
			fetchable = append(fetchable, p)
		}
	}
	if len(fetchable) == 0 {
		return map[string]string{}, false, nil
	}

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
		sem <- struct{}{}
		wg.Add(1)
		go func(batch []string) {
			defer func() {
				<-sem
				wg.Done()
			}()
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
	return merged, failedCnt > 0, nil
}
