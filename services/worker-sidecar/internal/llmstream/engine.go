package llmstream

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

const (
	DefaultActivityTimeout = 45 * time.Second
	DefaultPingInterval    = 10 * time.Second
)

type Engine struct {
	httpClient      *http.Client
	activityTimeout time.Duration
	pingInterval    time.Duration
}

func NewEngine(httpClient *http.Client) *Engine {
	if httpClient == nil {
		transport := &http.Transport{
			MaxIdleConns:        64,
			MaxIdleConnsPerHost: 32,
			IdleConnTimeout:     90 * time.Second,
		}
		httpClient = &http.Client{
			Transport: transport,
			Timeout:   0, // Request context and activity watchdog bound stream lifetime.
		}
	}
	return &Engine{
		httpClient:      httpClient,
		activityTimeout: DefaultActivityTimeout,
		pingInterval:    DefaultPingInterval,
	}
}

func (e *Engine) SetActivityTimeout(d time.Duration) {
	e.activityTimeout = d
}

func (e *Engine) SetPingInterval(d time.Duration) {
	e.pingInterval = d
}

func (e *Engine) Stream(ctx context.Context, req StreamRequest, encoder StreamEncoder) error {
	callID := req.CallID
	if callID == "" {
		callID = fmt.Sprintf("llm-%d", time.Now().UnixNano()%1000000)
	}

	if req.Model.APIKey == "" {
		_ = encoder.WriteError("MISSING_API_KEY", "API Key is required")
		return errors.New("missing api key")
	}
	if req.Model.ModelID == "" {
		_ = encoder.WriteError("INVALID_PARAM", "Model ID is required")
		return errors.New("missing model id")
	}

	upstreamReq, err := e.buildUpstreamRequest(ctx, req)
	if err != nil {
		_ = encoder.WriteError("REQUEST_BUILD_FAILED", err.Error())
		return err
	}

	startTime := time.Now()
	resp, err := e.httpClient.Do(upstreamReq)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil
		}
		_ = encoder.WriteError("UPSTREAM_UNREACHABLE", err.Error())
		return fmt.Errorf("upstream request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		rawBody, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		errMsg := fmt.Sprintf("upstream returned status %d: %s", resp.StatusCode, string(rawBody))
		_ = encoder.WriteError("UPSTREAM_ERROR", errMsg)
		return errors.New(errMsg)
	}

	activityCtx, cancelActivity := context.WithCancel(ctx)
	defer cancelActivity()

	watchdogTimer := time.AfterFunc(e.activityTimeout, func() {
		log.Printf("[llm-stream] ACTIVITY_TIMEOUT: call=%s no data for %v, aborting", callID, e.activityTimeout)
		cancelActivity()
	})
	defer watchdogTimer.Stop()

	resetWatchdog := func() {
		watchdogTimer.Reset(e.activityTimeout)
	}

	pingTicker := time.NewTicker(e.pingInterval)
	defer pingTicker.Stop()

	go func() {
		for {
			select {
			case <-activityCtx.Done():
				return
			case <-pingTicker.C:
				_ = encoder.WritePing()
			}
		}
	}()

	normalizer := NewStreamNormalizer(callID)
	reader := bufio.NewReader(resp.Body)
	isAnthropic := strings.ToLower(req.Model.APIFormat) == "anthropic"

	var currentEventType string
	var totalPromptTokens, totalCompTokens int
	var finishReason = "stop"
	// Summary ledger row must never report "success" after read error or activity timeout.
	outcome := "success"

	for {
		if activityCtx.Err() != nil {
			outcome = "cancelled"
			break
		}

		line, readErr := readCappedLine(reader, maxUpstreamLineBytes, callID)
		if len(line) > 0 {
			resetWatchdog()
			line = strings.TrimSpace(line)

			if strings.HasPrefix(line, "event:") {
				currentEventType = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
				continue
			}

			if strings.HasPrefix(line, "data:") {
				dataStr := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
				if dataStr == "[DONE]" {
					break
				}
				if dataStr == "" {
					continue
				}

				var part *NormalizedPart
				var parseErr error
				if isAnthropic {
					part, parseErr = normalizer.ParseAnthropicChunk(currentEventType, []byte(dataStr))
				} else {
					part, parseErr = normalizer.ParseOpenAIChunk([]byte(dataStr))
				}

				if parseErr == nil && part != nil {
					switch part.Kind {
					case "content":
						_ = encoder.WriteTextDelta(part.Text)
					case "reasoning":
						_ = encoder.WriteReasoningDelta(part.Text)
					case "tool_call":
						_ = encoder.WriteToolCall(part.ToolID, part.ToolName, part.ToolArgs)
					case "finish":
						if part.Finish != "" {
							finishReason = part.Finish
						}
						if part.PromptTok > 0 {
							totalPromptTokens = part.PromptTok
						}
						if part.CompTok > 0 {
							totalCompTokens = part.CompTok
						}
					}
				}
			}
		}

		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			if activityCtx.Err() != nil || errors.Is(readErr, context.Canceled) {
				outcome = "cancelled"
				break
			}
			log.Printf("[llm-stream] read error: call=%s err=%v", callID, readErr)
			outcome = "error"
			break
		}
	}

	usage := StreamUsage{
		PromptTokens:     totalPromptTokens,
		CompletionTokens: totalCompTokens,
		TotalTokens:      totalPromptTokens + totalCompTokens,
	}
	_ = encoder.WriteFinish(finishReason, usage)

	duration := time.Since(startTime)
	parts := normalizer.PartsHistogram()
	events := normalizer.EventsHistogram()

	log.Printf("[llm-stream] call=%s duration_ms=%d parts={content:%d,reasoning:%d,toolCall:%d,unknown:%d} events={content:%d,reasoning:%d,toolCall:%d} outcome=%s",
		callID, duration.Milliseconds(),
		parts.Content, parts.Reasoning, parts.ToolCall, parts.Unknown,
		events.ChunkContent, events.ChunkReasoning, events.ToolCall,
		outcome,
	)

	return nil
}

func (e *Engine) buildUpstreamRequest(ctx context.Context, req StreamRequest) (*http.Request, error) {
	isAnthropic := strings.ToLower(req.Model.APIFormat) == "anthropic"

	if isAnthropic {
		url := strings.TrimRight(req.Model.BaseURL, "/")
		if url == "" {
			url = "https://api.anthropic.com"
		}
		url += "/v1/messages"

		bodyMap := map[string]any{
			"model":      req.Model.ModelID,
			"messages":   req.Messages,
			"stream":     true,
			"max_tokens": 4096,
		}
		if req.System != "" {
			bodyMap["system"] = req.System
		}
		if req.Temperature != nil {
			bodyMap["temperature"] = *req.Temperature
		}
		if req.MaxTokens != nil {
			bodyMap["max_tokens"] = *req.MaxTokens
		}

		b, err := json.Marshal(bodyMap)
		if err != nil {
			return nil, err
		}

		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
		if err != nil {
			return nil, err
		}
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("x-api-key", req.Model.APIKey)
		httpReq.Header.Set("anthropic-version", "2023-06-01")
		return httpReq, nil
	}

	baseURL := strings.TrimRight(req.Model.BaseURL, "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	url := baseURL
	if !strings.HasSuffix(url, "/chat/completions") {
		url += "/chat/completions"
	}

	messages := make([]map[string]any, 0, len(req.Messages)+1)
	if req.System != "" {
		messages = append(messages, map[string]any{
			"role":    "system",
			"content": req.System,
		})
	}
	for _, m := range req.Messages {
		msgMap := map[string]any{
			"role":    m.Role,
			"content": m.Content,
		}
		if m.Name != "" {
			msgMap["name"] = m.Name
		}
		if m.ToolCallID != "" {
			msgMap["tool_call_id"] = m.ToolCallID
		}
		messages = append(messages, msgMap)
	}

	bodyMap := map[string]any{
		"model":          req.Model.ModelID,
		"messages":       messages,
		"stream":         true,
		"stream_options": map[string]any{"include_usage": true},
	}
	if req.Temperature != nil {
		bodyMap["temperature"] = *req.Temperature
	}
	if req.MaxTokens != nil {
		bodyMap["max_tokens"] = *req.MaxTokens
	}
	if len(req.Tools) > 0 {
		bodyMap["tools"] = req.Tools
	}

	b, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+req.Model.APIKey)
	return httpReq, nil
}
