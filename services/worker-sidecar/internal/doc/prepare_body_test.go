package doc

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakePrepareStore prepare 段单测夹具（noop/hit/ready 三路径编排）。
type fakePrepareStore struct {
	doc       *PrepareDoc
	docErr    error
	userModel string

	hitContentId string
	hitContent   string
	hitDonor     string
	hitDonorLevel string
	chunkCount   int

	stamped   []string // StampProcessed 收到的 documentId 序列
	attachKey [2]string
	metadata  []string // StoreDocumentMetadata 收到的 docId 序列
}

func (f *fakePrepareStore) LoadDocumentForPrepare(_ context.Context, _ string) (*PrepareDoc, error) {
	if f.docErr != nil {
		return nil, f.docErr
	}
	return f.doc, nil
}
func (f *fakePrepareStore) LoadActiveUserModelId(_ context.Context, _ string) (string, error) {
	return f.userModel, nil
}
func (f *fakePrepareStore) FindReusableContentByFingerprint(_ context.Context, _ string) (string, string, string, string, error) {
	return f.hitContentId, f.hitContent, f.hitDonor, f.hitDonorLevel, nil
}
func (f *fakePrepareStore) CountContentChunks(_ context.Context, _ string) (int, error) {
	return f.chunkCount, nil
}
func (f *fakePrepareStore) AttachContentChunks(_ context.Context, contentId, documentId string) error {
	f.attachKey = [2]string{contentId, documentId}
	return nil
}
func (f *fakePrepareStore) StampProcessed(_ context.Context, documentId, _ string, _ *string, _ *string, _, _ string, _ bool) (bool, error) {
	f.stamped = append(f.stamped, documentId)
	return true, nil
}
func (f *fakePrepareStore) StoreDocumentMetadata(_ context.Context, _, docId, _, _ string, _ ExtractedManifestResult, _ string) error {
	f.metadata = append(f.metadata, docId)
	return nil
}

func strPtr(s string) *string {
	return &s
}

func TestRunPrepare(t *testing.T) {
	newDoc := func(mutate func(*PrepareDoc)) *PrepareDoc {
		d := &PrepareDoc{
			ID:           "doc-1",
			RepositoryID: "repo-1",
			Path:         "docs/guide.md",
			Status:       "UNPROCESSED",
			RepoOwner:    "o",
			RepoName:     "r",
			Branch:       "main",
			RepoProfile:  map[string]any{},
		}
		if mutate != nil {
			mutate(d)
		}
		return d
	}

	tests := []struct {
		name         string
		store        *fakePrepareStore
		opts         PrepareOptions
		wantOutcome  string
		wantModel    string
		wantStamped  bool
		wantMetadata bool
		wantAttach   bool
	}{
		{
			name:        "noop：已 PROCESSED 且内容非空",
			store:       &fakePrepareStore{doc: newDoc(func(d *PrepareDoc) { d.Status = "PROCESSED"; d.Content = strPtr("# 已有") })},
			opts:        PrepareOptions{UserID: "u1"},
			wantOutcome: "noop",
			wantModel:   defaultAIModel,
		},
		{
			name:        "noop 被 forceEnhance 穿透",
			store:       &fakePrepareStore{doc: newDoc(func(d *PrepareDoc) { d.Status = "PROCESSED"; d.Content = strPtr("# 已有") })},
			opts:        PrepareOptions{UserID: "u1", ForceEnhance: true},
			wantOutcome: "ready",
			wantModel:   defaultAIModel,
		},
		{
			name:        "ready：模型链 options > BYOK > 画像 > 默认",
			store:       &fakePrepareStore{doc: newDoc(func(d *PrepareDoc) { d.RepoProfile = map[string]any{"transcriptionModel": "profile-model"} }), userModel: "byok-model"},
			opts:        PrepareOptions{UserID: "u1", Model: "opt-model"},
			wantOutcome: "ready",
			wantModel:   "opt-model",
		},
		{
			name:        "ready：BYOK 优先于画像",
			store:       &fakePrepareStore{doc: newDoc(func(d *PrepareDoc) { d.RepoProfile = map[string]any{"transcriptionModel": "profile-model"} }), userModel: "byok-model"},
			opts:        PrepareOptions{UserID: "u1"},
			wantOutcome: "ready",
			wantModel:   "byok-model",
		},
		{
			name: "指纹命中：donor chunk 兜底 + 盖章 + 概念同步",
			store: &fakePrepareStore{
				doc:          newDoc(nil),
				hitContentId: "content-1",
				hitContent:   "# 复用正文",
				hitDonor:     "donor-doc",
				chunkCount:   0,
			},
			opts:         PrepareOptions{UserID: "u1"},
			wantOutcome:  "fingerprint-hit",
			wantModel:    defaultAIModel,
			wantStamped:  true,
			wantMetadata: true,
			wantAttach:   true,
		},
		{
			name: "指纹命中但 chunk 已有：不复制 donor",
			store: &fakePrepareStore{
				doc:          newDoc(nil),
				hitContentId: "content-1",
				hitContent:   "# 复用正文",
				hitDonor:     "donor-doc",
				chunkCount:   5,
			},
			opts:         PrepareOptions{UserID: "u1"},
			wantOutcome:  "fingerprint-hit",
			wantModel:    defaultAIModel,
			wantStamped:  true,
			wantMetadata: true,
			wantAttach:   false,
		},
		{
			name:        "forceEnhance 跳过指纹命中",
			store:       &fakePrepareStore{doc: newDoc(nil), hitContentId: "content-1", hitContent: "# 复用正文"},
			opts:        PrepareOptions{UserID: "u1", ForceEnhance: true},
			wantOutcome: "ready",
			wantModel:   defaultAIModel,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			patterns := &IngestPatterns{
				Sniffer:                    snifferPatterns{MarkdownExtensions: []string{".md", ".mdx"}},
				VirtualChapterPathPrefixes: []string{"chapters/"},
			}
			res, err := PrepareDocumentBody(context.Background(), Config{ChunkerMaxTokens: 800, ChunkerOverlap: 100}, patterns, tt.store, "doc-1", tt.opts)
			require.NoError(t, err)
			assert.True(t, res.Ok)
			assert.Equal(t, tt.wantOutcome, res.Outcome)
			assert.Equal(t, tt.wantModel, res.Model)
			assert.Equal(t, tt.wantStamped, len(tt.store.stamped) > 0)
			assert.Equal(t, tt.wantMetadata, len(tt.store.metadata) > 0)
			assert.Equal(t, tt.wantAttach, tt.store.attachKey != [2]string{})

			if tt.wantOutcome == "ready" {
				assert.NotEmpty(t, res.Fingerprint, "ready 必须携带指纹（checkpoint 寻址钥匙）")
				assert.Equal(t, 800, res.Chunker.MaxTokens)
				assert.Equal(t, 100, res.Chunker.Overlap)
				assert.True(t, res.Doc.IsMarkdown, "docs/guide.md 应判 markdown")
				assert.False(t, res.Doc.VirtualChapter)
				assert.True(t, res.Doc.EnableAIEnhance, "缺省画像 enableAiEnhance 非显式 false")
			}
			if tt.wantOutcome == "fingerprint-hit" {
				assert.NotEmpty(t, res.Fingerprint)
			}
		})
	}
}

func TestRunPrepareClassification(t *testing.T) {
	patterns := &IngestPatterns{
		Sniffer:                    snifferPatterns{MarkdownExtensions: []string{".md", ".mdx"}},
		VirtualChapterPathPrefixes: []string{"chapters/"},
	}
	tests := []struct {
		name            string
		path            string
		wantMarkdown    bool
		wantVirtualChap bool
	}{
		{name: "markdown 路径", path: "docs/intro.MD", wantMarkdown: true},
		{name: "mdx 路径", path: "docs/intro.mdx", wantMarkdown: true},
		{name: "代码路径", path: "src/index.ts"},
		{name: "虚拟章节前缀", path: "chapters/01-basics", wantVirtualChap: true},
		{name: "普通路径均否", path: "src/a.py"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.wantMarkdown, isMarkdownDocPath(patterns, tt.path))
			assert.Equal(t, tt.wantVirtualChap, isVirtualChapterPath(patterns, tt.path))
		})
	}
}
