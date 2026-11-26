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
	"unicode/utf8"
)

type LlmCompleter interface {
	Complete(ctx context.Context, purpose string, variables map[string]any, userId *string) (LlmTextResult, error)
}

type LlmStreamProgress struct {
	Stage          string
	ReasoningChars int
	ContentChars   int
	ElapsedMs      int64
}

type streamProgressKey struct{}

type StreamProgressCallback func(LlmStreamProgress)

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
	baseURL         string
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
			Timeout:   0,
		},
	}
}

func (c *LlmGatewayClient) SetActivityTimeout(d time.Duration) {
	c.activityTimeout = d
}

const (
	ErrCodeUnknownPurpose        = "UNKNOWN_PURPOSE"
	ErrCodeMissingApiKey         = "MISSING_API_KEY"
	ErrCodeKeyDecryptFailed      = "KEY_DECRYPT_FAILED"
	ErrCodeBudgetExceeded        = "BUDGET_EXCEEDED"
	ErrCodeGenerationFailed      = "GENERATION_FAILED"
	ErrCodeRateLimited           = "RATE_LIMITED"
	ErrCodeUpstreamAuthError     = "UPSTREAM_AUTH_ERROR"
	ErrCodeUpstreamQuotaExceeded = "UPSTREAM_QUOTA_EXCEEDED"
	ErrCodeUpstreamModelNotFound = "UPSTREAM_MODEL_NOT_FOUND"
	ErrCodeUpstreamBadRequest    = "UPSTREAM_BAD_REQUEST"
	ErrCodeUpstreamServerError   = "UPSTREAM_SERVER_ERROR"
	ErrCodeUpstreamNetworkError  = "UPSTREAM_NETWORK_ERROR"
)

const (
	DefaultLlmRetryInitialBackoff = 500 * time.Millisecond
	DefaultLlmRetryMaxBackoff     = 8 * time.Second
	DefaultLlmRetryMaxAttempts    = 3
)

// Returned only on context/watchdog cancellation after partial chunks so callers can salvage valid prefixes.
var ErrStreamPartial = errors.New("llm-gateway: stream cut before completion (partial content in Text)")

const (
	// Resets on any line (including ping) to span >120s pre-first-chunk thinking pauses.
	DefaultLlmActivityTimeout = 180 * time.Second
	// Resets only on chunk/done because heartbeat pings keep connections alive even when provider streams stall.
	DefaultLlmDataTimeout = 240 * time.Second
)

type LlmGatewayError struct {
	Code           string
	Message        string
	Status         int
	Provider       string
	Model          string
	UpstreamStatus int
	UpstreamCode   string
}

func (e *LlmGatewayError) Error() string {
	return fmt.Sprintf("llm-gateway %s: %s", e.Code, e.Message)
}

func (e *LlmGatewayError) IsUnknownPurpose() bool { return e.Code == ErrCodeUnknownPurpose }

func (e *LlmGatewayError) IsBudgetExceeded() bool { return e.Code == ErrCodeBudgetExceeded }

func (e *LlmGatewayError) IsMissingApiKey() bool { return e.Code == ErrCodeMissingApiKey }

// Separate decrypt failures from missing keys so key-rotation issues are not misreported as unconfigured BYOK.
func (e *LlmGatewayError) IsKeyDecryptFailed() bool { return e.Code == ErrCodeKeyDecryptFailed }

func (e *LlmGatewayError) IsUpstreamAuthError() bool { return e.Code == ErrCodeUpstreamAuthError }

func (e *LlmGatewayError) IsUpstreamQuotaExceeded() bool {
	return e.Code == ErrCodeUpstreamQuotaExceeded
}

func (e *LlmGatewayError) IsUpstreamModelNotFound() bool {
	return e.Code == ErrCodeUpstreamModelNotFound
}

func (e *LlmGatewayError) IsUpstreamBadRequest() bool { return e.Code == ErrCodeUpstreamBadRequest }

func (e *LlmGatewayError) IsPermanentUpstreamError() bool {
	return e.IsMissingApiKey() || e.IsKeyDecryptFailed() || e.IsBudgetExceeded() ||
		e.IsUnknownPurpose() || e.IsUpstreamAuthError() || e.IsUpstreamQuotaExceeded() ||
		e.IsUpstreamModelNotFound() || e.IsUpstreamBadRequest()
}

func (e *LlmGatewayError) IsGenerationFailed() bool { return e.Code == ErrCodeGenerationFailed }

func (e *LlmGatewayError) IsRateLimited() bool {
	if e.IsBudgetExceeded() || e.IsMissingApiKey() || e.IsKeyDecryptFailed() ||
		e.IsUpstreamAuthError() || e.IsUpstreamQuotaExceeded() || e.IsUpstreamModelNotFound() || e.IsUpstreamBadRequest() {
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

func (e *LlmGatewayError) IsTransient() bool {
	if e.IsPermanentUpstreamError() {
		return false
	}
	if e.Code == ErrCodeUpstreamServerError || e.Code == ErrCodeUpstreamNetworkError {
		return true
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

func MapLlmErrorCodeToStatus(code string) int {
	switch code {
	case ErrCodeBudgetExceeded, ErrCodeRateLimited:
		return 429
	case ErrCodeMissingApiKey, ErrCodeKeyDecryptFailed:
		return 409
	case ErrCodeUnknownPurpose, ErrCodeUpstreamBadRequest:
		return 400
	case ErrCodeUpstreamAuthError:
		return 401
	case ErrCodeUpstreamQuotaExceeded:
		return 402
	case ErrCodeUpstreamModelNotFound:
		return 404
	case ErrCodeGenerationFailed, ErrCodeUpstreamServerError, ErrCodeUpstreamNetworkError:
		return 502
	default:
		return 500
	}
}

const (
	StructuredDbErrPrefix = "__OG_ERR__:"
	MaxStructuredDbErrLen = 500
)

type StructuredErrorPayload struct {
	Code           string `json:"code,omitempty"`
	Provider       string `json:"provider,omitempty"`
	Model          string `json:"model,omitempty"`
	UpstreamStatus int    `json:"upstreamStatus,omitempty"`
	UpstreamCode   string `json:"upstreamCode,omitempty"`
	Message        string `json:"message,omitempty"`
}

func IsPermanentTerminalErrorCode(code string) bool {
	switch strings.TrimSpace(code) {
	case ErrCodeMissingApiKey,
		ErrCodeKeyDecryptFailed,
		ErrCodeUnknownPurpose,
		ErrCodeUpstreamAuthError,
		ErrCodeUpstreamQuotaExceeded,
		ErrCodeUpstreamModelNotFound,
		ErrCodeUpstreamBadRequest:
		return true
	default:
		return false
	}
}

func marshalCompactJSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "{}"
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

func buildStructuredDbPayload(meta StructuredErrorPayload, msg string, includeOptional bool) StructuredErrorPayload {
	out := StructuredErrorPayload{
		Code:    strings.TrimSpace(meta.Code),
		Message: strings.TrimSpace(msg),
	}
	if includeOptional {
		out.Provider = strings.TrimSpace(meta.Provider)
		out.Model = strings.TrimSpace(meta.Model)
		if meta.UpstreamStatus > 0 {
			out.UpstreamStatus = meta.UpstreamStatus
		}
		out.UpstreamCode = strings.TrimSpace(meta.UpstreamCode)
	}
	return out
}

func EncodeStructuredDbError(gw *LlmGatewayError, maxLen int) string {
	if gw == nil {
		return ""
	}
	return EncodeStructuredDbErrorFromMeta(StructuredErrorPayload{
		Code:           gw.Code,
		Provider:       gw.Provider,
		Model:          gw.Model,
		UpstreamStatus: gw.UpstreamStatus,
		UpstreamCode:   gw.UpstreamCode,
		Message:        gw.Message,
	}, maxLen)
}

// Binary-search message truncation by runes before marshaling so __OG_ERR__ stays within maxLen valid JSON.
func EncodeStructuredDbErrorFromMeta(meta StructuredErrorPayload, maxLen int) string {
	if maxLen <= 0 {
		maxLen = MaxStructuredDbErrLen
	}
	rawMsg := strings.TrimSpace(meta.Message)
	full := StructuredDbErrPrefix + marshalCompactJSON(buildStructuredDbPayload(meta, rawMsg, true))
	if len(full) <= maxLen {
		return full
	}

	if rawMsg != "" {
		runes := []rune(rawMsg)
		lo, hi := 0, len(runes)
		best := StructuredDbErrPrefix + marshalCompactJSON(buildStructuredDbPayload(meta, "", true))
		for lo <= hi {
			mid := (lo + hi) / 2
			candidateMsg := ""
			if mid > 0 && mid < len(runes) {
				candidateMsg = string(runes[:mid]) + "..."
			} else if mid == len(runes) {
				candidateMsg = rawMsg
			}
			candidate := StructuredDbErrPrefix + marshalCompactJSON(buildStructuredDbPayload(meta, candidateMsg, true))
			if len(candidate) <= maxLen && utf8.RuneCountInString(candidate) <= maxLen {
				best = candidate
				lo = mid + 1
			} else {
				hi = mid - 1
			}
		}
		if len(best) <= maxLen {
			return best
		}
	}

	minimal := StructuredDbErrPrefix + marshalCompactJSON(buildStructuredDbPayload(meta, "", false))
	if len(minimal) <= maxLen {
		return minimal
	}
	return StructuredDbErrPrefix + "{}"
}

func DecodeStructuredDbError(raw string) (*StructuredErrorPayload, bool) {
	trimmed := strings.TrimSpace(raw)
	idx := strings.Index(trimmed, StructuredDbErrPrefix)
	if idx == -1 {
		return nil, false
	}
	jsonPart := strings.TrimSpace(trimmed[idx+len(StructuredDbErrPrefix):])
	if !strings.HasPrefix(jsonPart, "{") {
		return nil, false
	}
	var parsed struct {
		Code            string `json:"code"`
		Provider        string `json:"provider"`
		Model           string `json:"model"`
		UpstreamStatus  int    `json:"upstreamStatus"`
		UpstreamCode    string `json:"upstreamCode"`
		Message         string `json:"message"`
		UpstreamMessage string `json:"upstreamMessage"`
	}
	if err := json.Unmarshal([]byte(jsonPart), &parsed); err != nil {
		return nil, false
	}
	msg := strings.TrimSpace(parsed.UpstreamMessage)
	if msg == "" {
		msg = strings.TrimSpace(parsed.Message)
	}
	out := &StructuredErrorPayload{
		Code:           strings.TrimSpace(parsed.Code),
		Provider:       strings.TrimSpace(parsed.Provider),
		Model:          strings.TrimSpace(parsed.Model),
		UpstreamStatus: parsed.UpstreamStatus,
		UpstreamCode:   strings.TrimSpace(parsed.UpstreamCode),
		Message:        msg,
	}
	if out.Code == "" && out.Provider == "" && out.Model == "" && out.UpstreamStatus == 0 && out.UpstreamCode == "" && out.Message == "" {
		return nil, false
	}
	return out, true
}

func FormatGatewaySSEErrorPayload(prefix string, err error) (map[string]any, bool) {
	if err == nil {
		return nil, false
	}
	var gw *LlmGatewayError
	if !errors.As(err, &gw) || gw == nil {
		return nil, false
	}
	status := gw.Status
	if status == 0 {
		status = MapLlmErrorCodeToStatus(gw.Code)
	}
	displayMsg := gw.Message
	if displayMsg == "" {
		displayMsg = gw.Code
	}
	if prefix != "" {
		displayMsg = prefix + displayMsg
	}
	payload := map[string]any{
		"message": displayMsg,
		"status":  status,
	}
	if gw.Code != "" {
		payload["code"] = gw.Code
	}
	if gw.Message != "" {
		payload["upstreamMessage"] = gw.Message
	}
	if gw.Provider != "" {
		payload["provider"] = gw.Provider
	}
	if gw.Model != "" {
		payload["model"] = gw.Model
	}
	if gw.UpstreamStatus > 0 {
		payload["upstreamStatus"] = gw.UpstreamStatus
	}
	if gw.UpstreamCode != "" {
		payload["upstreamCode"] = gw.UpstreamCode
	}
	return payload, true
}

type LlmUsage struct {
	PromptTokens     int `json:"promptTokens"`
	CompletionTokens int `json:"completionTokens"`
	TotalTokens      int `json:"totalTokens"`
}

type LlmTextResult struct {
	Text         string
	FinishReason string
	Usage        LlmUsage
	CallID       string
	BriefState   string
}

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

	timer := time.AfterFunc(timeout, func() {
		cancel()
	})
	defer timer.Stop()
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

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		var errEnvelope struct {
			OK             bool   `json:"ok"`
			Code           string `json:"code"`
			Message        string `json:"message"`
			Provider       string `json:"provider"`
			Model          string `json:"model"`
			UpstreamStatus int    `json:"upstreamStatus"`
			UpstreamCode   string `json:"upstreamCode"`
		}
		if jsonErr := json.Unmarshal(raw, &errEnvelope); jsonErr == nil && errEnvelope.Code != "" {
			return LlmTextResult{}, &LlmGatewayError{
				Code:           errEnvelope.Code,
				Message:        errEnvelope.Message,
				Status:         resp.StatusCode,
				Provider:       errEnvelope.Provider,
				Model:          errEnvelope.Model,
				UpstreamStatus: errEnvelope.UpstreamStatus,
				UpstreamCode:   errEnvelope.UpstreamCode,
			}
		}
		return LlmTextResult{}, fmt.Errorf("llm-gateway: HTTP %d: %s", resp.StatusCode, string(raw))
	}

	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(contentType, "application/x-ndjson") {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		var envelope struct {
			OK             bool     `json:"ok"`
			Text           string   `json:"text"`
			FinishReason   string   `json:"finishReason"`
			BriefState     string   `json:"briefState"`
			Code           string   `json:"code"`
			Message        string   `json:"message"`
			Provider       string   `json:"provider"`
			Model          string   `json:"model"`
			UpstreamStatus int      `json:"upstreamStatus"`
			UpstreamCode   string   `json:"upstreamCode"`
			Usage          LlmUsage `json:"usage"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			return LlmTextResult{}, fmt.Errorf("llm-gateway: malformed response (HTTP %d): %w", resp.StatusCode, err)
		}
		if !envelope.OK {
			status := MapLlmErrorCodeToStatus(envelope.Code)
			return LlmTextResult{}, &LlmGatewayError{
				Code:           envelope.Code,
				Message:        envelope.Message,
				Status:         status,
				Provider:       envelope.Provider,
				Model:          envelope.Model,
				UpstreamStatus: envelope.UpstreamStatus,
				UpstreamCode:   envelope.UpstreamCode,
			}
		}
		if cb := getStreamProgress(ctx); cb != nil {
			cb(LlmStreamProgress{
				Stage:        "generating",
				ContentChars: len(envelope.Text),
				ElapsedMs:    time.Since(streamStart).Milliseconds(),
			})
		}
		return LlmTextResult{Text: envelope.Text, FinishReason: envelope.FinishReason, Usage: envelope.Usage, CallID: resp.Header.Get("x-llm-call-id"), BriefState: envelope.BriefState}, nil
	}

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
			Type           string   `json:"type"`
			Delta          string   `json:"delta"`
			Kind           string   `json:"kind"`
			OK             *bool    `json:"ok"`
			Text           string   `json:"text"`
			FinishReason   string   `json:"finishReason"`
			BriefState     string   `json:"briefState"`
			Code           string   `json:"code"`
			Message        string   `json:"message"`
			Provider       string   `json:"provider"`
			Model          string   `json:"model"`
			UpstreamStatus int      `json:"upstreamStatus"`
			UpstreamCode   string   `json:"upstreamCode"`
			Usage          LlmUsage `json:"usage"`
		}
		if err := json.Unmarshal(line, &event); err != nil {
			unknownCount++
			continue
		}

		switch event.Type {
		case "ping":
			pingCount++
			continue
		case "reset":
			dataTimer.Reset(dataTimeout)
			accumulated.Reset()
			contentChars = 0
			reasoningChars = 0
			continue
		case "chunk":
			dataTimer.Reset(dataTimeout)
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
				Usage:        event.Usage,
				CallID:       callID,
				BriefState:   event.BriefState,
			}
		case "error":
			status := MapLlmErrorCodeToStatus(event.Code)
			streamErr = &LlmGatewayError{
				Code:           event.Code,
				Message:        event.Message,
				Status:         status,
				Provider:       event.Provider,
				Model:          event.Model,
				UpstreamStatus: event.UpstreamStatus,
				UpstreamCode:   event.UpstreamCode,
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
		OK             bool            `json:"ok"`
		Object         json.RawMessage `json:"object"`
		Code           string          `json:"code"`
		Message        string          `json:"message"`
		Provider       string          `json:"provider"`
		Model          string          `json:"model"`
		UpstreamStatus int             `json:"upstreamStatus"`
		UpstreamCode   string          `json:"upstreamCode"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("llm-gateway: malformed response (HTTP %d): %w", status, err)
	}
	if !envelope.OK {
		return &LlmGatewayError{
			Code:           envelope.Code,
			Message:        envelope.Message,
			Status:         status,
			Provider:       envelope.Provider,
			Model:          envelope.Model,
			UpstreamStatus: envelope.UpstreamStatus,
			UpstreamCode:   envelope.UpstreamCode,
		}
	}
	if out != nil {
		return json.Unmarshal(envelope.Object, out)
	}
	return nil
}
