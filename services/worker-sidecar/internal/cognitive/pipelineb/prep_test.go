package pipelineb

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPrepTrackerIdempotentStart(t *testing.T) {
	tests := []struct {
		name string
	}{
		{name: "running 期间重复 Start 不再点火"},
		{name: "ready 后可重新点火（手动重试语义）"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tr := NewPrepTracker()
			release := make(chan struct{})
			var runs int32
			started := make(chan struct{})

			first := tr.Start("k", func(context.Context) error {
				atomic.AddInt32(&runs, 1)
				close(started)
				<-release
				return nil
			})
			require.True(t, first)
			<-started

			assert.False(t, tr.Start("k", func(context.Context) error {
				atomic.AddInt32(&runs, 1)
				return nil
			}))
			st, _ := tr.Get("k")
			assert.Equal(t, PrepStatusRunning, st)

			close(release)
			require.Eventually(t, func() bool {
				st, _ := tr.Get("k")
				return st == PrepStatusReady
			}, 2*time.Second, 10*time.Millisecond)
			assert.Equal(t, int32(1), atomic.LoadInt32(&runs))

			assert.True(t, tr.Start("k", func(context.Context) error { return nil }))
			require.Eventually(t, func() bool {
				st, _ := tr.Get("k")
				return st == PrepStatusReady
			}, 2*time.Second, 10*time.Millisecond)
		})
	}
}

func TestPrepTrackerFailedStateCarriesError(t *testing.T) {
	tr := NewPrepTracker()
	boom := errors.New("download interrupted")
	require.True(t, tr.Start("k", func(context.Context) error { return boom }))

	require.Eventually(t, func() bool {
		st, _ := tr.Get("k")
		return st == PrepStatusFailed
	}, 2*time.Second, 10*time.Millisecond)
	st, msg := tr.Get("k")
	assert.Equal(t, PrepStatusFailed, st)
	assert.Contains(t, msg, "download interrupted")
}

func TestPrepTrackerConsumeFailedAndReset(t *testing.T) {
	tests := []struct {
		name      string
		action    string
		expectHit bool
	}{
		{name: "ConsumeFailed 首次消费成功返回错误并清空状态", action: "consume", expectHit: true},
		{name: "Reset 显式重置后直接清除失败状态", action: "reset", expectHit: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tr := NewPrepTracker()
			boom := errors.New("connection reset by peer")
			require.True(t, tr.Start("repo_key", func(context.Context) error { return boom }))

			require.Eventually(t, func() bool {
				st, _ := tr.Get("repo_key")
				return st == PrepStatusFailed
			}, 2*time.Second, 10*time.Millisecond)

			if tt.action == "consume" {
				failed, msg := tr.ConsumeFailed("repo_key")
				assert.True(t, failed)
				assert.Contains(t, msg, "connection reset by peer")

				failedSecond, _ := tr.ConsumeFailed("repo_key")
				assert.False(t, failedSecond)
				st, _ := tr.Get("repo_key")
				assert.Equal(t, "", st)

				assert.True(t, tr.Start("repo_key", func(context.Context) error { return nil }))
			} else if tt.action == "reset" {
				tr.Reset("repo_key")
				st, _ := tr.Get("repo_key")
				assert.Equal(t, "", st)
				assert.True(t, tr.Start("repo_key", func(context.Context) error { return nil }))
			}
		})
	}
}

func TestHandleTreeOutlineFailedCanRetryAfter502(t *testing.T) {
	tests := []struct {
		name string
	}{
		{name: "前序 502 暴露失败后，后续请求或重试参数不再永久被拒，可重新启动准备"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var ensureCalls int32
			ensureBlock := make(chan struct{})
			defer close(ensureBlock)

			h := NewHandler(
				func() cognitive.Patterns { return nil },
				nil,
				func(ctx context.Context, owner, repo, sha string) (string, error) {
					atomic.AddInt32(&ensureCalls, 1)
					<-ensureBlock
					return t.TempDir(), nil
				},
				nil, nil,
			)
			h.SetArchiveStat(func(owner, repo, sha string) bool { return false })

			key := PrepKey("fail_owner", "fail_repo", "deadbeef")
			require.True(t, h.prep.Start(key, func(context.Context) error {
				return errors.New("github tarball EOF")
			}))
			require.Eventually(t, func() bool {
				st, _ := h.prep.Get(key)
				return st == PrepStatusFailed
			}, 2*time.Second, 10*time.Millisecond)

			rec1 := httptest.NewRecorder()
			reqBody := `{"owner":"fail_owner","repo":"fail_repo","sha":"deadbeef"}`
			h.HandleTreeOutline(rec1, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(reqBody)))
			assert.Equal(t, http.StatusBadGateway, rec1.Code)
			assert.Contains(t, rec1.Body.String(), "github tarball EOF")

			rec2 := httptest.NewRecorder()
			h.HandleTreeOutline(rec2, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(reqBody)))
			assert.Equal(t, http.StatusAccepted, rec2.Code)
			var payload map[string]any
			require.NoError(t, json.Unmarshal(rec2.Body.Bytes(), &payload))
			assert.Equal(t, true, payload["preparing"])
			assert.Equal(t, PrepStatusRunning, payload["status"])
		})
	}
}

func TestHandleTreeOutlineColdStartReturns202(t *testing.T) {
	tests := []struct {
		name          string
		body          string
		prepFailed    bool
		wantStatus    int
		wantPreparing bool
		wantErrPart   string
	}{
		{
			name:          "冷缓存(归档缺失+缓存未命中)立即 202 preparing,不阻塞同步预算",
			body:          `{"owner":"openclaw","repo":"openclaw","sha":"abc123","targetLanguage":"zh-CN"}`,
			wantStatus:    http.StatusAccepted,
			wantPreparing: true,
		},
		{
			name:        "上轮准备已失败:如实 502 暴露错误,不让客户端空轮询",
			body:        `{"owner":"fail","repo":"repo","sha":"deadbeef"}`,
			prepFailed:  true,
			wantStatus:  http.StatusBadGateway,
			wantErrPart: "repo preparation failed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var ensureCalls int32
			ensureBlock := make(chan struct{})
			h := NewHandler(
				func() cognitive.Patterns { return nil },
				nil,
				func(ctx context.Context, owner, repo, sha string) (string, error) {
					atomic.AddInt32(&ensureCalls, 1)
					<-ensureBlock
					return t.TempDir(), nil
				},
				nil, nil,
			)
			h.SetArchiveStat(func(owner, repo, sha string) bool {
				return owner == "warm"
			})

			if tt.prepFailed {
				require.True(t, h.prep.Start(PrepKey("fail", "repo", "deadbeef"), func(context.Context) error {
					return errors.New("archive unavailable")
				}))
				require.Eventually(t, func() bool {
					st, _ := h.prep.Get(PrepKey("fail", "repo", "deadbeef"))
					return st == PrepStatusFailed
				}, 2*time.Second, 10*time.Millisecond)
			}

			rec := httptest.NewRecorder()
			done := make(chan struct{})
			go func() {
				defer close(done)
				h.HandleTreeOutline(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tt.body)))
			}()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("cold request blocked on archive preparation")
			}

			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.wantPreparing {
				var payload map[string]any
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
				assert.Equal(t, true, payload["preparing"])
				assert.Equal(t, PrepStatusRunning, payload["status"])
				assert.Greater(t, payload["retryAfterMs"], float64(0))
				assert.Equal(t, int32(0), atomic.LoadInt32(&ensureCalls))
			}
			if tt.wantErrPart != "" {
				assert.Contains(t, rec.Body.String(), tt.wantErrPart)
			}
		})
	}
}

func TestHandleTreeOutlineWarmArchiveBypassesPrep(t *testing.T) {
	var ensureCalls int32
	h := NewHandler(
		func() cognitive.Patterns { return nil },
		nil,
		func(ctx context.Context, owner, repo, sha string) (string, error) {
			atomic.AddInt32(&ensureCalls, 1)
			return t.TempDir(), nil
		},
		nil, nil,
	)
	h.SetArchiveStat(func(owner, repo, sha string) bool { return true })

	rec := httptest.NewRecorder()
	h.HandleTreeOutline(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(
		`{"owner":"o","repo":"r","sha":"","repoDir":"/nonexistent"}`)))
	assert.NotEqual(t, http.StatusAccepted, rec.Code)
}
