package mcp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/opengits/worker-sidecar/internal/archive"
)

const (
	defaultGitHubRawBase     = "https://raw.githubusercontent.com"
	sourceFallbackTimeout    = 15 * time.Second
	sourceFallbackHitTTL     = 15 * time.Minute
	sourceFallbackBranchTTL  = 2 * time.Minute
	sourceFallbackMissTTL    = 60 * time.Second
	sourceFallbackCacheLimit = 512
)

var (
	sourceFallbackCache = newTTLCache(sourceFallbackHitTTL, sourceFallbackCacheLimit)
	sourceFallbackSF    singleflight.Group
	sourceFallbackMu    sync.RWMutex
	sourceFallbackBase  string
	sourceFallbackHTTP  = &http.Client{Timeout: sourceFallbackTimeout}
)

func resolveArchiveRoot() string {
	return firstNonEmpty(os.Getenv("ARCHIVE_ROOT"), os.Getenv("TARBALL_CACHE_DIR"), "storage/repos")
}

func isImmutableCommitSha(ref string) bool {
	if len(ref) < 7 || len(ref) > 40 {
		return false
	}
	for i := 0; i < len(ref); i++ {
		c := ref[i]
		isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if !isHex {
			return false
		}
	}
	return true
}

func isSafeSegmentASCII(s string) bool {
	if s == "" || s == "." || s == ".." || strings.Contains(s, "..") {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.'
		if !ok {
			return false
		}
	}
	return true
}

func isRunningUnderGoTest() bool {
	return strings.HasSuffix(os.Args[0], ".test") || strings.Contains(os.Args[0], ".test.")
}

func resolveGitHubRawBase() string {
	sourceFallbackMu.RLock()
	override := sourceFallbackBase
	sourceFallbackMu.RUnlock()
	if override != "" {
		return override
	}
	if env := strings.TrimSpace(os.Getenv("GITHUB_RAW_BASE")); env != "" {
		return env
	}
	if isRunningUnderGoTest() {
		return ""
	}
	return defaultGitHubRawBase
}

func fetchImmutableSourceFile(ctx context.Context, archiveRoot, owner, repo, ref, relPath string) string {
	cleanPath, ok := cleanSourcePathRaw(relPath)
	if !ok || owner == "" || repo == "" || ref == "" || strings.EqualFold(owner, "web-docs") {
		return ""
	}
	if !isSafeSegmentASCII(owner) || !isSafeSegmentASCII(repo) || !isSafeSegmentASCII(ref) {
		return ""
	}

	rawBase := resolveGitHubRawBase()
	if rawBase == "" {
		return ""
	}

	cacheKey := strings.ToLower(owner) + "/" + strings.ToLower(repo) + "@" + ref + ":" + cleanPath
	val, err := sourceFallbackCache.getOrLoadWithCustomTTL(cacheKey, func() (any, time.Duration, error) {
		res, sfErr, _ := sourceFallbackSF.Do(cacheKey, func() (any, error) {
			return doFetchGitHubRawFile(ctx, rawBase, archiveRoot, owner, repo, ref, cleanPath)
		})
		if sfErr != nil {
			return "", sourceFallbackMissTTL, nil
		}
		text, _ := res.(string)
		if text == "" {
			return "", sourceFallbackMissTTL, nil
		}
		ttl := sourceFallbackBranchTTL
		if isImmutableCommitSha(ref) {
			ttl = sourceFallbackHitTTL
		}
		return text, ttl, nil
	})
	if err != nil {
		return ""
	}
	text, _ := val.(string)
	return text
}

func doFetchGitHubRawFile(ctx context.Context, rawBase, archiveRoot, owner, repo, ref, cleanPath string) (string, error) {
	u, err := url.Parse(rawBase)
	if err != nil {
		return "", err
	}
	u.Path = path.Join(u.Path, owner, repo, ref, cleanPath)

	reqCtx, cancel := context.WithTimeout(ctx, sourceFallbackTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	ua := strings.TrimSpace(os.Getenv("USER_AGENT"))
	if ua == "" {
		ua = "OpenGits-Engine/1.0"
	}
	req.Header.Set("User-Agent", ua)
	if tok := firstNonEmpty(os.Getenv("GITHUB_TOKEN"), os.Getenv("OCTOKIT_PERSONAL_ACCESS_TOKEN")); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}

	resp, err := sourceFallbackHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSourceFileReadBytes+1))
	if err != nil || int64(len(body)) > maxSourceFileReadBytes {
		return "", fmt.Errorf("upstream body unreadable or exceeds limit")
	}
	content := string(body)
	if content == "" {
		return "", nil
	}

	if archiveRoot != "" && isImmutableCommitSha(ref) {
		warmArchiveFileBestEffort(archiveRoot, owner, repo, ref, cleanPath, body)
	}
	return content, nil
}

func warmArchiveFileBestEffort(archiveRoot, owner, repo, ref, cleanPath string, data []byte) {
	base := archive.ArchiveDirFor(archiveRoot, owner, repo, ref)
	full := filepath.Join(base, filepath.FromSlash(cleanPath))
	rel, err := filepath.Rel(base, full)
	if err != nil || strings.HasPrefix(rel, "..") || rel == "." {
		return
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return
	}
	tmp := fmt.Sprintf("%s.tmp-%d", full, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		_ = os.Remove(tmp)
		return
	}
	if err := os.Rename(tmp, full); err != nil {
		_ = os.Remove(tmp)
	}
}
