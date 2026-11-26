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

type OpenApiSpecInfo struct {
	Version string         `json:"version"`
	Title   string         `json:"title"`
	SpecURL string         `json:"specUrl"`
	SpecRaw map[string]any `json:"specRaw"`
}

const (
	maxOpenApiSpecBytes = 15 << 20
	detectorTimeout     = 4 * time.Second
)

var (
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
		resolved := u.String()
		if !seenURL[resolved] && IsPublicEndpoint(resolved) {
			seenURL[resolved] = true
			candidateURLs = append(candidateURLs, resolved)
		}
	}

	addCandidate(entryURL)

	if htmlContent != "" {
		extractSpecUrlsFromHTML(htmlContent, parsed, addCandidate)
	}

	baseURL := fmt.Sprintf("%s://%s", parsed.Scheme, parsed.Host)
	for _, p := range commonOpenApiPaths {
		addCandidate(baseURL + p)
		if parsed.Path != "" && parsed.Path != "/" {
			trimmedPath := strings.TrimRight(parsed.Path, "/")
			addCandidate(baseURL + trimmedPath + p)
		}
	}

	if len(candidateURLs) == 0 {
		return nil
	}

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
					cancel()
				})
			}
		}(cand)
	}

	wg.Wait()
	return result
}

func extractSpecUrlsFromHTML(content string, baseURL *url.URL, add func(string)) {
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

	lowerHead := strings.ToLower(string(data[:min(len(data), 512)]))
	if !strings.Contains(lowerHead, "openapi") && !strings.Contains(lowerHead, "swagger") {
		return nil
	}

	var specMap map[string]any
	if err := json.Unmarshal(data, &specMap); err != nil {
		// Only parse as YAML when non-JSON evidence exists to defend against YAML alias expansion bombs.
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
