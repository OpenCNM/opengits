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

// Patterns 接口抽象，用于判定文档路径是否为 markdown（兼容 worker-sidecar IngestPatterns）。
type Patterns interface {
	IsMarkdown(path string) bool
}

// IngestPatterns 本地最小实现（测试与轻量级客户端使用）。
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

// isMarkdownDocPath 统一判定路径是否为 markdown。
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

// readLocalArchiveFile 从本地解压归档目录读取文件（含防路径穿越边界校验）。
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

// ─────────────────────────────────────────────────────────────
// 文档底稿抓取链（D组端点4：/api/internal/doc/transform 下沉）。
//
// 对齐 Node getFileContentLocalFirst + Fetcher.getRawContent 语义：
// 归档直读（sha 形态 ref）→ raw 回源（3 次重试）→ 非 markdown 文件
// wrapCodeAsMdx 包壳（演示代码素材转 MDX 章节形态，两侧 fetch 链共用语义）。
// ─────────────────────────────────────────────────────────────

// codeWrapLangs 扩展名 → 围栏语言注册表（对齐 engine/code-to-mdx.ts extToLang）。
var codeWrapLangs = map[string]string{
	".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
	".py": "python", ".json": "json", ".md": "markdown", ".mdx": "mdx",
	".html": "html", ".css": "css", ".yml": "yaml", ".yaml": "yaml",
	".sh": "bash", ".bash": "bash", ".go": "go", ".rs": "rust",
	".c": "c", ".cpp": "cpp", ".java": "java",
}

var fenceRunRe = regexp.MustCompile("`{3,}")

// wrapCodeAsMdx 代码文件包壳为 MDX 章节（对齐 code-to-mdx.ts：自适应围栏
// 长度防内容反围栏、文件名反引号剥离、`<!-- path: -->` 锚点标记、尾部换行归一）。
func wrapCodeAsMdx(filePath, rawContent string) string {
	ext := strings.ToLower(path.Ext(filePath))
	lang := codeWrapLangs[ext]
	if lang == "" {
		lang = "text"
	}
	filename := strings.ReplaceAll(path.Base(filePath), "`", "")

	// 围栏长度 = 内容最长反引号串 + 1（默认 3 起），永不破壳
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

// fetchDocRawLocalFirst 底稿抓取链：归档 sha 直读（0 网络）→ raw 回源
// （冻结 sha 优先，3 次重试）；非 markdown 文件包壳。miss/网络失败显式 error。
func fetchDocRawLocalFirst(ctx context.Context, deps GoTransformDeps, owner, repo, branch string, gitSha *string, filePath, githubToken string) (string, error) {
	isMarkdown := isMarkdownDocPath(deps.Patterns, filePath)

	// 归档直读：仅 sha 形态 ref 可命中（branch 名任意无法定位）
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

	// raw 回源：对齐 Fetcher.getRawContent（3 次重试 + Bearer 凭据）
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
			// 404/410 = 文件确定不存在：重试 3 遍纯浪费（1s+2s 退避）
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
	// 抛错而非占位串：占位内容会被下游当真文档处理（Node 同款防御）
	return "", fmt.Errorf("raw fetch failed for %s after 3 attempts: %v", filePath, lastErr)
}
