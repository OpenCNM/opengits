package webdoc

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	imgConcurrency      = 4
	imgMaxBytes         = 5 << 20
	imgURLHashLen       = 12
	inlineSVGDataPrefix = "data:image/svg+xml;base64,"
)

var mdImagePattern = regexp.MustCompile(`!\[[^\]]*\]\(\s*([^)\s]+)\s*(?:"[^"]*")?\)`)

func PersistSameOriginImages(ctx context.Context, owner, repo string, docs []FirecrawlDoc, rootURL string) []FirecrawlDoc {
	if len(docs) == 0 {
		return docs
	}

	var rootOrigin string
	if rootURL != "" {
		if rootParsed, err := url.Parse(rootURL); err == nil && rootParsed.Scheme != "" && rootParsed.Host != "" {
			rootOrigin = fmt.Sprintf("%s://%s", rootParsed.Scheme, rootParsed.Host)
		}
	}

	urlSet := map[string]bool{}
	inlineMap := map[string]string{}

	for _, d := range docs {
		for _, raw := range mdImagePattern.FindAllStringSubmatch(d.Markdown, -1) {
			ref := strings.TrimSpace(raw[1])
			if strings.HasPrefix(strings.ToLower(ref), inlineSVGDataPrefix) {
				if _, exists := inlineMap[ref]; !exists {
					if mapped, ok := saveInlineSVGAsset(owner, repo, ref); ok {
						inlineMap[ref] = mapped
					}
				}
				continue
			}
			if rootOrigin != "" {
				if resolved := resolveAgainst(ref, d.URL, rootURL); resolved != nil {
					if fmt.Sprintf("%s://%s", resolved.Scheme, resolved.Host) == rootOrigin {
						urlSet[resolved.String()] = true
					}
				}
			}
		}
	}

	urlMap := map[string]string{}
	if len(urlSet) > 0 {
		urls := make([]string, 0, len(urlSet))
		for u := range urlSet {
			urls = append(urls, u)
		}
		type dlResult struct {
			ok     bool
			path   string
			mapped string
		}
		results := map[string]dlResult{}
		var mu sync.Mutex
		var wg sync.WaitGroup
		work := make(chan string)
		workers := imgConcurrency
		if workers > len(urls) {
			workers = len(urls)
		}
		for i := 0; i < workers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for u := range work {
					rel, mapped, ok := downloadImage(ctx, owner, repo, u)
					mu.Lock()
					results[u] = dlResult{ok: ok, path: rel, mapped: mapped}
					mu.Unlock()
				}
			}()
		}
		for _, u := range urls {
			work <- u
		}
		close(work)
		wg.Wait()

		for u, r := range results {
			if r.ok {
				urlMap[u] = r.mapped
				_ = r.path
			}
		}
	}

	if len(urlMap) == 0 && len(inlineMap) == 0 {
		return docs
	}

	out := make([]FirecrawlDoc, len(docs))
	for i, d := range docs {
		md := mdImagePattern.ReplaceAllStringFunc(d.Markdown, func(full string) string {
			idx := mdImagePattern.FindStringSubmatchIndex(full)
			if len(idx) < 4 || idx[2] < 0 || idx[3] < idx[2] {
				return full
			}
			rawRef := full[idx[2]:idx[3]]
			ref := strings.TrimSpace(rawRef)
			if mapped, ok := inlineMap[ref]; ok {
				return full[:idx[2]] + mapped + full[idx[3]:]
			}
			if rootOrigin != "" {
				resolved := resolveAgainst(ref, d.URL, rootURL)
				if resolved != nil {
					if mapped, ok := urlMap[resolved.String()]; ok {
						return full[:idx[2]] + mapped + full[idx[3]:]
					}
				}
			}
			return full
		})
		out[i] = d
		out[i].Markdown = md
		out[i].ContentHash = hashContent(md)
	}
	return out
}

func saveInlineSVGAsset(owner, repo, dataURI string) (string, bool) {
	if owner == "" || repo == "" || len(dataURI) <= len(inlineSVGDataPrefix) {
		return "", false
	}
	b64Part := dataURI[len(inlineSVGDataPrefix):]
	rawBytes, err := base64.StdEncoding.DecodeString(b64Part)
	if err != nil || len(rawBytes) == 0 || len(rawBytes) > imgMaxBytes {
		return "", false
	}
	cleaned, ok := sanitizeSVGBytes(rawBytes)
	if !ok || len(cleaned) == 0 {
		return "", false
	}
	sum := sha1.Sum(cleaned)
	hash := hex.EncodeToString(sum[:])[:imgURLHashLen]
	relPath := fmt.Sprintf("webimg/%s.svg", hash)
	if !writeAssetAtomically(owner, repo, relPath, cleaned) {
		return "", false
	}
	return fmt.Sprintf("/api/assets/%s/%s/%s", owner, repo, relPath), true
}

func writeAssetAtomically(owner, repo, relPath string, body []byte) bool {
	dest := filepath.Join(assetsRootFor(owner, repo), relPath)
	dir := filepath.Dir(dest)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false
	}
	f, err := os.CreateTemp(dir, filepath.Base(dest)+".*.tmp")
	if err != nil {
		return false
	}
	tmp := f.Name()
	if _, err := f.Write(body); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return false
	}
	if err := f.Chmod(0o644); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return false
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return false
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return false
	}
	return true
}

func resolveAgainst(raw, docURL, rootURL string) *url.URL {
	for _, base := range []string{docURL, rootURL} {
		if base == "" {
			continue
		}
		if b, err := url.Parse(base); err == nil {
			if r, err := url.Parse(strings.TrimSpace(raw)); err == nil {
				return b.ResolveReference(r)
			}
		}
	}
	return nil
}

func downloadImage(ctx context.Context, owner, repo, imgURL string) (relPath, mapped string, ok bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imgURL, nil)
	if err != nil {
		return "", "", false
	}
	if ua := os.Getenv("WEB_CRAWLER_USER_AGENT"); ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	client := NewSafeHTTPClient(15*time.Second, 3)
	resp, err := client.Do(req)
	if err != nil {
		return "", "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", false
	}
	ct := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Type")))
	if !strings.HasPrefix(ct, "image/") {
		return "", "", false
	}
	if resp.ContentLength > imgMaxBytes {
		return "", "", false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, imgMaxBytes+1))
	if err != nil || len(body) == 0 || len(body) > imgMaxBytes {
		return "", "", false
	}

	sum := sha1.Sum([]byte(imgURL))
	hash := hex.EncodeToString(sum[:])[:imgURLHashLen]
	ext := imageExtFrom(ct, imgURL)
	if ext == "svg" {
		cleaned, ok := sanitizeSVGBytes(body)
		if !ok {
			return "", "", false
		}
		body = cleaned
	}
	relPath = fmt.Sprintf("webimg/%s.%s", hash, ext)

	if !writeAssetAtomically(owner, repo, relPath, body) {
		return "", "", false
	}
	mapped = fmt.Sprintf("/api/assets/%s/%s/%s", owner, repo, relPath)
	return relPath, mapped, true
}

func assetsRootFor(owner, repo string) string {
	root := os.Getenv("ASSETS_ROOT")
	if root == "" {
		root = "storage/assets"
	}
	return filepath.Join(root, owner, repo)
}

func imageExtFrom(contentType, imgURL string) string {
	switch {
	case strings.Contains(contentType, "jpeg"), strings.Contains(contentType, "jpg"):
		return "jpg"
	case strings.Contains(contentType, "webp"):
		return "webp"
	case strings.Contains(contentType, "gif"):
		return "gif"
	case strings.Contains(contentType, "svg"):
		return "svg"
	case strings.Contains(contentType, "png"):
		return "png"
	}
	if u, err := url.Parse(imgURL); err == nil {
		lower := strings.ToLower(u.EscapedPath())
		for _, ext := range []string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"} {
			if strings.HasSuffix(lower, ext) {
				if ext == ".jpeg" {
					return "jpg"
				}
				return strings.TrimPrefix(ext, ".")
			}
		}
	}
	return "png"
}

func hashContent(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
