package pipelineb

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/client"
)

type fakeGatewaySamplerClient struct {
	res  *OutlineSamplerResult
	err  error
	wait time.Duration
}

func (f *fakeGatewaySamplerClient) Generate(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error {
	if f.wait > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(f.wait):
		}
	}
	if f.err != nil {
		return f.err
	}
	if f.res != nil {
		ptr, ok := out.(*OutlineSamplerResult)
		if ok {
			*ptr = *f.res
		}
	}
	return nil
}

func (f *fakeGatewaySamplerClient) Complete(ctx context.Context, purpose string, variables map[string]any, userId *string) (client.LlmTextResult, error) {
	return client.LlmTextResult{}, errors.New("not implemented")
}

func TestSanitizeSampledPaths(t *testing.T) {
	entries := []client.GitTreeEntry{
		{Path: "README.md", Type: "blob", Size: 100},
		{Path: "src/main.ts", Type: "blob", Size: 200},
		{Path: "src/render/gl.ts", Type: "blob", Size: 300},
		{Path: "src/empty.ts", Type: "blob", Size: 0}, // 零字节文件排除
		{Path: "src/dir", Type: "tree"},               // 目录排除
		{Path: "packages/core/index.ts", Type: "blob", Size: 400},
		{Path: "packages/core/util.ts", Type: "blob", Size: 250},
	}

	tests := []struct {
		name        string
		needFiles   []string
		prefixScope string
		want        []string
	}{
		{
			name:        "drops hallucinated paths and retains real blobs",
			needFiles:   []string{"README.md", "non-existent.ts", "src/main.ts", "fake/path.ts"},
			prefixScope: "",
			want:        []string{"README.md", "src/main.ts"},
		},
		{
			name:        "skips empty and tree nodes",
			needFiles:   []string{"src/dir", "src/empty.ts", "src/render/gl.ts"},
			prefixScope: "",
			want:        []string{"src/render/gl.ts"},
		},
		{
			name:        "deduplicates and normalizes slashes",
			needFiles:   []string{"/README.md", "README.md", "src/main.ts", "src//main.ts"},
			prefixScope: "",
			want:        []string{"README.md", "src/main.ts"},
		},
		{
			name:        "filters by prefix scope",
			needFiles:   []string{"README.md", "packages/core/index.ts", "packages/core/util.ts", "src/main.ts"},
			prefixScope: "packages/core",
			want:        []string{"packages/core/index.ts", "packages/core/util.ts"},
		},
		{
			name:        "auto-resolves subvolume relative paths when prefixScope is provided",
			needFiles:   []string{"index.ts", "util.ts", "nonexistent.ts"},
			prefixScope: "packages/core",
			want:        []string{"packages/core/index.ts", "packages/core/util.ts"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SanitizeSampledPaths(tt.needFiles, entries, tt.prefixScope)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestSanitizeSampledPaths_CapsAt25(t *testing.T) {
	entries := make([]client.GitTreeEntry, 30)
	needFiles := make([]string, 30)
	for i := 0; i < 30; i++ {
		p := fmt.Sprintf("file_%d.go", i)
		entries[i] = client.GitTreeEntry{Path: p, Type: "blob", Size: 100}
		needFiles[i] = p
	}

	got := SanitizeSampledPaths(needFiles, entries, "")
	require.Len(t, got, 25, "必须被硬防御保护帽截断在 25 个文件以内")
	assert.Equal(t, "file_0.go", got[0])
	assert.Equal(t, "file_24.go", got[24])
}

func TestFindReadmePathFromEntries(t *testing.T) {
	tests := []struct {
		name        string
		entries     []client.GitTreeEntry
		prefixScope string
		want        string
	}{
		{
			name: "root readme.md is preferred",
			entries: []client.GitTreeEntry{
				{Path: "README_zh.md", Type: "blob", Size: 100},
				{Path: "README.md", Type: "blob", Size: 100},
				{Path: "main.go", Type: "blob", Size: 100},
			},
			prefixScope: "",
			want:        "README.md",
		},
		{
			name: "scoped prefix selects child readme",
			entries: []client.GitTreeEntry{
				{Path: "README.md", Type: "blob", Size: 100},
				{Path: "services/core/README.md", Type: "blob", Size: 100},
				{Path: "services/core/main.go", Type: "blob", Size: 100},
			},
			prefixScope: "services/core",
			want:        "services/core/README.md",
		},
		{
			name: "scoped prefix without internal readme falls back to root readme",
			entries: []client.GitTreeEntry{
				{Path: "README.md", Type: "blob", Size: 200},
				{Path: "services/core/main.go", Type: "blob", Size: 100},
			},
			prefixScope: "services/core",
			want:        "README.md",
		},
		{
			name: "no readme returns empty",
			entries: []client.GitTreeEntry{
				{Path: "main.go", Type: "blob", Size: 100},
			},
			prefixScope: "",
			want:        "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := FindReadmePathFromEntries(tt.entries, tt.prefixScope)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestGatewaySampler_SampleCoreFiles(t *testing.T) {
	tests := []struct {
		name      string
		fakeRes   *OutlineSamplerResult
		fakeErr   error
		wantFiles []string
		wantErr   bool
	}{
		{
			name: "successful sample returns needFiles",
			fakeRes: &OutlineSamplerResult{
				ArchitectureArchetype: "compiler",
				SubsystemCount:        3,
				NeedFiles:             []string{"src/lexer.rs", "src/parser.rs"},
			},
			wantFiles: []string{"src/lexer.rs", "src/parser.rs"},
			wantErr:   false,
		},
		{
			name:    "gateway error is propagated",
			fakeErr: errors.New("upstream gateway timeout"),
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &fakeGatewaySamplerClient{res: tt.fakeRes, err: tt.fakeErr}
			sampler := &GatewaySampler{Client: client}

			res, err := sampler.SampleCoreFiles(context.Background(), SampleRequest{Skeleton: "skeleton", Readme: "# README"})
			if tt.wantErr {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				require.NotNil(t, res)
				assert.Equal(t, tt.wantFiles, res.NeedFiles)
				assert.Equal(t, tt.fakeRes.ArchitectureArchetype, res.ArchitectureArchetype)
			}
		})
	}
}

func TestSampleOrFallbackCoreFiles(t *testing.T) {
	patterns := loadPatterns(t)

	entries := []client.GitTreeEntry{
		{Path: "README.md", Type: "blob", Size: 200},
		{Path: "package.json", Type: "blob", Size: 150},
		{Path: "src/index.ts", Type: "blob", Size: 500},
		{Path: "src/engine.ts", Type: "blob", Size: 600},
	}

	tests := []struct {
		name       string
		sampler    OutlineSampler
		entries    []client.GitTreeEntry
		subsystems []SubsystemSpec
		sreq       SampleRequest
		want       []string
		wantMode   string
	}{
		{
			name: "success path returns sanitized ai needFiles (stratified)",
			sampler: &fakeSamplerImpl{
				res: &OutlineSamplerResult{
					ArchitectureArchetype: "web_framework",
					SubsystemCount:        2,
					NeedFiles:             []string{"src/index.ts", "src/engine.ts", "hallucinated.ts"},
				},
			},
			want:     []string{"src/index.ts", "src/engine.ts"},
			wantMode: SamplingStrategyStratified,
		},
		{
			name: "ai returns only hallucinated paths -> fail-open fallback to README + manifests",
			sampler: &fakeSamplerImpl{
				res: &OutlineSamplerResult{
					ArchitectureArchetype: "web_framework",
					SubsystemCount:        2,
					NeedFiles:             []string{"ghost1.ts", "ghost2.ts"},
				},
			},
			want:     []string{"README.md", "package.json", "src/index.ts", "src/engine.ts"},
			wantMode: SamplingStrategyFallback8,
		},
		{
			name: "ai sampler error -> fail-open fallback to README + manifests",
			sampler: &fakeSamplerImpl{
				err: errors.New("rpc failed"),
			},
			want:     []string{"README.md", "package.json", "src/index.ts", "src/engine.ts"},
			wantMode: SamplingStrategyFallback8,
		},
		{
			name: "ai sampler timeout (deadline exceeded) -> fail-open fallback",
			sampler: &fakeSamplerImpl{
				wait: 5 * time.Second, // 超过 4s 截止
			},
			want:     []string{"README.md", "package.json", "src/index.ts", "src/engine.ts"},
			wantMode: SamplingStrategyFallback8,
		},
		{
			name:     "nil sampler -> fail-open fallback",
			sampler:  nil,
			want:     []string{"README.md", "package.json", "src/index.ts", "src/engine.ts"},
			wantMode: SamplingStrategyFallback8,
		},
		{
			name: "strategy B condition threading: sampler receives teachingDepth/learnerArchetype/customPrompt",
			sampler: &fakeSamplerImpl{
				res: &OutlineSamplerResult{
					ArchitectureArchetype: "monorepo",
					SubsystemCount:        3,
					NeedFiles:             []string{"src/index.ts"},
				},
			},
			sreq: SampleRequest{
				Skeleton:         "skeleton",
				Readme:           "# README",
				TeachingDepth:    "deep",
				LearnerArchetype: "deep_dive_internals",
				CustomPrompt:     "聚焦编译器管线",
			},
			want:     []string{"src/index.ts"},
			wantMode: SamplingStrategyStratified,
		},
		{
			name: "strategy B subsystem quota top-up: unsampled subsystem gets guaranteed share",
			sampler: &fakeSamplerImpl{
				res: &OutlineSamplerResult{
					ArchitectureArchetype: "monorepo",
					SubsystemCount:        2,
					NeedFiles:             []string{"packages/reactivity/index.ts"},
				},
			},
			subsystems: []SubsystemSpec{
				{ID: "sub_reactivity", Name: "reactivity", Prefix: "packages/reactivity", FileCount: 2, EstLOC: 120},
				{ID: "sub_compiler", Name: "compiler-core", Prefix: "packages/compiler-core", FileCount: 2, EstLOC: 90},
			},
			entries: []client.GitTreeEntry{
				{Path: "packages/reactivity/index.ts", Type: "blob", Size: 500},
				{Path: "packages/reactivity/effect.ts", Type: "blob", Size: 400},
				{Path: "packages/compiler-core/index.ts", Type: "blob", Size: 600},
				{Path: "packages/compiler-core/parse.ts", Type: "blob", Size: 450},
			},
			want:     []string{"packages/reactivity/index.ts", "packages/compiler-core/index.ts", "packages/compiler-core/parse.ts"},
			wantMode: SamplingStrategyStratified,
		},
		{
			name:    "strategy B fallback quota: rule fallback distributes across subsystems",
			sampler: nil,
			subsystems: []SubsystemSpec{
				{ID: "sub_reactivity", Name: "reactivity", Prefix: "packages/reactivity", FileCount: 2, EstLOC: 120},
				{ID: "sub_compiler", Name: "compiler-core", Prefix: "packages/compiler-core", FileCount: 2, EstLOC: 90},
			},
			entries: []client.GitTreeEntry{
				{Path: "README.md", Type: "blob", Size: 200},
				{Path: "packages/reactivity/index.ts", Type: "blob", Size: 500},
				{Path: "packages/reactivity/effect.ts", Type: "blob", Size: 400},
				{Path: "packages/compiler-core/index.ts", Type: "blob", Size: 600},
			},
			wantMode: SamplingStrategyFallback8,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sreq := tt.sreq
			if sreq.Skeleton == "" && sreq.Readme == "" && sreq.Prefix == "" &&
				sreq.TeachingDepth == "" && sreq.LearnerArchetype == "" && sreq.CustomPrompt == "" {
				sreq = SampleRequest{Skeleton: "skeleton", Readme: "# README"}
			}
			testEntries := tt.entries
			if testEntries == nil {
				testEntries = entries
			}
			got, mode := SampleOrFallbackCoreFiles(context.Background(), tt.sampler, testEntries, sreq, patterns, tt.subsystems)
			assert.Equal(t, tt.wantMode, mode, "采样模式标签必须如实上浮")
			if tt.want != nil {
				assert.Equal(t, tt.want, got)
			}
		})
	}
}

// TestSampleOrFallbackCoreFiles_ConditionThreading 策略 B 透传断言（契约 C5）：
// 采样器收到的 SampleRequest 必须携带用户选定三字段（逐字段键级断言）。
func TestSampleOrFallbackCoreFiles_ConditionThreading(t *testing.T) {
	patterns := loadPatterns(t)
	entries := []client.GitTreeEntry{
		{Path: "packages/core/src/index.ts", Type: "blob", Size: 500},
	}
	sampler := &fakeSamplerImpl{
		res: &OutlineSamplerResult{NeedFiles: []string{"src/index.ts"}}, // 子卷相对路径自动补齐 scope
	}
	sreq := SampleRequest{
		Skeleton:         "skeleton",
		Readme:           "# README",
		Prefix:           "packages/core",
		TeachingDepth:    "deep",
		LearnerArchetype: "architecture_overview",
		CustomPrompt:     "聚焦响应式内核",
	}

	got, mode := SampleOrFallbackCoreFiles(context.Background(), sampler, entries, sreq, patterns, nil)
	assert.Equal(t, SamplingStrategyStratified, mode)
	assert.Equal(t, []string{"packages/core/src/index.ts"}, got)

	captured := sampler.captured
	require.NotNil(t, captured, "采样器必须被调用")
	assert.Equal(t, "skeleton", captured.Skeleton)
	assert.Equal(t, "# README", captured.Readme)
	assert.Equal(t, "packages/core", captured.Prefix)
	assert.Equal(t, "deep", captured.TeachingDepth, "TeachingDepth 必须透传至采样器")
	assert.Equal(t, "architecture_overview", captured.LearnerArchetype, "LearnerArchetype 必须透传至采样器")
	assert.Equal(t, "聚焦响应式内核", captured.CustomPrompt, "CustomPrompt 必须透传至采样器")
}

type fakeSamplerImpl struct {
	res  *OutlineSamplerResult
	err  error
	wait time.Duration
	// captured 记录最近一次收到的采样请求（策略 B 条件透传断言用）
	captured *SampleRequest
}

func (f *fakeSamplerImpl) SampleCoreFiles(ctx context.Context, req SampleRequest) (*OutlineSamplerResult, error) {
	f.captured = &req
	if f.wait > 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(f.wait):
		}
	}
	if f.err != nil {
		return nil, f.err
	}
	return f.res, nil
}
