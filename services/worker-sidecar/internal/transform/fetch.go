package transform

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Patterns interface {
	IsMarkdown(path string) bool
}

type IngestPatterns struct {
	Sniffer snifferPatterns `json:"sniffer"`
}

type snifferPatterns struct {
	MarkdownExtensions []string `json:"markdownExtensions"`
}

func (p *IngestPatterns) IsMarkdown(filePath string) bool {
	if p == nil {
		return false
	}
	lower := strings.ToLower(filePath)
	for _, ext := range p.Sniffer.MarkdownExtensions {
		if strings.HasSuffix(lower, strings.ToLower(ext)) {
			return true
		}
	}
	return false
}

func isMarkdownDocPath(patterns any, filePath string) bool {
	if patterns == nil {
		return false
	}
	if p, ok := patterns.(Patterns); ok {
		return p.IsMarkdown(filePath)
	}
	if ip, ok := patterns.(*IngestPatterns); ok {
		return ip.IsMarkdown(filePath)
	}
	return false
}

// Enforces filepath.Rel traversal check before reading local archive files.
func readLocalArchiveFile(archiveRoot, owner, repo, shaOrBranch, p string) string {
	if archiveRoot == "" || owner == "" || repo == "" || shaOrBranch == "" || p == "" {
		return ""
	}
	base := filepath.Join(archiveRoot, owner, repo, shaOrBranch)
	full := filepath.Join(base, filepath.FromSlash(p))
	rel, err := filepath.Rel(base, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return ""
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return ""
	}
	return string(b)
}

var codeWrapLangs = map[string]string{
	".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
	".py": "python", ".json": "json", ".md": "markdown", ".mdx": "mdx",
	".html": "html", ".css": "css", ".yml": "yaml", ".yaml": "yaml",
	".sh": "bash", ".bash": "bash", ".go": "go", ".rs": "rust",
	".c": "c", ".cpp": "cpp", ".java": "java",
}

var fenceRunRe = regexp.MustCompile("`{3,}")

func WrapCodeAsMdx(filePath, rawContent string) string {
	ext := strings.ToLower(path.Ext(filePath))
	lang := codeWrapLangs[ext]
	if lang == "" {
		lang = "text"
	}
	filename := strings.ReplaceAll(path.Base(filePath), "`", "")

	// Fence length uses max backtick run + 1 so embedded fences in source never break the outer fence.
	maxBackticks := 2
	for _, m := range fenceRunRe.FindAllString(rawContent, -1) {
		if len(m) > maxBackticks {
			maxBackticks = len(m)
		}
	}
	fence := strings.Repeat("`", maxBackticks+1)
	normalized := rawContent
	if !strings.HasSuffix(normalized, "\n") {
		normalized += "\n"
	}
	return "## 📄 `" + filename + "` <!-- path: " + filePath + " -->\n\n" +
		fence + lang + "\n" + normalized + fence + "\n"
}

func wrapCodeAsMdx(filePath, rawContent string) string {
	return WrapCodeAsMdx(filePath, rawContent)
}

// Wraps non-Markdown source idempotently so raw code is not parsed as MDX prose.
func EnsureCodeWrappedAsMdx(filePath, content string) string {
	if strings.TrimSpace(content) == "" {
		return content
	}
	if strings.Contains(content, "<!-- path: ") && fenceRunRe.MatchString(content) {
		return content
	}
	return WrapCodeAsMdx(filePath, content)
}

func fetchDocRawLocalFirst(ctx context.Context, deps GoTransformDeps, owner, repo, branch string, gitSha *string, filePath, githubToken string) (string, error) {
	isMarkdown := isMarkdownDocPath(deps.Patterns, filePath)

	ref := branch
	if gitSha != nil && *gitSha != "" {
		ref = *gitSha
	}
	if local := readLocalArchiveFile(deps.ArchiveRoot, owner, repo, ref, filePath); local != "" {
		if isMarkdown {
			return local, nil
		}
		return wrapCodeAsMdx(filePath, local), nil
	}

	url := deps.RawBase + "/" + owner + "/" + repo + "/" + ref + "/" + filePath
	httpClient := deps.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(time.Duration(attempt) * time.Second):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("User-Agent", deps.UserAgent)
		token := githubToken
		if token == "" {
			token = deps.GitHubToken
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			lastErr = fmt.Errorf("raw fetch HTTP %d", resp.StatusCode)
			// Skips retries on 404/410 since the target file is definitively absent.
			if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
				break
			}
			continue
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, 50<<20))
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		text := string(data)
		if isMarkdown {
			return text, nil
		}
		return wrapCodeAsMdx(filePath, text), nil
	}
	return "", fmt.Errorf("raw fetch failed for %s after 3 attempts: %v", filePath, lastErr)
}
