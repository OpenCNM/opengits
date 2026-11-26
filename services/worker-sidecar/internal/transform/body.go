package transform

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type AssetStore interface {
	EnsureBucket(ctx context.Context) error
	Exists(ctx context.Context, key string) (bool, error)
	Put(ctx context.Context, key string, data []byte) error
}

type GoTransformDeps struct {
	Assets      AssetStore
	ArchiveRoot string
	GitHubToken string
	UserAgent   string
	RawBase     string
	WebBase     string
	HTTP        *http.Client
	Patterns    any
}

func RunGoTransform(ctx context.Context, deps GoTransformDeps, owner, repo, branch string, gitSha *string, filePath, githubToken string) (string, error) {
	return runGoTransform(ctx, deps, owner, repo, branch, gitSha, filePath, githubToken)
}

func runGoTransform(ctx context.Context, deps GoTransformDeps, owner, repo, branch string, gitSha *string, filePath, githubToken string) (string, error) {
	raw, err := fetchDocRawLocalFirst(ctx, deps, owner, repo, branch, gitSha, filePath, githubToken)
	if err != nil {
		return "", err
	}

	cleaned, err := goSanitizeText(raw)
	if err != nil {
		return "", fmt.Errorf("sanitize: %w", err)
	}

	tc := newTransformContext(owner, repo, branch, filePath, []string{filePath}, deps.RawBase, deps.WebBase)
	transformed, err := goTransformText(cleaned, tc)
	if err != nil {
		return "", err
	}

	if err := downloadReferencedAssets(ctx, deps, owner, repo, gitSha, branch, githubToken, tc.referencedAssets); err != nil {
		log.Printf("[go-transform] asset download degraded for %s/%s: %v", owner, repo, err)
	}
	return transformed, nil
}

func goTransformText(content string, tc *transformContext) (string, error) {
	masked, blocks := maskCodeBlocks(content)
	s := applyYouTubeCards(masked)
	s = applyAutolinks(s)
	s = applyBareTagEscape(s)
	s = rewriteLinksImages(s, tc)
	// Escapes isolated '<' on masked text before unmask so code blocks stay untouched.
	s = applyIsolatedLessThanEscape(s)
	return unmaskCodeBlocks(s, blocks), nil
}

var archiveShaRe = mdpat.GitShaRe

func downloadReferencedAssets(ctx context.Context, deps GoTransformDeps, owner, repo string, gitSha *string, branch, githubToken string, referenced map[string]struct{}) error {
	if len(referenced) == 0 {
		return nil
	}
	if deps.Assets == nil {
		return nil
	}
	if err := deps.Assets.EnsureBucket(ctx); err != nil {
		return fmt.Errorf("ensure bucket: %w", err)
	}
	archiveSha := ""
	if gitSha != nil && archiveShaRe.MatchString(strings.ToLower(*gitSha)) {
		// Archive directories use lowercase SHA; preserving uppercase causes silent cache misses.
		archiveSha = strings.ToLower(*gitSha)
	}
	token := githubToken
	if token == "" {
		token = deps.GitHubToken
	}

	sem := make(chan struct{}, 6)
	var wg sync.WaitGroup

dispatchLoop:
	for relPath := range referenced {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			// Labeled break exits the dispatch loop; bare break only exits select and would still spawn goroutines.
			break dispatchLoop
		}
		wg.Add(1)
		go func(relPath string) {
			defer wg.Done()
			defer func() { <-sem }()
			if err := downloadOneAsset(ctx, deps, owner, repo, archiveSha, branch, token, relPath); err != nil {
				log.Printf("[go-transform] asset %s failed: %v", relPath, err)
			}
		}(relPath)
	}
	wg.Wait()
	return nil
}

func downloadOneAsset(ctx context.Context, deps GoTransformDeps, owner, repo, archiveSha, branch, token, relPath string) error {
	// Guards against path traversal including URL-encoded sequences.
	clean := path.Clean(relPath)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "..") || strings.HasPrefix(clean, "/") || !isSafeRelativePath(relPath) {
		return fmt.Errorf("path traversal rejected: %s", relPath)
	}
	if unescaped, err := url.PathUnescape(relPath); err != nil {
		return fmt.Errorf("path traversal rejected: %s", relPath)
	} else if unescaped != relPath {
		cleanUnescaped := path.Clean(unescaped)
		if cleanUnescaped == "." || cleanUnescaped == ".." || strings.HasPrefix(cleanUnescaped, "..") || strings.HasPrefix(cleanUnescaped, "/") || !isSafeRelativePath(cleanUnescaped) {
			return fmt.Errorf("path traversal rejected: %s", relPath)
		}
	}
	key := "assets/" + owner + "/" + repo + "/" + relPath

	exists, err := deps.Assets.Exists(ctx, key)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}

	if archiveSha != "" {
		if raw := readLocalArchiveFile(deps.ArchiveRoot, owner, repo, archiveSha, relPath); raw != "" {
			return deps.Assets.Put(ctx, key, []byte(raw))
		}
	}

	rawRef := archiveSha
	if rawRef == "" {
		rawRef = branch
	}
	url := deps.RawBase + "/" + owner + "/" + repo + "/" + rawRef + "/" + relPath
	httpClient := deps.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", deps.UserAgent)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("raw fetch HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 50<<20))
	if err != nil {
		return err
	}
	return deps.Assets.Put(ctx, key, data)
}
