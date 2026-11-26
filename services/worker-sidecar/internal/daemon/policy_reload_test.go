package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opengits/worker-sidecar/internal/platform/policy"
	"github.com/opengits/worker-sidecar/internal/transcription"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakePolicyReloadStore struct {
	transcription.QueueStore
	rt policy.RuntimePolicy
}

func (f *fakePolicyReloadStore) ReadRuntimePolicy(_ context.Context) (policy.RuntimePolicy, error) {
	return f.rt, nil
}

func TestHandlePolicyReloadEndpoint(t *testing.T) {
	defer policy.DefaultGatewayPolicy.Reset()

	six := 6
	four := 4
	nine := 9
	two := 2

	tests := []struct {
		name          string
		token         string
		initial       policy.RuntimePolicy
		updated       policy.RuntimePolicy
		safeMode      bool
		wantStatus    int
		wantConc      int
		wantChunkConc int
		wantSafeMode  bool
	}{
		{
			name:       "rejects unauthorized caller",
			token:      "wrong-token",
			initial:    policy.RuntimePolicy{TranscriptionConcurrency: &six},
			updated:    policy.RuntimePolicy{TranscriptionConcurrency: &nine},
			wantStatus: http.StatusForbidden,
		},
		{
			name:          "force reloads policy and returns updated runtime state",
			token:         "secret-token",
			initial:       policy.RuntimePolicy{TranscriptionConcurrency: &six, TranscriptionChunkConcurrency: &four},
			updated:       policy.RuntimePolicy{TranscriptionConcurrency: &nine, TranscriptionChunkConcurrency: &two},
			safeMode:      false,
			wantStatus:    http.StatusOK,
			wantConc:      9,
			wantChunkConc: 2,
			wantSafeMode:  false,
		},
		{
			name:          "respects safeMode ceiling on reload",
			token:         "secret-token",
			initial:       policy.RuntimePolicy{TranscriptionConcurrency: &six},
			updated:       policy.RuntimePolicy{TranscriptionConcurrency: &nine, TranscriptionChunkConcurrency: &two},
			safeMode:      true,
			wantStatus:    http.StatusOK,
			wantConc:      1,
			wantChunkConc: 2,
			wantSafeMode:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			policy.DefaultGatewayPolicy.Reset()
			pStore := &fakePolicyReloadStore{rt: tt.initial}
			_ = policy.GetRuntimePolicy(context.Background(), pStore)
			pStore.rt = tt.updated

			srv := newServer(Config{
				InternalToken:            "secret-token",
				TranscriptionConcurrency: 3,
			}, nil, nil, nil, nil)
			srv.policyStore = pStore
			tr := transcription.NewTranscriptionRunner(transcription.Config{
				TranscriptionConcurrency: 3,
				TranscriptionMaxPerCycle: 4,
			}, pStore)
			if tt.safeMode {
				tr.SetSafeMode(true)
			}
			srv.SetTranscriptionRunner(tr)

			req := httptest.NewRequest(http.MethodPost, "/v1/policy/reload", nil)
			req.Header.Set("x-internal-token", tt.token)
			rec := httptest.NewRecorder()
			srv.routes().ServeHTTP(rec, req)

			require.Equal(t, tt.wantStatus, rec.Code)
			if tt.wantStatus != http.StatusOK {
				return
			}

			var body struct {
				OK                            bool `json:"ok"`
				TranscriptionConcurrency      int  `json:"transcriptionConcurrency"`
				TranscriptionChunkConcurrency int  `json:"transcriptionChunkConcurrency"`
				SafeMode                      bool `json:"safeMode"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.True(t, body.OK)
			assert.Equal(t, tt.wantConc, body.TranscriptionConcurrency)
			assert.Equal(t, tt.wantChunkConc, body.TranscriptionChunkConcurrency)
			assert.Equal(t, tt.wantSafeMode, body.SafeMode)
		})
	}
}
