package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/mdx"
)

type internalWebClient struct {
	baseURL string
	token   string
	http    *http.Client
}

func NewInternalWebClient(baseURL, token string) *internalWebClient {
	return &internalWebClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 300 * time.Second},
	}
}

type internalWebAPI interface {
	ValidateMdx(ctx context.Context, source string) (bool, string, error)
	ExtractManifest(ctx context.Context, content, path string) (string, error)
}

type internalJobAPI interface {
}

type PrepareResult = doc.PrepareResult

func (c *internalWebClient) post(ctx context.Context, path string, body any, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-internal-token", c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if resp.StatusCode >= 400 {
		return fmt.Errorf("internal %s: HTTP %d: %.300s", path, resp.StatusCode, raw)
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func (c *internalWebClient) ValidateMdx(ctx context.Context, source string) (bool, string, error) {
	_ = ctx
	valid, errMsg := mdx.ValidateDetailed(source)
	return valid, errMsg, nil
}

func (c *internalWebClient) ExtractManifest(ctx context.Context, content, path string) (string, error) {
	manifest := concept.ExtractConceptManifest(content, path)
	return manifest.CleanContent, nil
}

func (c *internalWebClient) RunMarketEngineTick(ctx context.Context) error {
	var out struct {
		OK      bool   `json:"ok"`
		Message string `json:"message"`
	}
	if err := c.post(ctx, "/api/internal/scheduler/auto-update-once", map[string]any{}, &out); err != nil {
		return err
	}
	if !out.OK {
		return fmt.Errorf("market engine tick failed: %s", out.Message)
	}
	return nil
}

const importRewardPath = "/api/internal/job/import-reward"

func (c *internalWebClient) GrantImportReward(ctx context.Context, jobId string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var out struct {
		OK      bool   `json:"ok"`
		Message string `json:"message"`
	}
	body := struct {
		JobId string `json:"jobId"`
	}{jobId}
	if err := c.post(ctx, importRewardPath, body, &out); err != nil {
		return err
	}
	if !out.OK {
		return fmt.Errorf("import reward callback failed: %s", out.Message)
	}
	return nil
}

const revalidateMaxAttempts = 3

// Retry web L1 invalidation briefly to close the 60s stale-outline window on transient network blips.
func (c *internalWebClient) RevalidateRepository(ctx context.Context, repoId string) error {
	var out struct {
		OK      bool   `json:"ok"`
		Message string `json:"message"`
	}
	body := map[string]any{
		"repositoryIds": []string{repoId},
	}
	var lastErr error
	for attempt := 0; attempt < revalidateMaxAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(500 * time.Millisecond):
			}
		}
		out = struct {
			OK      bool   `json:"ok"`
			Message string `json:"message"`
		}{}
		if err := c.post(ctx, "/api/internal/revalidate", body, &out); err != nil {
			lastErr = err
			continue
		}
		if !out.OK {
			lastErr = fmt.Errorf("revalidate repository failed: %s", out.Message)
			continue
		}
		return nil
	}
	return lastErr
}
