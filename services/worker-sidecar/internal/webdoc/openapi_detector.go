package webdoc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"go.yaml.in/yaml/v3"
	"golang.org/x/net/html"
)

// OpenApiSpecInfo 表示探测到的 OpenAPI / Swagger 规范元信息。
type OpenApiSpecInfo struct {
	Version string         `json:"version"` // e.g. "3.1.0", "3.0.0", "2.0"
	Title   string         `json:"title"`   // info.title
	SpecURL string         `json:"specUrl"` // 规范抓取地址
	SpecRaw map[string]any `json:"specRaw"` // 标准化后的对象
}

const (
	maxOpenApiSpecBytes = 15 << 20 // 15MB 保护上限
	detectorTimeout     = 4 * time.Second
)

var (
	// 常见的静态 OpenAPI / Swagger 文件候选路径
	commonOpenApiPaths = []string{
		"/openapi.json",
		"/openapi.yaml",
		"/openapi.yml",
		"/swagger.json",
		"/swagger.yaml",
		"/v3/api-docs",
		"/v3/api-docs.json",
		"/api-docs.json",
		"/api/openapi.json",
		"/api/swagger.json",
		"/api-docs/openapi.json",
	}

	reSpecURLAttr = regexp.MustCompile(`(?i)(?:spec-url|data-url|url)\s*[:=]\s*["']([^"']+\.(?:json|yaml|yml))["']`)
)

// DetectOpenApiSpec 探测目标文档站点是否附带标准 OpenAPI / Swagger 规范。
// 探测策略：
// 1. 若提供了 HTML 内容，优先从 HTML 内联脚本、<link> 标签、Swagger/Redoc 配置中提取 spec 链接；
// 2. 并发探测同源常见候选路径 (/openapi.json, /swagger.json 等)；
// 3. 校验返回内容是否满足 OpenAPI 3.x 或 Swagger 2.0 基础结构；
// 4. 首个成功响应即短路取消其他探测，返回结构化元数据。
func DetectOpenApiSpec(ctx context.Context, entryURL string, htmlContent string) *OpenApiSpecInfo {
	parsed, err := url.Parse(entryURL)
	if err != nil || parsed.Host == "" {
		return nil
	}

	detectCtx, cancel := context.WithTimeout(ctx, detectorTimeout)
	defer cancel()

	client := NewSafeHTTPClient(3*time.Second, 3)

	var candidateURLs []string
	seenURL := make(map[string]bool)
	addCandidate := func(rawURL string) {
		if rawURL == "" {
			return
		}
		u, err := parsed.Parse(rawURL)
		if err != nil {
			return
		}
		// 仅同源或安全公网探测
		resolved := u.String()
		if !seenURL[resolved] && IsPublicEndpoint(resolved) {
			seenURL[resolved] = true
			candidateURLs = append(candidateURLs, resolved)
		}
	}

	// 0. 将入口 URL 自身作为候选（应对用户直接输入 OpenAPI 规范链接的场景）
	addCandidate(entryURL)

	// 1. 从 HTML 中嗅探内联引用
	if htmlContent != "" {
		extractSpecUrlsFromHTML(htmlContent, parsed, addCandidate)
	}

	// 2. 追加常见已知路径
	baseURL := fmt.Sprintf("%s://%s", parsed.Scheme, parsed.Host)
	for _, p := range commonOpenApiPaths {
		addCandidate(baseURL + p)
		// 如果入口 URL 带有子路径（如 /api 或 /docs），亦尝试其下一级
		if parsed.Path != "" && parsed.Path != "/" {
			trimmedPath := strings.TrimRight(parsed.Path, "/")
			addCandidate(baseURL + trimmedPath + p)
		}
	}

	if len(candidateURLs) == 0 {
		return nil
	}

	// 3. 并发探测（首中即取消）
	var once sync.Once
	var result *OpenApiSpecInfo

	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup

	for _, cand := range candidateURLs {
		if detectCtx.Err() != nil {
			break
		}
		wg.Add(1)
		go func(target string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-detectCtx.Done():
				return
			}

			spec := fetchAndValidateSpec(detectCtx, client, target)
			if spec != nil {
				once.Do(func() {
					result = spec
					cancel() // 短路其他探测请求
				})
			}
		}(cand)
	}

	wg.Wait()
	return result
}

// extractSpecUrlsFromHTML 从 HTML 片段中提取可能的 OpenAPI 规范地址。
func extractSpecUrlsFromHTML(content string, baseURL *url.URL, add func(string)) {
	// 正则快速嗅探 spec-url="xxx" / data-url="xxx"（防御性限制：仅信任相对路径或同源地址）
	matches := reSpecURLAttr.FindAllStringSubmatch(content, 5)
	for _, m := range matches {
		if len(m) >= 2 {
			cand := m[1]
			if u, err := url.Parse(cand); err == nil {
				if u.Host == "" || strings.EqualFold(u.Host, baseURL.Host) {
					add(cand)
				}
			}
		}
	}

	// DOM 解析寻找 <link rel="alternate" type="application/json">
	doc, err := html.Parse(strings.NewReader(content))
	if err != nil {
		return
	}

	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if n.Data == "link" {
				var rel, href, typ string
				for _, a := range n.Attr {
					switch strings.ToLower(a.Key) {
					case "rel":
						rel = strings.ToLower(a.Val)
					case "href":
						href = a.Val
					case "type":
						typ = strings.ToLower(a.Val)
					}
				}
				if href != "" && (rel == "alternate" || rel == "preload") && strings.Contains(typ, "json") {
					add(href)
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
}

// fetchAndValidateSpec 发起请求并校验是否是有效的 OpenAPI 规范。
func fetchAndValidateSpec(ctx context.Context, client *http.Client, target string) *OpenApiSpecInfo {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", "OpenGits-SpecDetector/1.0")
	req.Header.Set("Accept", "application/json, application/yaml, text/yaml;q=0.9, */*;q=0.8")

	resp, err := client.Do(req)
	if err != nil || resp == nil {
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil
	}

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxOpenApiSpecBytes))
	if err != nil || len(data) < 20 {
		return nil
	}

	// 快速文本启发式：必须出现 openapi 或 swagger 关键词
	lowerHead := strings.ToLower(string(data[:min(len(data), 512)]))
	if !strings.Contains(lowerHead, "openapi") && !strings.Contains(lowerHead, "swagger") {
		return nil
	}

	// 尝试作为 JSON 解析
	var specMap map[string]any
	if err := json.Unmarshal(data, &specMap); err != nil {
		// 回退尝试 YAML 解析：仅当明确存在 YAML 证据且未以 '{' 开头时执行，防止恶意别名爆炸展开 (Billion Laughs)
		trimmed := strings.TrimSpace(string(data[:min(len(data), 64)]))
		if !strings.HasPrefix(trimmed, "{") && (strings.HasSuffix(target, ".yaml") || strings.HasSuffix(target, ".yml") || strings.Contains(trimmed, "openapi:") || strings.Contains(trimmed, "swagger:")) {
			if errYaml := yaml.Unmarshal(data, &specMap); errYaml != nil {
				return nil
			}
		} else {
			return nil
		}
	}

	return ParseOpenApiSpecMap(specMap, target)
}

// ParseOpenApiSpecMap 校验并提取规范版本与标题信息。
func ParseOpenApiSpecMap(specMap map[string]any, specURL string) *OpenApiSpecInfo {
	if specMap == nil {
		return nil
	}

	var version string
	if v, ok := specMap["openapi"].(string); ok && strings.HasPrefix(strings.TrimSpace(v), "3.") {
		version = strings.TrimSpace(v)
	} else if v, ok := specMap["swagger"].(string); ok && strings.HasPrefix(strings.TrimSpace(v), "2.") {
		version = strings.TrimSpace(v)
	}

	if version == "" {
		return nil
	}

	// 必须具备 paths 字典或 components 声明
	if _, hasPaths := specMap["paths"]; !hasPaths {
		if _, hasComponents := specMap["components"]; !hasComponents {
			return nil
		}
	}

	var title string
	if info, ok := specMap["info"].(map[string]any); ok {
		if t, ok := info["title"].(string); ok {
			title = strings.TrimSpace(t)
		}
	}

	return &OpenApiSpecInfo{
		Version: version,
		Title:   title,
		SpecURL: specURL,
		SpecRaw: specMap,
	}
}
