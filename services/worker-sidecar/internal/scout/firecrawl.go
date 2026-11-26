package scout

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

const (
	minMarkdownChars = 50
	scrapeWaitForMs  = 1000
)

var (
	reHeading = regexp.MustCompile(`^(#{1,6})\s+(.+)$`)
)

type (
	FirecrawlHeading = webdoc.FirecrawlHeading
	FirecrawlDoc     = webdoc.FirecrawlDoc
	FirecrawlAPI     = webdoc.FirecrawlAPI
	CrawlFilters     = webdoc.CrawlFilters
)

type FirecrawlClient struct {
	baseURL      string
	apiKey       string
	http         *http.Client
	pollInterval time.Duration
}

func NewFirecrawlClient(baseURL, apiKey string) *FirecrawlClient {
	return &FirecrawlClient{
		baseURL:      strings.TrimRight(baseURL, "/"),
		apiKey:       apiKey,
		http:         &http.Client{Timeout: 120 * time.Second},
		pollInterval: 1 * time.Second,
	}
}

func (c *FirecrawlClient) ScrapeUrl(ctx context.Context, targetURL string) (*FirecrawlDoc, error) {
	body := map[string]any{
		"url":             targetURL,
		"formats":         []string{"markdown", "html"},
		"onlyMainContent": true,
		"waitFor":         scrapeWaitForMs,
	}
	b, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/scrape", bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("firecrawl scrape HTTP %d: %.300s", resp.StatusCode, raw)
	}

	var respObj struct {
		Success  bool           `json:"success"`
		Markdown string         `json:"markdown"`
		HTML     string         `json:"html"`
		Metadata map[string]any `json:"metadata"`
		Data     *struct {
			Markdown string         `json:"markdown"`
			HTML     string         `json:"html"`
			Metadata map[string]any `json:"metadata"`
		} `json:"data"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(raw, &respObj); err != nil {
		return nil, fmt.Errorf("decode firecrawl response: %w", err)
	}

	md := respObj.Markdown
	rawHTML := respObj.HTML
	meta := respObj.Metadata
	if respObj.Data != nil {
		if md == "" {
			md = respObj.Data.Markdown
		}
		if rawHTML == "" {
			rawHTML = respObj.Data.HTML
		}
		if meta == nil {
			meta = respObj.Data.Metadata
		}
	}
	if meta == nil {
		meta = make(map[string]any)
	}

	finalMD, domTitle, domHeadings, domTel := resolveFirecrawlPageContent(md, rawHTML, targetURL, meta)

	if strings.TrimSpace(finalMD) == "" {
		if respObj.Error != "" {
			return nil, fmt.Errorf("firecrawl scrape error: %s", respObj.Error)
		}
		return nil, errors.New("empty markdown content from firecrawl")
	}

	docPath := CanonicalDocPathFromUrl(targetURL)
	title := ""
	if t, ok := meta["title"].(string); ok && strings.TrimSpace(t) != "" {
		title = strings.TrimSpace(t)
	} else if domTitle != "" && domTitle != "Untitled" {
		title = domTitle
	} else {
		title = strings.TrimSuffix(docPath, ".md")
	}

	headings := domHeadings
	if len(headings) == 0 {
		headings = ExtractHeadingsFromMarkdown(finalMD)
	}

	h := sha256.Sum256([]byte(finalMD))
	contentHash := hex.EncodeToString(h[:])
	meta["engine"] = "firecrawl"

	return &FirecrawlDoc{
		Path:        docPath,
		Title:       title,
		Markdown:    finalMD,
		URL:         targetURL,
		ContentHash: contentHash,
		Headings:    headings,
		Metadata:    meta,
		Telemetry:   domTel,
	}, nil
}

func (c *FirecrawlClient) Crawl(ctx context.Context, rootURL string, limit int, filters *CrawlFilters) ([]FirecrawlDoc, error) {
	if limit <= 0 {
		limit = 50
	}
	body := map[string]any{
		"url":   rootURL,
		"limit": limit,
		"scrapeOptions": map[string]any{
			"formats":         []string{"markdown", "html"},
			"onlyMainContent": true,
			"waitFor":         scrapeWaitForMs,
		},
	}
	if filters != nil {
		if len(filters.IncludePaths) > 0 {
			body["includePaths"] = filters.IncludePaths
		}
		if len(filters.ExcludePaths) > 0 {
			body["excludePaths"] = filters.ExcludePaths
		}
	}
	b, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/crawl", bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("firecrawl start crawl HTTP %d: %.300s", resp.StatusCode, raw)
	}

	var startResp struct {
		ID    string `json:"id"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(raw, &startResp); err != nil {
		return nil, fmt.Errorf("decode firecrawl start response: %w", err)
	}
	if startResp.ID == "" {
		return nil, fmt.Errorf("failed to start firecrawl crawl job: %s", startResp.Error)
	}

	crawlID := startResp.ID
	pollURL := fmt.Sprintf("%s/v1/crawl/%s", c.baseURL, crawlID)

	ticker := time.NewTicker(c.pollInterval)
	defer ticker.Stop()

	consecutiveErrors := 0
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}

		pollReq, err := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
		if err != nil {
			return nil, err
		}
		if c.apiKey != "" {
			pollReq.Header.Set("Authorization", "Bearer "+c.apiKey)
		}

		pollResp, err := c.http.Do(pollReq)
		if err != nil {
			consecutiveErrors++
			if consecutiveErrors > 10 {
				return nil, fmt.Errorf("firecrawl crawl poll connection lost: %w", err)
			}
			continue
		}
		consecutiveErrors = 0

		rawPoll, _ := io.ReadAll(io.LimitReader(pollResp.Body, 64<<20))
		pollResp.Body.Close()

		if pollResp.StatusCode == http.StatusUnauthorized || pollResp.StatusCode == http.StatusForbidden {
			return nil, fmt.Errorf("firecrawl crawl poll HTTP %d: %.300s", pollResp.StatusCode, rawPoll)
		}

		if pollResp.StatusCode >= 400 {
			// Count HTTP 5xx responses toward consecutive failure backoff so persistent server errors do not spin indefinitely.
			consecutiveErrors++
			if consecutiveErrors > 10 {
				return nil, fmt.Errorf("firecrawl crawl poll HTTP %d persisted: %.300s", pollResp.StatusCode, rawPoll)
			}
			continue
		}

		var pollData struct {
			Status string `json:"status"`
			Error  string `json:"error"`
			Data   []struct {
				Markdown string         `json:"markdown"`
				HTML     string         `json:"html"`
				Metadata map[string]any `json:"metadata"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rawPoll, &pollData); err != nil {
			consecutiveErrors++
			if consecutiveErrors > 10 {
				return nil, fmt.Errorf("firecrawl crawl poll malformed payload persisted: %v", err)
			}
			continue
		}

		if pollData.Status == "completed" {
			var docs []FirecrawlDoc
			for _, page := range pollData.Data {
				pageURL := rootURL
				if page.Metadata != nil {
					if u, ok := page.Metadata["sourceURL"].(string); ok && u != "" {
						pageURL = u
					}
				}
				meta := page.Metadata
				if meta == nil {
					meta = make(map[string]any)
				}
				finalMD, domTitle, domHeadings, domTel := resolveFirecrawlPageContent(page.Markdown, page.HTML, pageURL, meta)
				if len(strings.TrimSpace(finalMD)) < minMarkdownChars {
					continue
				}
				docPath := CanonicalDocPathFromUrl(pageURL)
				title := ""
				if t, ok := meta["title"].(string); ok && strings.TrimSpace(t) != "" {
					title = strings.TrimSpace(t)
				} else if domTitle != "" && domTitle != "Untitled" {
					title = domTitle
				}
				if title == "" {
					title = strings.TrimSuffix(docPath, ".md")
				}

				headings := domHeadings
				if len(headings) == 0 {
					headings = ExtractHeadingsFromMarkdown(finalMD)
				}

				h := sha256.Sum256([]byte(finalMD))
				contentHash := hex.EncodeToString(h[:])
				meta["engine"] = "firecrawl"

				docs = append(docs, FirecrawlDoc{
					Path:        docPath,
					Title:       title,
					Markdown:    finalMD,
					URL:         pageURL,
					ContentHash: contentHash,
					Headings:    headings,
					Metadata:    meta,
					Telemetry:   domTel,
				})
			}
			return docs, nil
		}

		if pollData.Status == "failed" || pollData.Status == "cancelled" {
			return nil, fmt.Errorf("firecrawl job %s: %s", pollData.Status, pollData.Error)
		}
	}
}

// Prefer Firecrawl rendered HTML through DOM sanitization, falling back to Firecrawl Markdown for empty SPA shells.
func resolveFirecrawlPageContent(rawMD, rawHTML, pageURL string, meta map[string]any) (finalMD string, domTitle string, domHeadings []FirecrawlHeading, domTel *webdoc.ContentLiftTelemetry) {
	finalMD = rawMD
	if strings.TrimSpace(rawHTML) == "" {
		return finalMD, "", nil, nil
	}
	if meta != nil {
		meta["rawHtml"] = rawHTML
		meta["html"] = rawHTML
	}
	domMD, title, hList, tel, ok := webdoc.ConvertHTMLToMarkdown(rawHTML, pageURL)
	if !ok || len(strings.TrimSpace(domMD)) < minMarkdownChars {
		return finalMD, "", nil, nil
	}
	headings := make([]FirecrawlHeading, 0, len(hList))
	for _, h := range hList {
		headings = append(headings, FirecrawlHeading{
			Level: h.Level,
			Text:  h.Text,
			ID:    h.ID,
		})
	}
	return domMD, title, headings, &tel
}

func CanonicalDocPathFromUrl(rawURL string) string {
	return webdoc.CanonicalDocPathFromUrl(rawURL)
}

func ExtractHeadingsFromMarkdown(md string) []FirecrawlHeading {
	var headings []FirecrawlHeading
	lines := strings.Split(md, "\n")
	inCodeBlock := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inCodeBlock = !inCodeBlock
			continue
		}
		if inCodeBlock {
			continue
		}
		m := reHeading.FindStringSubmatch(line)
		if len(m) == 3 {
			level := len(m[1])
			text := strings.TrimSpace(m[2])
			id := mdpat.Slugify(text)
			if id == "" {
				id = fmt.Sprintf("heading-%d", len(headings)+1)
			}
			headings = append(headings, FirecrawlHeading{
				Level: level,
				Text:  text,
				ID:    id,
			})
		}
	}
	return headings
}
