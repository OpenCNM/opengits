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

// ─────────────────────────────────────────────────────────────
// web 内部端点客户端（M2c）：prepare / transform / sanitize / finalize。
// x-internal-token 同模式。mdx/validate 已下沉进程内（D组端点1，Zero-Web）。
// ─────────────────────────────────────────────────────────────

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

// internalWebAPI / LlmGatewayAPI 最小接口面（单测 fake）。
type internalWebAPI interface {
	ValidateMdx(ctx context.Context, source string) (bool, string, error)
	ExtractManifest(ctx context.Context, content, path string) (string, error)
}

// internalJobAPI job 层 web 端点（Zero-Node Worker 收官：execute 已移除）。
type internalJobAPI interface {
}

// PrepareResult /api/internal/doc/prepare 响应（对齐 internal/doc 核心模型）。
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

// ValidateMdx MDX 预编译校验（D组收刀 1/8：/api/internal/mdx/validate 下沉）。
// 进程内 mdx.ValidateDetailed 单实现（纯计算，黄金夹具 mdx-validate.golden.json
// 冻结裁定口径）；零网络调用，错误恒为 nil，保留接口签名供单测 fake 注入。
func (c *internalWebClient) ValidateMdx(ctx context.Context, source string) (bool, string, error) {
	_ = ctx
	valid, errMsg := mdx.ValidateDetailed(source)
	return valid, errMsg, nil
}

// ExtractManifest 剥离 <concept_manifest>（防 JSON 花括号触发 MDX 误报）。
// 终结向 Node 发起 /api/internal/mdx/extract-manifest 的反向网络调用（Zero-Ping-Pong），直接进程内处理。
func (c *internalWebClient) ExtractManifest(ctx context.Context, content, path string) (string, error) {
	manifest := concept.ExtractConceptManifest(content, path)
	return manifest.CleanContent, nil
}


// RunMarketEngineTick 市场引擎 tick（D组6c：端点收窄为 TRIAL 投票结算
// swapIn 资金事务 + 维护者兜底转录 BYOK 引擎——确定性周期已 Go 进程内直跑）。
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

// GrantImportReward sends only the job ID; Node reloads all eligibility facts.
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

// revalidateMaxAttempts L1 失效 ping 有界重试上限（瞬时抖动窗口关闭；
// web 单副本拓扑下 web 不可达 ⇒ 读者同样不可达，TTL 60s 是最终兜底）。
const revalidateMaxAttempts = 3

// RevalidateRepository 通知 Web 端失效指定仓库的 L1 纯内存大纲投影与数据缓存。
// 有界重试（500ms 退避）：失效 ping 丢失 = 读者端最长 60s 幽灵旧大纲。
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
