package client

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────
// LLM 网关 Go 客户端（M1 / 方向 3）：Go 执行体调用 web 的 /api/internal/llm/generate。
//
// 契约（与 lib/llm-gateway/service.ts 逐字对齐）：
//   POST {purpose, variables, userId?} + x-internal-token
//   → 200 {ok:true, object, mode}
//   ↘ 400 UNKNOWN_PURPOSE / 409 MISSING_API_KEY / 429 BUDGET_EXCEEDED（延后重试）
//   ↘ 502 GENERATION_FAILED
// prompt 与 schema 的单一事实源在 web 侧注册表——本客户端零 schema 零 prompt。
//
// 方向 3 补强：
// - Complete 默认携带 x-stream-mode: 1，消费 application/x-ndjson；
// - 10s 心跳 ping 保活刷新活跃租约（Activity Timeout），防御超长静默断联；
// - 非流式一元 JSON 兼容兜底。
// ─────────────────────────────────────────────────────────────

// LlmCompleter LLM 完成接口（解耦 LlmGatewayClient 与单测 Mock）。
type LlmCompleter interface {
	Complete(ctx context.Context, purpose string, variables map[string]any, userId *string) (LlmTextResult, error)
}

// LlmStreamProgress 流式进度快照（M1/方向 3 流式进度与活性透出）。
type LlmStreamProgress struct {
	Stage          string // "thinking" | "generating"
	ReasoningChars int
	ContentChars   int
	ElapsedMs      int64
}

type streamProgressKey struct{}

// StreamProgressCallback 流式进度回调函数签名。
type StreamProgressCallback func(LlmStreamProgress)

// WithStreamProgress 将流式进度回调注入 Context。
func WithStreamProgress(ctx context.Context, cb StreamProgressCallback) context.Context {
	return context.WithValue(ctx, streamProgressKey{}, cb)
}

func getStreamProgress(ctx context.Context) StreamProgressCallback {
	if cb, ok := ctx.Value(streamProgressKey{}).(StreamProgressCallback); ok {
		return cb
	}
	return nil
}

type LlmGatewayClient struct {
	baseURL         string // 形如 http://web:3000
	token           string
	http            *http.Client
	activityTimeout time.Duration
}

func NewLlmGatewayClient(baseURL, token string) *LlmGatewayClient {
	transport := &http.Transport{
		MaxIdleConns:        32,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
	}
	return &LlmGatewayClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http: &http.Client{
			Transport: transport,
			Timeout:   0, // 超时由 Request Context 或 Activity Watchdog 控制，流式长连接不被粗暴强掐
		},
	}
}

// SetActivityTimeout 设置流式空闲超时（主要供单测快速验证，生产默认 45s）
func (c *LlmGatewayClient) SetActivityTimeout(d time.Duration) {
	c.activityTimeout = d
}

// 错误码契约（严格对齐 apps/client/src/lib/llm-gateway/service.ts 与 11.7.3 向量）
const (
	ErrCodeUnknownPurpose   = "UNKNOWN_PURPOSE"
	ErrCodeMissingApiKey    = "MISSING_API_KEY"
	ErrCodeBudgetExceeded   = "BUDGET_EXCEEDED"
	ErrCodeGenerationFailed = "GENERATION_FAILED"
	ErrCodeRateLimited      = "RATE_LIMITED"
)

// 重试退避契约（调用方遵循指数退避与上限截断）
const (
	DefaultLlmRetryInitialBackoff = 500 * time.Millisecond
	DefaultLlmRetryMaxBackoff     = 8 * time.Second
	DefaultLlmRetryMaxAttempts    = 3
)

// ErrStreamPartial 流在完成前被切断（调用方 deadline / 活性看门狗），但已
// 收到部分内容——返回值 LlmTextResult.Text 携带聚合残文，调用方可做确定性
// 抢救（如大纲流中已完整落章的 JSON 对象）。仅取消类切断返回本哨兵；
// provider 显式 error 事件不抢救（内容可信度不足）。
var ErrStreamPartial = errors.New("llm-gateway: stream cut before completion (partial content in Text)")

// 流式活跃超时（防静默挂起：收到任意 ping/chunk 事件即刷新）
const (
	// DefaultLlmActivityTimeout 连接层:任意行(含 ping)续期。须覆盖网关
	// "流前静默"——provider 整章生成首字节可达 120s+(2026-09-20 转录 E2E
	// 实测 2.0min),45s 会误杀健康长生成
	DefaultLlmActivityTimeout = 180 * time.Second
	// DefaultLlmDataTimeout 数据层:仅 chunk/done 续期(ping 不续)——
	// 网关心跳保活会掩盖 provider 流静止,需独立看门狗;须大于 provider
	// 首 chunk 前的思考时间(实测 ~120s)
	DefaultLlmDataTimeout = 240 * time.Second
)

// LlmGatewayError 结构化错误（调用方按 code 分支，不 parse 文案）。
type LlmGatewayError struct {
	Code    string
	Message string
	Status  int
}

func (e *LlmGatewayError) Error() string {
	return fmt.Sprintf("llm-gateway %s: %s", e.Code, e.Message)
}

// IsUnknownPurpose 未知 purpose：调用方入参错误（400）。
func (e *LlmGatewayError) IsUnknownPurpose() bool { return e.Code == ErrCodeUnknownPurpose }

// IsBudgetExceeded 预算不足：调用方延后重试（转录队列 defer 语义），不计失败（429）。
func (e *LlmGatewayError) IsBudgetExceeded() bool { return e.Code == ErrCodeBudgetExceeded }

// IsMissingApiKey BYOK 未配置：调用方走零成本退出路径（与 Node 侧 [] 语义对齐）（409）。
func (e *LlmGatewayError) IsMissingApiKey() bool { return e.Code == ErrCodeMissingApiKey }

// IsGenerationFailed 生成失败：LLM 提供商下游异常或模式校验失败（502）。
func (e *LlmGatewayError) IsGenerationFailed() bool { return e.Code == ErrCodeGenerationFailed }

// IsRateLimited 限流判定：429 状态、RATE_LIMITED 码或文案含 429/rate limit/ratelimit/
// throttling/toomanyrequests/速率限制/请求频率/并发超限（BUDGET_EXCEEDED 同为 429 但语义专属，先排除）。
func (e *LlmGatewayError) IsRateLimited() bool {
	if e.IsBudgetExceeded() || e.IsMissingApiKey() {
		return false
	}
	if e.Code == ErrCodeRateLimited || e.Status == 429 {
		return true
	}
	m := strings.ToLower(e.Message)
	return strings.Contains(m, "429") || strings.Contains(m, "rate limit") ||
		strings.Contains(m, "ratelimit") || strings.Contains(m, "throttling") ||
		strings.Contains(m, "toomanyrequests") || strings.Contains(m, "速率限制") ||
		strings.Contains(m, "请求频率") || strings.Contains(m, "并发超限")
}

// IsTransient 瞬态错误判定：503/504 状态或文案含 bad gateway/gateway timeout/
// gateway time-out/service unavailable/connection reset/econnreset/etimedout/socket hang up。
func (e *LlmGatewayError) IsTransient() bool {
	if e.IsBudgetExceeded() || e.IsMissingApiKey() || e.IsUnknownPurpose() {
		return false
	}
	if e.Status == 503 || e.Status == 504 {
		return true
	}
	m := strings.ToLower(e.Message)
	return strings.Contains(m, "bad gateway") || strings.Contains(m, "gateway timeout") ||
		strings.Contains(m, "gateway time-out") ||
		strings.Contains(m, "service unavailable") || strings.Contains(m, "connection reset") ||
		strings.Contains(m, "econnreset") || strings.Contains(m, "etimedout") || strings.Contains(m, "socket hang up")
}

func mapLlmErrorCodeToStatus(code string) int {
	switch code {
	case ErrCodeBudgetExceeded, ErrCodeRateLimited:
		return 429
	case ErrCodeMissingApiKey:
		return 409
	case ErrCodeUnknownPurpose:
		return 400
	case ErrCodeGenerationFailed:
		return 502
	default:
		return 500
	}
}

// LlmUsage 网关 usage 记账（repository.transcriptionTokens 累计依据）。
type LlmUsage struct {
	PromptTokens     int `json:"promptTokens"`
	CompletionTokens int `json:"completionTokens"`
	TotalTokens      int `json:"totalTokens"`
}

// LlmTextResult text purpose 的补全结果（原文哨兵后处理归调用方）。
type LlmTextResult struct {
	Text         string
	FinishReason string
	Usage        LlmUsage
	CallID       string
}

// post 统一请求样板：POST JSON + x-internal-token + 响应封顶读取，
// 返回状态码与原始响应体（envelope 解析归调用方）。
func (c *LlmGatewayClient) post(ctx context.Context, body map[string]any, limit int64) (int, []byte, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	reqCtx := ctx
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		reqCtx, cancel = context.WithTimeout(ctx, 300*time.Second)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, c.baseURL+"/api/internal/llm/generate", bytes.NewReader(b))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-internal-token", c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, limit))
	return resp.StatusCode, raw, nil
}

// Complete 执行一次 text purpose 调用（默认携带 x-stream-mode: 1，NDJSON 10s 心跳保活与增量传输）。
func (c *LlmGatewayClient) Complete(ctx context.Context, purpose string, variables map[string]any, userId *string) (LlmTextResult, error) {
	body := map[string]any{"purpose": purpose, "variables": variables}
	if userId != nil {
		body["userId"] = *userId
	}
	b, err := json.Marshal(body)
	if err != nil {
		return LlmTextResult{}, err
	}

	reqCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	timeout := c.activityTimeout
	if timeout <= 0 {
		timeout = DefaultLlmActivityTimeout
	}

	dataTimeout := DefaultLlmDataTimeout
	if c.activityTimeout > 0 {
		dataTimeout = c.activityTimeout * 2
	}

	// 连接层保活:任意行(含 ping)续期——防代理/ LB 静默断连
	timer := time.AfterFunc(timeout, func() {
		cancel()
	})
	defer timer.Stop()
	// 数据层看门狗:仅模型增量(chunk/done)续期——网关心跳 ping 会以固定
	// 间隔永续连接层定时器,provider 流挂死时表现为"连接活着但零增量",
	// 23 分钟级假在线(2026-09-20 转录 E2E 实测);120s 无数据即判死
	dataTimer := time.AfterFunc(dataTimeout, func() {
		cancel()
	})
	defer dataTimer.Stop()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, c.baseURL+"/api/internal/llm/generate", bytes.NewReader(b))
	if err != nil {
		return LlmTextResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/x-ndjson")
	req.Header.Set("x-stream-mode", "1")
	req.Header.Set("x-internal-token", c.token)

	streamStart := time.Now()
	resp, err := c.http.Do(req)
	if err != nil {
		if errors.Is(reqCtx.Err(), context.Canceled) && ctx.Err() == nil {
			return LlmTextResult{}, fmt.Errorf("llm-gateway: activity timeout exceeded (%v with no data)", timeout)
		}
		return LlmTextResult{}, err
	}
	defer resp.Body.Close()

	// 非 200 响应：可能是权限 403、参数 400，或非流式错误信封
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		var errEnvelope struct {
			OK      bool   `json:"ok"`
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if jsonErr := json.Unmarshal(raw, &errEnvelope); jsonErr == nil && errEnvelope.Code != "" {
			return LlmTextResult{}, &LlmGatewayError{
				Code:    errEnvelope.Code,
				Message: errEnvelope.Message,
				Status:  resp.StatusCode,
			}
		}
		return LlmTextResult{}, fmt.Errorf("llm-gateway: HTTP %d: %s", resp.StatusCode, string(raw))
	}

	// 兼容兜底：若响应非 application/x-ndjson，回落既有一元 JSON 解析
	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(contentType, "application/x-ndjson") {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		var envelope struct {
			OK           bool     `json:"ok"`
			Text         string   `json:"text"`
			FinishReason string   `json:"finishReason"`
			Code         string   `json:"code"`
			Message      string   `json:"message"`
			Usage        LlmUsage `json:"usage"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			return LlmTextResult{}, fmt.Errorf("llm-gateway: malformed response (HTTP %d): %w", resp.StatusCode, err)
		}
		if !envelope.OK {
			status := mapLlmErrorCodeToStatus(envelope.Code)
			return LlmTextResult{}, &LlmGatewayError{Code: envelope.Code, Message: envelope.Message, Status: status}
		}
		if cb := getStreamProgress(ctx); cb != nil {
			cb(LlmStreamProgress{
				Stage:        "generating",
				ContentChars: len(envelope.Text),
				ElapsedMs:    time.Since(streamStart).Milliseconds(),
			})
		}
		return LlmTextResult{Text: envelope.Text, FinishReason: envelope.FinishReason, Usage: envelope.Usage, CallID: resp.Header.Get("x-llm-call-id")}, nil
	}

	// 流式 NDJSON 解析
	callID := resp.Header.Get("x-llm-call-id")
	progressCb := getStreamProgress(ctx)

	var (
		linesCount     int
		contentCount   int
		reasoningCount int
		reasoningChars int
		contentChars   int
		pingCount      int
		unknownCount   int
		cancelReason   any
	)

	defer func() {
		totalMs := time.Since(streamStart).Milliseconds()
		log.Printf("[llm-stream-client] call=%s lines=%d kinds={content:%d,reasoning:%d} pings=%d cancel_reason=%v total_ms=%d",
			callID, linesCount, contentCount, reasoningCount, pingCount, cancelReason, totalMs)
	}()

	scanner := bufio.NewScanner(resp.Body)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 16*1024*1024)

	var accumulated strings.Builder
	var finalResult *LlmTextResult
	var streamErr *LlmGatewayError

	for scanner.Scan() {
		timer.Reset(timeout)
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		linesCount++

		var event struct {
			Type         string   `json:"type"`
			Delta        string   `json:"delta"`
			Kind         string   `json:"kind"` // content(缺省) | reasoning
			OK           *bool    `json:"ok"`
			Text         string   `json:"text"`
			FinishReason string   `json:"finishReason"`
			Code         string   `json:"code"`
			Message      string   `json:"message"`
			Usage        LlmUsage `json:"usage"`
		}
		if err := json.Unmarshal(line, &event); err != nil {
			unknownCount++
			continue
		}

		switch event.Type {
		case "ping":
			pingCount++
			// 收到心跳保活包，活跃超时已在行首重置(数据层不续——见 dataTimer)
			continue
		case "reset":
			dataTimer.Reset(dataTimeout)
			accumulated.Reset()
			contentChars = 0
			reasoningChars = 0
			continue
		case "chunk":
			dataTimer.Reset(dataTimeout)
			// reasoning=思考期增量(通用模型适配:活性信号,不混入正文)
			if event.Kind == "reasoning" {
				reasoningCount++
				reasoningChars += len(event.Delta)
				if progressCb != nil {
					progressCb(LlmStreamProgress{
						Stage:          "thinking",
						ReasoningChars: reasoningChars,
						ContentChars:   contentChars,
						ElapsedMs:      time.Since(streamStart).Milliseconds(),
					})
				}
			} else {
				contentCount++
				accumulated.WriteString(event.Delta)
				contentChars += len(event.Delta)
				if progressCb != nil {
					progressCb(LlmStreamProgress{
						Stage:          "generating",
						ReasoningChars: reasoningChars,
						ContentChars:   contentChars,
						ElapsedMs:      time.Since(streamStart).Milliseconds(),
					})
				}
			}
		case "done":
			dataTimer.Reset(dataTimeout)
			resText := event.Text
			if resText == "" {
				resText = accumulated.String()
			}
			finalResult = &LlmTextResult{
				Text:         resText,
				FinishReason: event.FinishReason,
				Usage:        event.Usage, // WP-J：usage 此前被丢弃，transcriptionTokens 恒 +0
				CallID:       callID,
			}
		case "error":
			status := mapLlmErrorCodeToStatus(event.Code)
			streamErr = &LlmGatewayError{
				Code:    event.Code,
				Message: event.Message,
				Status:  status,
			}
		default:
			unknownCount++
		}
	}

	if err := scanner.Err(); err != nil {
		var reason error
		if errors.Is(reqCtx.Err(), context.Canceled) && ctx.Err() == nil {
			reason = fmt.Errorf("llm-gateway: activity timeout exceeded (%v with no data; model-stall watchdog=%v)", timeout, dataTimeout)
		} else if ctx.Err() != nil {
			reason = fmt.Errorf("llm-gateway stream read error (caller ctx cut): %w", err)
		} else {
			reason = fmt.Errorf("llm-gateway stream read error: %w", err)
		}
		cancelReason = reason
		// 取消类切断（deadline/看门狗）且已有部分内容：残文随哨兵上抛供抢救
		if (errors.Is(reqCtx.Err(), context.Canceled) || ctx.Err() != nil) && accumulated.Len() > 0 {
			return LlmTextResult{Text: accumulated.String()}, fmt.Errorf("%w: %v", ErrStreamPartial, reason)
		}
		return LlmTextResult{}, reason
	}

	if streamErr != nil {
		cancelReason = streamErr
		return LlmTextResult{}, streamErr
	}
	if finalResult != nil {
		cancelReason = nil
		return *finalResult, nil
	}
	if errors.Is(reqCtx.Err(), context.Canceled) && ctx.Err() == nil {
		err := fmt.Errorf("llm-gateway: activity timeout exceeded (%v with no data)", timeout)
		cancelReason = err
		if accumulated.Len() > 0 {
			return LlmTextResult{Text: accumulated.String()}, fmt.Errorf("%w: %v", ErrStreamPartial, err)
		}
		return LlmTextResult{}, err
	}
	if ctx.Err() != nil {
		cancelReason = ctx.Err()
		if accumulated.Len() > 0 {
			return LlmTextResult{Text: accumulated.String()}, fmt.Errorf("%w: %v", ErrStreamPartial, ctx.Err())
		}
		return LlmTextResult{}, ctx.Err()
	}
	err = fmt.Errorf("llm-gateway: stream closed without done event")
	cancelReason = err
	return LlmTextResult{}, err
}

// Generate 执行一次 purpose 调用；object 为校验通过的 JSON（map/slice 标准类型）。
func (c *LlmGatewayClient) Generate(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
	body := map[string]any{
		"purpose":   purpose,
		"variables": variables,
	}
	if userId != nil {
		body["userId"] = *userId
	}
	status, raw, err := c.post(ctx, body, 16<<20)
	if err != nil {
		return err
	}

	var envelope struct {
		OK      bool            `json:"ok"`
		Object  json.RawMessage `json:"object"`
		Code    string          `json:"code"`
		Message string          `json:"message"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("llm-gateway: malformed response (HTTP %d): %w", status, err)
	}
	if !envelope.OK {
		return &LlmGatewayError{Code: envelope.Code, Message: envelope.Message, Status: status}
	}
	if out != nil {
		return json.Unmarshal(envelope.Object, out)
	}
	return nil
}
