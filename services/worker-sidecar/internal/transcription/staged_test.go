package transcription

import (
	"context"
	"testing"

	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 🧪 市场暂存（staged）契约：无锁零落库 + 源冻结 ref 覆写为 target sha +
// 底稿强制全量抓取（不走 JIT 只翻短路）——产物只回传，任何文档/job 状态不被触碰。
func TestRunStagedBodyDocChapter(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# 旧内容底稿", strPtr("中文"), false), valid: true}
	llm := &fakeLlm{text: "# 译文成品"}
	st := &fakeBodyStore{cas: true}
	finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"}

	var fetchedSha *string
	deps := TranscriptionBodyDeps{
		Web:           web,
		PrepareFunc:   web.Prepare,
		Llm:           llm,
		Store:         st,
		FinalizeStore: finalizeSt,
		GoTransform: func(ctx context.Context, owner, repo, branch string, gitSha *string, path string) (string, error) {
			fetchedSha = gitSha
			return "# 抓取原文", nil
		},
	}

	res, err := RunStagedBody(context.Background(), loadConfigFromEnv(), deps, "d1", "u1", "sha-target", "")
	require.NoError(t, err)

	require.NotNil(t, fetchedSha, "staged must fetch content (full acquisition, no JIT shortcut)")
	assert.Equal(t, "sha-target", *fetchedSha, "staged must freeze source ref to target sha")
	assert.Equal(t, "# 译文成品", res.Content, "staged returns generated product")
	assert.Empty(t, st.saved, "staged must not checkpoint (job rows untouched)")
	assert.Equal(t, 0, st.notify, "staged must not notify")
	assert.Empty(t, finalizeSt.stampedContent, "staged must not stamp any document")
	assert.Empty(t, st.cleared, "staged must not touch document status")
}

func TestRunStagedBodyRejectsInvalidInput(t *testing.T) {
	tests := []struct {
		name      string
		deps      BodyDeps
		sourceSha string
		wantErr   string
	}{
		{
			name: "empty source sha",
			deps: BodyDeps{PrepareFunc: func(ctx context.Context, docId, userId string, opts doc.PrepareOptions) (*doc.PrepareResult, error) {
				return nil, nil
			}},
			sourceSha: "  ",
			wantErr:   "sourceSha is required",
		},
		{
			name:      "prepare executor not configured",
			deps:      BodyDeps{},
			sourceSha: "sha-ok",
			wantErr:   "prepare executor not configured",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := RunStagedBody(context.Background(), loadConfigFromEnv(), tt.deps, "d1", "u1", tt.sourceSha, "")
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}
