package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLlmGatewayClientSuccess(t *testing.T) {
	tests := []struct {
		name       string
		token      string
		purpose    string
		userId     string
		rawPayload string
	}{
		{
			name:       "🧪 [11.7.1.1] [11.7.2.1] [11.7.4.1] mcp concept edges generation with auth header and body schema",
			token:      "tok",
			purpose:    "mcp_concept_edges",
			userId:     "u1",
			rawPayload: `{"ok":true,"object":{"edges":[{"fromConcept":"a"}]},"mode":"json_schema"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotAuth, gotBody string
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotAuth = r.Header.Get("x-internal-token")
				bodyBytes, _ := io.ReadAll(r.Body)
				gotBody = string(bodyBytes)
				_, _ = w.Write([]byte(tt.rawPayload))
			}))
			defer ts.Close()

			c := NewLlmGatewayClient(ts.URL, tt.token)
			uid := tt.userId
			var out struct {
				Edges []struct {
					FromConcept string `json:"fromConcept"`
				} `json:"edges"`
			}
			err := c.Generate(context.Background(), tt.purpose, map[string]any{"x": 1}, &uid, &out)
			require.NoError(t, err)

			assert.Equal(t, tt.token, gotAuth, "internal token must match")
			assert.Contains(t, gotBody, `"purpose":"`+tt.purpose+`"`)
			assert.Contains(t, gotBody, `"userId":"`+tt.userId+`"`)

			require.Len(t, out.Edges, 1)
			assert.Equal(t, "a", out.Edges[0].FromConcept)
		})
	}
}

func TestLlmGatewayClientErrorCodeContract(t *testing.T) {
	tests := []struct {
		name                 string
		status               int
		payload              string
		expectedCode         string
		wantBudgetExceeded   bool
		wantMissingApiKey    bool
		wantUnknownPurpose   bool
		wantGenerationFailed bool
	}{
		{
			name:                 "🧪 [11.7.3.1] budget exceeded 429",
			status:               429,
			payload:              `{"ok":false,"code":"BUDGET_EXCEEDED","message":"over"}`,
			expectedCode:         ErrCodeBudgetExceeded,
			wantBudgetExceeded:   true,
			wantMissingApiKey:    false,
			wantUnknownPurpose:   false,
			wantGenerationFailed: false,
		},
		{
			name:                 "🧪 [11.7.3.1] missing api key 409",
			status:               409,
			payload:              `{"ok":false,"code":"MISSING_API_KEY","message":"no key"}`,
			expectedCode:         ErrCodeMissingApiKey,
			wantBudgetExceeded:   false,
			wantMissingApiKey:    true,
			wantUnknownPurpose:   false,
			wantGenerationFailed: false,
		},
		{
			name:                 "🧪 [11.7.3.2] generation failed 502",
			status:               502,
			payload:              `{"ok":false,"code":"GENERATION_FAILED","message":"boom"}`,
			expectedCode:         ErrCodeGenerationFailed,
			wantBudgetExceeded:   false,
			wantMissingApiKey:    false,
			wantUnknownPurpose:   false,
			wantGenerationFailed: true,
		},
		{
			name:                 "🧪 [11.7.2.2] unknown purpose 400",
			status:               400,
			payload:              `{"ok":false,"code":"UNKNOWN_PURPOSE","message":"?"}`,
			expectedCode:         ErrCodeUnknownPurpose,
			wantBudgetExceeded:   false,
			wantMissingApiKey:    false,
			wantUnknownPurpose:   true,
			wantGenerationFailed: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.payload))
			}))
			defer ts.Close()

			c := NewLlmGatewayClient(ts.URL, "tok")
			err := c.Generate(context.Background(), "p", nil, nil, nil)
			require.Error(t, err)

			gwErr, ok := err.(*LlmGatewayError)
			require.True(t, ok, "expected *LlmGatewayError")
			assert.Equal(t, tt.expectedCode, gwErr.Code)
			assert.Equal(t, tt.status, gwErr.Status)
			assert.Equal(t, tt.wantBudgetExceeded, gwErr.IsBudgetExceeded())
			assert.Equal(t, tt.wantMissingApiKey, gwErr.IsMissingApiKey())
			assert.Equal(t, tt.wantUnknownPurpose, gwErr.IsUnknownPurpose())
			assert.Equal(t, tt.wantGenerationFailed, gwErr.IsGenerationFailed())
		})
	}
}

func TestLlmGatewayClientRetryContract(t *testing.T) {
	assert.Equal(t, 500*time.Millisecond, DefaultLlmRetryInitialBackoff)
	assert.Equal(t, 8*time.Second, DefaultLlmRetryMaxBackoff)
	assert.Equal(t, 3, DefaultLlmRetryMaxAttempts)
	assert.True(t, DefaultLlmRetryInitialBackoff < DefaultLlmRetryMaxBackoff)
}

func TestLlmGatewayClient_Complete_StreamSuccess(t *testing.T) {
	tests := []struct {
		name       string
		events     []string
		wantText   string
		wantReason string
	}{
		{
			name: "🧪 [11.7.2.3] NDJSON stream with ping, chunks, and done",
			events: []string{
				`{"type":"ping"}`,
				`{"type":"chunk","delta":"Hello, "}`,
				`{"type":"ping"}`,
				`{"type":"chunk","delta":"world!"}`,
				`{"type":"done","ok":true,"text":"Hello, world!","finishReason":"stop"}`,
			},
			wantText:   "Hello, world!",
			wantReason: "stop",
		},
		{
			name: "NDJSON stream with chunk accumulation fallback when done.text is empty",
			events: []string{
				`{"type":"chunk","delta":"part 1 - "}`,
				`{"type":"chunk","delta":"part 2"}`,
				`{"type":"done","ok":true,"text":"","finishReason":"length"}`,
			},
			wantText:   "part 1 - part 2",
			wantReason: "length",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotStreamMode, gotAccept, gotToken string
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotStreamMode = r.Header.Get("x-stream-mode")
				gotAccept = r.Header.Get("Accept")
				gotToken = r.Header.Get("x-internal-token")

				w.Header().Set("Content-Type", "application/x-ndjson")
				w.WriteHeader(http.StatusOK)
				flusher, _ := w.(http.Flusher)
				for _, ev := range tt.events {
					_, _ = w.Write([]byte(ev + "\n"))
					if flusher != nil {
						flusher.Flush()
					}
				}
			}))
			defer ts.Close()

			c := NewLlmGatewayClient(ts.URL, "secret-tok")
			res, err := c.Complete(context.Background(), "doc_transcribe_enhance_localize", map[string]any{"content": "abc"}, nil)
			require.NoError(t, err)

			assert.Equal(t, "1", gotStreamMode)
			assert.Equal(t, "application/x-ndjson", gotAccept)
			assert.Equal(t, "secret-tok", gotToken)
			assert.Equal(t, tt.wantText, res.Text)
			assert.Equal(t, tt.wantReason, res.FinishReason)
		})
	}
}

func TestLlmGatewayClient_Complete_StreamErrors(t *testing.T) {
	tests := []struct {
		name               string
		events             []string
		expectedCode       string
		expectedStatus     int
		wantBudgetExceeded bool
		wantMissingApiKey  bool
		wantGenFailed      bool
	}{
		{
			name: "stream error BUDGET_EXCEEDED maps to 429",
			events: []string{
				`{"type":"ping"}`,
				`{"type":"error","ok":false,"code":"BUDGET_EXCEEDED","message":"quota hit"}`,
			},
			expectedCode:       ErrCodeBudgetExceeded,
			expectedStatus:     429,
			wantBudgetExceeded: true,
		},
		{
			name: "stream error MISSING_API_KEY maps to 409",
			events: []string{
				`{"type":"error","ok":false,"code":"MISSING_API_KEY","message":"key missing"}`,
			},
			expectedCode:      ErrCodeMissingApiKey,
			expectedStatus:    409,
			wantMissingApiKey: true,
		},
		{
			name: "stream error GENERATION_FAILED maps to 502",
			events: []string{
				`{"type":"error","ok":false,"code":"GENERATION_FAILED","message":"model error"}`,
			},
			expectedCode:   ErrCodeGenerationFailed,
			expectedStatus: 502,
			wantGenFailed:  true,
		},
		{
			name: "stream error UNKNOWN_PURPOSE maps to 400",
			events: []string{
				`{"type":"error","ok":false,"code":"UNKNOWN_PURPOSE","message":"purpose not registered"}`,
			},
			expectedCode:   ErrCodeUnknownPurpose,
			expectedStatus: 400,
		},
		{
			name: "stream error RATE_LIMITED maps to 429",
			events: []string{
				`{"type":"error","ok":false,"code":"RATE_LIMITED","message":"rate limit exceeded"}`,
			},
			expectedCode:   ErrCodeRateLimited,
			expectedStatus: 429,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/x-ndjson")
				w.WriteHeader(http.StatusOK)
				for _, ev := range tt.events {
					_, _ = w.Write([]byte(ev + "\n"))
				}
			}))
			defer ts.Close()

			c := NewLlmGatewayClient(ts.URL, "tok")
			_, err := c.Complete(context.Background(), "doc_transcribe_enhance_localize", nil, nil)
			require.Error(t, err)

			gwErr, ok := err.(*LlmGatewayError)
			require.True(t, ok)
			assert.Equal(t, tt.expectedCode, gwErr.Code)
			assert.Equal(t, tt.expectedStatus, gwErr.Status)
			assert.Equal(t, tt.wantBudgetExceeded, gwErr.IsBudgetExceeded())
			assert.Equal(t, tt.wantMissingApiKey, gwErr.IsMissingApiKey())
			assert.Equal(t, tt.wantGenFailed, gwErr.IsGenerationFailed())
			if tt.expectedCode == ErrCodeRateLimited {
				assert.True(t, gwErr.IsRateLimited())
			}
		})
	}
}

func TestLlmGatewayError_IsRateLimited_Chinese(t *testing.T) {
	tests := []struct {
		name string
		err  *LlmGatewayError
		want bool
	}{
		{
			name: "速率限制",
			err:  &LlmGatewayError{Code: "GENERATION_FAILED", Message: "您的调用已触发服务商速率限制，请稍后重试"},
			want: true,
		},
		{
			name: "请求频率",
			err:  &LlmGatewayError{Code: "GENERATION_FAILED", Message: "请求频率超限，并发数超过限制"},
			want: true,
		},
		{
			name: "并发超限",
			err:  &LlmGatewayError{Code: "GENERATION_FAILED", Message: "并发超限，请降低并发"},
			want: true,
		},
		{
			name: "429 纯数字",
			err:  &LlmGatewayError{Code: "GENERATION_FAILED", Message: "HTTP 429 Too Many Requests"},
			want: true,
		},
		{
			name: "BUDGET_EXCEEDED 排除",
			err:  &LlmGatewayError{Code: ErrCodeBudgetExceeded, Status: 429, Message: "budget exceeded"},
			want: false,
		},
		{
			name: "普通生成失败",
			err:  &LlmGatewayError{Code: ErrCodeGenerationFailed, Status: 502, Message: "internal model error"},
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, tt.err.IsRateLimited())
		})
	}
}

func TestLlmGatewayClient_Complete_UnaryFallback(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"text":"unary result","finishReason":"stop"}`))
	}))
	defer ts.Close()

	c := NewLlmGatewayClient(ts.URL, "tok")
	res, err := c.Complete(context.Background(), "doc_transcribe_enhance_localize", nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "unary result", res.Text)
	assert.Equal(t, "stop", res.FinishReason)
}

func TestLlmGatewayClient_TransportPool(t *testing.T) {
	c := NewLlmGatewayClient("http://localhost:3000", "tok")
	transport, ok := c.http.Transport.(*http.Transport)
	require.True(t, ok, "expected *http.Transport")
	assert.Equal(t, 32, transport.MaxIdleConns)
	assert.Equal(t, 16, transport.MaxIdleConnsPerHost)
	assert.Equal(t, 90*time.Second, transport.IdleConnTimeout)
}

func TestLlmGatewayClient_Complete_ActivityTimeout(t *testing.T) {
	tests := []struct {
		name         string
		stalled      bool
		withPings    bool
		timeout      time.Duration
		wantErr      bool
		errSubstring string
	}{
		{
			name:         "server stalls mid-stream without ping triggers activity timeout",
			stalled:      true,
			withPings:    false,
			timeout:      50 * time.Millisecond,
			wantErr:      true,
			errSubstring: "activity timeout exceeded",
		},
		{
			name:      "server sends periodic pings refreshing activity watchdog to completion",
			stalled:   false,
			withPings: true,
			timeout:   60 * time.Millisecond,
			wantErr:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/x-ndjson")
				w.WriteHeader(http.StatusOK)
				flusher, _ := w.(http.Flusher)

				_, _ = w.Write([]byte(`{"type":"chunk","delta":"start"}` + "\n"))
				if flusher != nil {
					flusher.Flush()
				}

				if tt.stalled {
					time.Sleep(120 * time.Millisecond)
					_, _ = w.Write([]byte(`{"type":"done","ok":true,"text":"stalled","finishReason":"stop"}` + "\n"))
					if flusher != nil {
						flusher.Flush()
					}
					return
				}

				if tt.withPings {
					for i := 0; i < 3; i++ {
						time.Sleep(25 * time.Millisecond)
						_, _ = w.Write([]byte(`{"type":"ping"}` + "\n"))
						if flusher != nil {
							flusher.Flush()
						}
					}
					_, _ = w.Write([]byte(`{"type":"done","ok":true,"text":"start done","finishReason":"stop"}` + "\n"))
					if flusher != nil {
						flusher.Flush()
					}
				}
			}))
			defer ts.Close()

			c := NewLlmGatewayClient(ts.URL, "tok")
			c.SetActivityTimeout(tt.timeout)

			res, err := c.Complete(context.Background(), "doc_transcribe_enhance_localize", nil, nil)
			if tt.wantErr {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.errSubstring)
			} else {
				require.NoError(t, err)
				assert.Equal(t, "start done", res.Text)
			}
		})
	}
}

func TestLlmGatewayClient_Complete_ModelStallWatchdog(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)

		for i := 0; i < 6; i++ {
			time.Sleep(20 * time.Millisecond)
			_, _ = w.Write([]byte(`{"type":"ping"}` + "\n"))
			if flusher != nil {
				flusher.Flush()
			}
		}
		_, _ = w.Write([]byte(`{"type":"done","ok":true,"text":"never reached","finishReason":"stop"}` + "\n"))
	}))
	defer ts.Close()

	c := NewLlmGatewayClient(ts.URL, "tok")
	c.SetActivityTimeout(35 * time.Millisecond)

	_, err := c.Complete(context.Background(), "doc_transcribe_enhance_localize", nil, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "activity timeout exceeded")
	assert.Contains(t, err.Error(), "model-stall watchdog")
}

func TestLlmGatewayClient_Complete_ConcurrentPool(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		_, _ = w.Write([]byte(`{"type":"ping"}` + "\n"))
		_, _ = w.Write([]byte(`{"type":"chunk","delta":"concurrent chunk"}` + "\n"))
		_, _ = w.Write([]byte(`{"type":"done","ok":true,"text":"concurrent chunk","finishReason":"stop"}` + "\n"))
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer ts.Close()

	c := NewLlmGatewayClient(ts.URL, "tok")

	const concurrency = 10
	errCh := make(chan error, concurrency)

	for i := 0; i < concurrency; i++ {
		go func() {
			res, err := c.Complete(context.Background(), "doc_transcribe_enhance_localize", nil, nil)
			if err != nil {
				errCh <- err
				return
			}
			if res.Text != "concurrent chunk" {
				errCh <- fmt.Errorf("unexpected text: %s", res.Text)
				return
			}
			errCh <- nil
		}()
	}

	for i := 0; i < concurrency; i++ {
		err := <-errCh
		require.NoError(t, err)
	}
}

func TestLlmGatewayClientStreamReasoningKind(t *testing.T) {
	tests := []struct {
		name    string
		ndjson  string
		wantTxt string
	}{
		{
			name: "reasoning 与 content 混排:正文只归集 content",
			ndjson: `{"type":"ping"}` + "\n" +
				`{"type":"chunk","kind":"reasoning","delta":"思考…"}` + "\n" +
				`{"type":"chunk","kind":"content","delta":"正文A"}` + "\n" +
				`{"type":"chunk","kind":"reasoning","delta":"再思考"}` + "\n" +
				`{"type":"chunk","delta":"正文B"}` + "\n" +
				`{"type":"done","ok":true,"text":"","finishReason":"stop","usage":{"totalTokens":9}}`,
			wantTxt: "正文A正文B",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/x-ndjson")
				_, _ = w.Write([]byte(tt.ndjson))
			}))
			defer ts.Close()
			c := NewLlmGatewayClient(ts.URL, "tok")
			res, err := c.Complete(context.Background(), "doc_enhance", map[string]any{"x": 1}, nil)
			require.NoError(t, err)
			assert.Equal(t, tt.wantTxt, res.Text, "reasoning 不得混入正文")
		})
	}
}

func TestLlmGatewayClient_Complete_CallIDAndSummaryLedger(t *testing.T) {
	tests := []struct {
		name              string
		callID            string
		ndjson            string
		timeout           time.Duration
		expectErr         bool
		wantCallID        string
		wantLogSubstrings []string
	}{
		{
			name:   "stream success ledger and callId propagation",
			callID: "call-test-123",
			ndjson: `{"type":"ping"}` + "\n" +
				`{"type":"chunk","kind":"reasoning","delta":"thinking"}` + "\n" +
				`{"type":"chunk","kind":"content","delta":"hello "}` + "\n" +
				`{"type":"chunk","delta":"world"}` + "\n" +
				`{"type":"something_else","ignored":true}` + "\n" +
				`{"type":"done","ok":true,"text":"hello world","finishReason":"stop"}`,
			expectErr:  false,
			wantCallID: "call-test-123",
			wantLogSubstrings: []string{
				"[llm-stream-client] call=call-test-123",
				"lines=6",
				"kinds={content:2,reasoning:1}",
				"pings=1",
				"cancel_reason=<nil>",
				"total_ms=",
			},
		},
		{
			name:   "stream error ledger records failure cancel_reason",
			callID: "call-err-456",
			ndjson: `{"type":"chunk","kind":"reasoning","delta":"thinking"}` + "\n" +
				`{"type":"error","ok":false,"code":"GENERATION_FAILED","message":"crash"}`,
			expectErr:  true,
			wantCallID: "call-err-456",
			wantLogSubstrings: []string{
				"[llm-stream-client] call=call-err-456",
				"lines=2",
				"kinds={content:0,reasoning:1}",
				"pings=0",
				"cancel_reason=llm-gateway GENERATION_FAILED: crash",
			},
		},
		{
			name:      "stream activity timeout records timeout cancel_reason",
			callID:    "call-timeout-789",
			ndjson:    `{"type":"chunk","delta":"start"}` + "\n",
			timeout:   30 * time.Millisecond,
			expectErr: true,
			wantLogSubstrings: []string{
				"[llm-stream-client] call=call-timeout-789",
				"lines=1",
				"kinds={content:1,reasoning:0}",
				"cancel_reason=llm-gateway: activity timeout exceeded",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var logBuf bytes.Buffer
			origWriter := log.Writer()
			log.SetOutput(&logBuf)
			defer log.SetOutput(origWriter)

			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/x-ndjson")
				if tt.callID != "" {
					w.Header().Set("x-llm-call-id", tt.callID)
				}
				flusher, _ := w.(http.Flusher)
				_, _ = w.Write([]byte(tt.ndjson))
				if flusher != nil {
					flusher.Flush()
				}
				if tt.timeout > 0 {
					time.Sleep(tt.timeout * 3)
				}
			}))
			defer ts.Close()

			c := NewLlmGatewayClient(ts.URL, "tok")
			if tt.timeout > 0 {
				c.SetActivityTimeout(tt.timeout)
			}

			res, err := c.Complete(context.Background(), "doc_enhance", map[string]any{"x": 1}, nil)
			if tt.expectErr {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.wantCallID, res.CallID)
			}

			capturedLog := logBuf.String()
			for _, sub := range tt.wantLogSubstrings {
				assert.Contains(t, capturedLog, sub)
			}
		})
	}
}

func TestLlmGatewayClient_Complete_StreamProgress(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		events := []string{
			`{"type":"chunk","kind":"reasoning","delta":"think1 "}`,
			`{"type":"chunk","kind":"reasoning","delta":"think2"}`,
			`{"type":"chunk","kind":"content","delta":"hello "}`,
			`{"type":"chunk","delta":"world"}`,
			`{"type":"done","ok":true,"text":"hello world","finishReason":"stop"}`,
		}
		for _, ev := range events {
			_, _ = w.Write([]byte(ev + "\n"))
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer ts.Close()

	var progressEvents []LlmStreamProgress
	ctx := WithStreamProgress(context.Background(), func(p LlmStreamProgress) {
		progressEvents = append(progressEvents, p)
	})

	c := NewLlmGatewayClient(ts.URL, "tok")
	res, err := c.Complete(ctx, "code_chapter_lesson", map[string]any{"x": 1}, nil)
	require.NoError(t, err)
	assert.Equal(t, "hello world", res.Text)

	require.Len(t, progressEvents, 4)
	assert.Equal(t, "thinking", progressEvents[0].Stage)
	assert.Equal(t, 7, progressEvents[0].ReasoningChars)
	assert.Equal(t, "thinking", progressEvents[1].Stage)
	assert.Equal(t, 13, progressEvents[1].ReasoningChars)
	assert.Equal(t, "generating", progressEvents[2].Stage)
	assert.Equal(t, 6, progressEvents[2].ContentChars)
	assert.Equal(t, "generating", progressEvents[3].Stage)
	assert.Equal(t, 11, progressEvents[3].ContentChars)
}

func TestLlmGatewayClient_Complete_BriefStatePropagation(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
		body        string
		wantState   string
	}{
		{
			name:        "NDJSON stream done event emits briefState=plan",
			contentType: "application/x-ndjson",
			body:        `{"type":"chunk","delta":"hi"}` + "\n" + `{"type":"done","ok":true,"text":"hi","finishReason":"stop","briefState":"plan"}` + "\n",
			wantState:   "plan",
		},
		{
			name:        "NDJSON stream done event emits briefState=arc",
			contentType: "application/x-ndjson",
			body:        `{"type":"done","ok":true,"text":"hi","finishReason":"stop","briefState":"arc"}` + "\n",
			wantState:   "arc",
		},
		{
			name:        "NDJSON stream done event omits briefState",
			contentType: "application/x-ndjson",
			body:        `{"type":"done","ok":true,"text":"hi","finishReason":"stop"}` + "\n",
			wantState:   "",
		},
		{
			name:        "unary JSON fallback emits briefState=plan",
			contentType: "application/json",
			body:        `{"ok":true,"text":"hi","finishReason":"stop","briefState":"plan"}`,
			wantState:   "plan",
		},
		{
			name:        "unary JSON fallback emits briefState=arc",
			contentType: "application/json",
			body:        `{"ok":true,"text":"hi","finishReason":"stop","briefState":"arc"}`,
			wantState:   "arc",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", tt.contentType)
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer ts.Close()

			c := NewLlmGatewayClient(ts.URL, "tok")
			res, err := c.Complete(context.Background(), "code_chapter_lesson", map[string]any{"x": 1}, nil)
			require.NoError(t, err)
			assert.Equal(t, tt.wantState, res.BriefState)
		})
	}
}

func TestLlmGatewayClient_Complete_UpstreamErrorMetadata(t *testing.T) {
	tests := []struct {
		name               string
		ndjson             string
		wantCode           string
		wantStatus         int
		wantProvider       string
		wantModel          string
		wantUpstreamStatus int
		wantUpstreamCode   string
		wantPermanent      bool
		wantRateLimited    bool
	}{
		{
			name:               "UPSTREAM_QUOTA_EXCEEDED preserves provider model upstreamStatus and code",
			ndjson:             `{"type":"error","ok":false,"code":"UPSTREAM_QUOTA_EXCEEDED","message":"已达到 5 小时使用上限","provider":"zhipu","model":"glm-5.3-flash","upstreamStatus":429,"upstreamCode":"1308"}` + "\n",
			wantCode:           ErrCodeUpstreamQuotaExceeded,
			wantStatus:         402,
			wantProvider:       "zhipu",
			wantModel:          "glm-5.3-flash",
			wantUpstreamStatus: 429,
			wantUpstreamCode:   "1308",
			wantPermanent:      true,
			wantRateLimited:    false,
		},
		{
			name:               "UPSTREAM_AUTH_ERROR is permanent",
			ndjson:             `{"type":"error","ok":false,"code":"UPSTREAM_AUTH_ERROR","message":"Invalid API Key","provider":"openai","model":"gpt-4o","upstreamStatus":401,"upstreamCode":"invalid_api_key"}` + "\n",
			wantCode:           ErrCodeUpstreamAuthError,
			wantStatus:         401,
			wantProvider:       "openai",
			wantModel:          "gpt-4o",
			wantUpstreamStatus: 401,
			wantUpstreamCode:   "invalid_api_key",
			wantPermanent:      true,
			wantRateLimited:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/x-ndjson")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(tt.ndjson))
			}))
			defer ts.Close()

			c := NewLlmGatewayClient(ts.URL, "tok")
			_, err := c.Complete(context.Background(), "outline_plan_v1", map[string]any{"x": 1}, nil)
			require.Error(t, err)

			var gwErr *LlmGatewayError
			require.ErrorAs(t, err, &gwErr)
			assert.Equal(t, tt.wantCode, gwErr.Code)
			assert.Equal(t, tt.wantStatus, gwErr.Status)
			assert.Equal(t, tt.wantProvider, gwErr.Provider)
			assert.Equal(t, tt.wantModel, gwErr.Model)
			assert.Equal(t, tt.wantUpstreamStatus, gwErr.UpstreamStatus)
			assert.Equal(t, tt.wantUpstreamCode, gwErr.UpstreamCode)
			assert.Equal(t, tt.wantPermanent, gwErr.IsPermanentUpstreamError())
			assert.Equal(t, tt.wantRateLimited, gwErr.IsRateLimited())
		})
	}
}

func assertValidStructuredDbErr(t *testing.T, encoded string, maxLen int) *StructuredErrorPayload {
	t.Helper()
	require.True(t, strings.HasPrefix(encoded, StructuredDbErrPrefix), "must carry __OG_ERR__: prefix")
	assert.LessOrEqual(t, len(encoded), maxLen, "encoded byte length must not exceed maxLen")
	assert.LessOrEqual(t, utf8.RuneCountInString(encoded), maxLen, "encoded rune count must not exceed maxLen")
	assert.True(t, utf8.ValidString(encoded), "encoded output must be valid UTF-8")

	jsonPart := strings.TrimPrefix(encoded, StructuredDbErrPrefix)
	assert.True(t, json.Valid([]byte(jsonPart)), "encoded JSON must be valid without truncation corruption")

	decoded, ok := DecodeStructuredDbError(encoded)
	require.True(t, ok, "DecodeStructuredDbError must decode encoded payload")
	return decoded
}

func TestEncodeAndDecodeStructuredDbError(t *testing.T) {
	tests := []struct {
		name               string
		gw                 *LlmGatewayError
		maxLen             int
		wantCode           string
		wantProvider       string
		wantModel          string
		wantUpstreamStatus int
		wantUpstreamCode   string
		wantMsgContains    string
		wantEllipsis       bool
	}{
		{
			name: "short structured error preserves all fields cleanly",
			gw: &LlmGatewayError{
				Code:           ErrCodeUpstreamAuthError,
				Message:        "Invalid API key <test>",
				Provider:       "openai",
				Model:          "gpt-4o",
				UpstreamStatus: 401,
				UpstreamCode:   "invalid_api_key",
			},
			maxLen:             MaxStructuredDbErrLen,
			wantCode:           ErrCodeUpstreamAuthError,
			wantProvider:       "openai",
			wantModel:          "gpt-4o",
			wantUpstreamStatus: 401,
			wantUpstreamCode:   "invalid_api_key",
			wantMsgContains:    "Invalid API key <test>",
		},
		{
			name: "long ASCII message truncates before marshaling and stays valid JSON <= 500",
			gw: &LlmGatewayError{
				Code:           ErrCodeUpstreamQuotaExceeded,
				Message:        strings.Repeat("Quota exceeded for current billing cycle. ", 30),
				Provider:       "zhipu",
				Model:          "glm-5.3-flash",
				UpstreamStatus: 429,
				UpstreamCode:   "1308",
			},
			maxLen:             MaxStructuredDbErrLen,
			wantCode:           ErrCodeUpstreamQuotaExceeded,
			wantProvider:       "zhipu",
			wantModel:          "glm-5.3-flash",
			wantUpstreamStatus: 429,
			wantUpstreamCode:   "1308",
			wantMsgContains:    "Quota exceeded",
			wantEllipsis:       true,
		},
		{
			name: "long multi-byte Chinese message truncates on rune boundary without invalid UTF-8",
			gw: &LlmGatewayError{
				Code:           ErrCodeUpstreamBadRequest,
				Message:        strings.Repeat("请求上下文长度超过模型允许的最大限制，请精简输入内容。", 25),
				Provider:       "anthropic",
				Model:          "claude-sonnet-4-5",
				UpstreamStatus: 400,
				UpstreamCode:   "context_length_exceeded",
			},
			maxLen:             MaxStructuredDbErrLen,
			wantCode:           ErrCodeUpstreamBadRequest,
			wantProvider:       "anthropic",
			wantModel:          "claude-sonnet-4-5",
			wantUpstreamStatus: 400,
			wantUpstreamCode:   "context_length_exceeded",
			wantMsgContains:    "请求上下文长度",
			wantEllipsis:       true,
		},
		{
			name: "extreme metadata length falls back to minimal code-only valid JSON",
			gw: &LlmGatewayError{
				Code:           ErrCodeUpstreamModelNotFound,
				Message:        "model missing",
				Provider:       strings.Repeat("p", 300),
				Model:          strings.Repeat("m", 300),
				UpstreamStatus: 404,
				UpstreamCode:   "model_not_found",
			},
			maxLen:   MaxStructuredDbErrLen,
			wantCode: ErrCodeUpstreamModelNotFound,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			encoded := EncodeStructuredDbError(tt.gw, tt.maxLen)
			decoded := assertValidStructuredDbErr(t, encoded, tt.maxLen)
			assert.Equal(t, tt.wantCode, decoded.Code)
			assert.Equal(t, tt.wantProvider, decoded.Provider)
			assert.Equal(t, tt.wantModel, decoded.Model)
			assert.Equal(t, tt.wantUpstreamStatus, decoded.UpstreamStatus)
			assert.Equal(t, tt.wantUpstreamCode, decoded.UpstreamCode)
			if tt.wantMsgContains != "" {
				assert.Contains(t, decoded.Message, tt.wantMsgContains)
			}
			if tt.wantEllipsis {
				assert.True(t, strings.HasSuffix(decoded.Message, "..."))
			}
		})
	}
}

func TestIsPermanentTerminalErrorCode(t *testing.T) {
	tests := []struct {
		name string
		code string
		want bool
	}{
		{name: "UPSTREAM_AUTH_ERROR", code: ErrCodeUpstreamAuthError, want: true},
		{name: "UPSTREAM_QUOTA_EXCEEDED", code: ErrCodeUpstreamQuotaExceeded, want: true},
		{name: "UPSTREAM_MODEL_NOT_FOUND", code: ErrCodeUpstreamModelNotFound, want: true},
		{name: "UPSTREAM_BAD_REQUEST", code: ErrCodeUpstreamBadRequest, want: true},
		{name: "MISSING_API_KEY", code: ErrCodeMissingApiKey, want: true},
		{name: "KEY_DECRYPT_FAILED", code: ErrCodeKeyDecryptFailed, want: true},
		{name: "UNKNOWN_PURPOSE", code: ErrCodeUnknownPurpose, want: true},
		{name: "RATE_LIMITED is not terminal", code: ErrCodeRateLimited, want: false},
		{name: "BUDGET_EXCEEDED is deferrable not terminal", code: ErrCodeBudgetExceeded, want: false},
		{name: "GENERATION_FAILED is retryable at job level", code: ErrCodeGenerationFailed, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, IsPermanentTerminalErrorCode(tt.code))
		})
	}
}

func TestFormatGatewaySSEErrorPayload(t *testing.T) {
	tests := []struct {
		name   string
		prefix string
		err    error
		wantOk bool
		verify func(t *testing.T, payload map[string]any)
	}{
		{
			name:   "direct LlmGatewayError includes all structured fields",
			prefix: "大纲失败: ",
			err: &LlmGatewayError{
				Code:           ErrCodeUpstreamQuotaExceeded,
				Message:        "已达到 5 小时使用上限",
				Status:         402,
				Provider:       "zhipu",
				Model:          "glm-5.3-flash",
				UpstreamStatus: 429,
				UpstreamCode:   "1308",
			},
			wantOk: true,
			verify: func(t *testing.T, payload map[string]any) {
				t.Helper()
				assert.Equal(t, "大纲失败: 已达到 5 小时使用上限", payload["message"])
				assert.Equal(t, "已达到 5 小时使用上限", payload["upstreamMessage"])
				assert.Equal(t, ErrCodeUpstreamQuotaExceeded, payload["code"])
				assert.Equal(t, "zhipu", payload["provider"])
				assert.Equal(t, "glm-5.3-flash", payload["model"])
				assert.Equal(t, 429, payload["upstreamStatus"])
				assert.Equal(t, "1308", payload["upstreamCode"])
				assert.Equal(t, 402, payload["status"])
			},
		},
		{
			name:   "wrapped LlmGatewayError unwraps cleanly",
			prefix: "",
			err: fmt.Errorf("ladder failed: %w", &LlmGatewayError{
				Code:           ErrCodeUpstreamAuthError,
				Message:        "Invalid API key",
				Provider:       "openai",
				Model:          "gpt-4o",
				UpstreamStatus: 401,
			}),
			wantOk: true,
			verify: func(t *testing.T, payload map[string]any) {
				t.Helper()
				assert.Equal(t, ErrCodeUpstreamAuthError, payload["code"])
				assert.Equal(t, 401, payload["status"])
				assert.Equal(t, "Invalid API key", payload["upstreamMessage"])
			},
		},
		{
			name:   "non-gateway error returns false",
			prefix: "prefix: ",
			err:    fmt.Errorf("plain internal error"),
			wantOk: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			payload, ok := FormatGatewaySSEErrorPayload(tt.prefix, tt.err)
			assert.Equal(t, tt.wantOk, ok)
			if tt.verify != nil {
				tt.verify(t, payload)
			}
		})
	}
}
