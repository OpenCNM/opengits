package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 🧪 [7.14.2.1] TestRunReadSymbol_MissingSymbol 验证缺少 symbol 参数时优雅返回错误指引
func TestRunReadSymbol_MissingSymbol(t *testing.T) {
	reader := &readService{}
	resolved := &ResolvedRepo{
		Repository: RepoRow{
			ID:    "repo-1",
			Owner: "test-owner",
			Repo:  "test-repo",
		},
	}

	res := reader.runReadSymbol(context.Background(), resolved, "user-1", "cursor", readSymbolArgs{
		Symbol: nil,
	})
	assert.True(t, res.IsError)
	assert.Contains(t, res.Text, `"symbol" is required`)
}

// 🧪 [7.14.2.2] TestRunReadSymbol_FromCodeClusters 验证基于 repoProfile.codeClusters 提取黄金符号及调用链路
func TestRunReadSymbol_FromCodeClusters(t *testing.T) {
	profile := map[string]any{
		"codeClusters": []map[string]any{
			{
				"teachingOrder": 1,
				"title":         "Core Engine",
				"directories":   []string{"internal/engine"},
				"files":         []string{"internal/engine/engine.go"},
				"cognitive": map[string]any{
					"phase": "FOUNDATION",
					"goldenSymbols": []cognitive.ModuleGoldenSymbol{
						{Name: "NewEngine", File: "internal/engine/engine.go", Kind: "function"},
						{Name: "Engine", File: "internal/engine/types.go", Kind: "type"},
					},
					"callFlow": []cognitive.ModuleCallStep{
						{Caller: "main", Callee: "NewEngine", CalleeFile: "internal/engine/engine.go"},
						{Caller: "server", Callee: "NewEngine", CalleeFile: "internal/engine/engine.go"},
					},
				},
			},
		},
	}
	profileBytes, err := json.Marshal(profile)
	require.NoError(t, err)

	reader := &readService{}
	resolved := &ResolvedRepo{
		Repository: RepoRow{
			ID:          "repo-1",
			Owner:       "test-owner",
			Repo:        "test-repo",
			Branch:      "main",
			RepoProfile: profileBytes,
		},
	}

	t.Run("命中黄金符号直出元数据与调用方", func(t *testing.T) {
		sym := "NewEngine"
		res := reader.runReadSymbol(context.Background(), resolved, "user-1", "cursor", readSymbolArgs{
			Symbol: &sym,
		})
		assert.False(t, res.IsError)
		assert.Contains(t, res.Text, "Code Symbol: `NewEngine` (function)")
		assert.Contains(t, res.Text, "internal/engine/engine.go")
		assert.Contains(t, res.Text, "main, server")
		assert.Contains(t, res.Text, "Chapter 1: Core Engine")
	})

	t.Run("大小写不敏感匹配", func(t *testing.T) {
		sym := "newengine"
		res := reader.runReadSymbol(context.Background(), resolved, "user-1", "cursor", readSymbolArgs{
			Symbol: &sym,
		})
		assert.False(t, res.IsError)
		assert.Contains(t, res.Text, "NewEngine")
	})

	t.Run("未命中时返回错误与可用候选列表", func(t *testing.T) {
		sym := "UnknownFunc"
		res := reader.runReadSymbol(context.Background(), resolved, "user-1", "cursor", readSymbolArgs{
			Symbol: &sym,
		})
		assert.True(t, res.IsError)
		assert.Contains(t, res.Text, `Symbol "UnknownFunc" not found`)
		assert.Contains(t, res.Text, "Available golden symbols")
		assert.Contains(t, res.Text, "NewEngine (internal/engine/engine.go)")
	})
}

// 🧪 [7.14.2.3] TestRunReadSymbol_SourceCodeExtraction 验证从本地磁盘归档提取源码切片
func TestRunReadSymbol_SourceCodeExtraction(t *testing.T) {
	tmpArchive := t.TempDir()
	t.Setenv("ARCHIVE_ROOT", tmpArchive)

	owner := "acme"
	repo := "widget"
	sha := "c0ffee1234"

	// 准备伪造的源码归档目录
	targetDir := filepath.Join(tmpArchive, owner, repo, sha, "pkg", "calc")
	require.NoError(t, os.MkdirAll(targetDir, 0755))

	sourceCode := `package calc

// Add two numbers
func Add(a, b int) int {
	return a + b
}

// Multiply two numbers
func Multiply(a, b int) int {
	return a * b
}
`
	filePath := filepath.Join(targetDir, "calc.go")
	require.NoError(t, os.WriteFile(filePath, []byte(sourceCode), 0644))

	profile := map[string]any{
		"gitSha": sha,
		"codeClusters": []map[string]any{
			{
				"teachingOrder": 1,
				"title":         "Calculator Package",
				"directories":   []string{"pkg/calc"},
				"files":         []string{"pkg/calc/calc.go"},
				"cognitive": map[string]any{
					"phase": "FOUNDATION",
					"goldenSymbols": []cognitive.ModuleGoldenSymbol{
						{Name: "Add", File: "pkg/calc/calc.go", Kind: "function"},
					},
				},
			},
		},
	}
	profileBytes, err := json.Marshal(profile)
	require.NoError(t, err)

	reader := &readService{}
	resolved := &ResolvedRepo{
		Repository: RepoRow{
			ID:          "repo-calc",
			Owner:       owner,
			Repo:        repo,
			Branch:      "main",
			RepoProfile: profileBytes,
		},
	}

	sym := "Add"

	// 1. 默认 contract 模式：直出函数签名，过滤实现体
	resContract := reader.runReadSymbol(context.Background(), resolved, "user-1", "cursor", readSymbolArgs{
		Symbol: &sym,
	})
	assert.False(t, resContract.IsError)
	assert.Contains(t, resContract.Text, "Code Symbol: `Add` (function)")
	assert.Contains(t, resContract.Text, "Type & Interface Contract")
	assert.Contains(t, resContract.Text, "func Add(a, b int) int")
	assert.NotContains(t, resContract.Text, "return a + b")

	// 2. 显式 implementation 模式：直出源码全文实现体
	aspectImpl := "implementation"
	resImpl := reader.runReadSymbol(context.Background(), resolved, "user-1", "cursor", readSymbolArgs{
		Symbol: &sym,
		Aspect: &aspectImpl,
	})
	assert.False(t, resImpl.IsError)
	assert.Contains(t, resImpl.Text, "Source Implementation")
	assert.Contains(t, resImpl.Text, "func Add(a, b int) int {")
	assert.Contains(t, resImpl.Text, "return a + b")

	// 3. architecture 模式：仅输出架构角色与调用方，完全剔除代码块
	aspectArch := "architecture"
	resArch := reader.runReadSymbol(context.Background(), resolved, "user-1", "cursor", readSymbolArgs{
		Symbol: &sym,
		Aspect: &aspectArch,
	})
	assert.False(t, resArch.IsError)
	assert.Contains(t, resArch.Text, "Architecture Role: `Add` (function)")
	assert.Contains(t, resArch.Text, "Architecture mode: implementation code omitted")
	assert.NotContains(t, resArch.Text, "```go")
}

// 🧪 [7.14.2.4] TestRunHubReadSymbol 验证 Hub 模式下多仓边界与参数校验
func TestRunHubReadSymbol(t *testing.T) {
	fakeStore := newReadFakeStore()
	reader := &readService{store: fakeStore}

	t.Run("缺少 repository 时提示指引", func(t *testing.T) {
		sym := "Init"
		res := reader.runHubReadSymbol(context.Background(), "user-1", "cursor", "", readSymbolArgs{
			Symbol: &sym,
		})
		assert.True(t, res.IsError)
		assert.Contains(t, res.Text, `pass "repository"`)
	})

	t.Run("未在书架或不存在的 repository 返回错误", func(t *testing.T) {
		sym := "Init"
		res := reader.runHubReadSymbol(context.Background(), "user-1", "cursor", "invalid-repo-format", readSymbolArgs{
			Symbol: &sym,
		})
		assert.True(t, res.IsError)
		assert.Contains(t, res.Text, "not found in your OpenGits Hub")
	})

	t.Run("私有仓无权限返回 Forbidden", func(t *testing.T) {
		fakeStore.bookshelfResolved["user-1|private/repo"] = &ResolvedRepo{
			Repository: RepoRow{ID: "priv-1", Owner: "private", Repo: "repo", IsPublic: false},
		}
		sym := "Init"
		res := reader.runHubReadSymbol(context.Background(), "user-1", "cursor", "private/repo", readSymbolArgs{
			Symbol: &sym,
		})
		assert.True(t, res.IsError)
		assert.Contains(t, res.Text, "Forbidden: Repository")
	})

	t.Run("私有仓拥有 SavedRepoAccess 允许访问", func(t *testing.T) {
		fakeStore.bookshelfResolved["user-1|private/allowed"] = &ResolvedRepo{
			Repository: RepoRow{ID: "priv-2", Owner: "private", Repo: "allowed", IsPublic: false},
		}
		fakeStore.savedRepos["priv-2|user-1"] = true
		sym := "MissingSymbol"
		res := reader.runHubReadSymbol(context.Background(), "user-1", "cursor", "private/allowed", readSymbolArgs{
			Symbol: &sym,
		})
		// 鉴权通过后进入 runReadSymbol，因符号不存在返回符号未找到（而非 Forbidden）
		assert.True(t, res.IsError)
		assert.NotContains(t, res.Text, "Forbidden")
		assert.Contains(t, res.Text, "not found")
	})
}

// 🧪 [7.14.2.5] TestRunSearchSymbols_FromCodeClusters 验证基于 repoProfile.codeClusters 的符号模糊与拓扑检索
func TestRunSearchSymbols_FromCodeClusters(t *testing.T) {
	profile := map[string]any{
		"codeClusters": []map[string]any{
			{
				"teachingOrder": 1,
				"title":         "Core Engine",
				"directories":   []string{"internal/engine"},
				"files":         []string{"internal/engine/engine.go"},
				"cognitive": map[string]any{
					"phase": "FOUNDATION",
					"goldenSymbols": []cognitive.ModuleGoldenSymbol{
						{Name: "NewEngine", File: "internal/engine/engine.go", Kind: "function"},
						{Name: "Engine", File: "internal/engine/types.go", Kind: "type"},
					},
					"callFlow": []cognitive.ModuleCallStep{
						{Caller: "main", Callee: "NewEngine", CalleeFile: "internal/engine/engine.go"},
						{Caller: "server", Callee: "NewEngine", CalleeFile: "internal/engine/engine.go"},
					},
				},
			},
		},
	}
	profileBytes, err := json.Marshal(profile)
	require.NoError(t, err)

	reader := &readService{}
	resolved := &ResolvedRepo{
		Repository: RepoRow{
			ID:          "repo-1",
			Owner:       "test-owner",
			Repo:        "test-repo",
			Branch:      "main",
			RepoProfile: profileBytes,
		},
	}

	t.Run("命中关键字返回拓扑排序与read_symbol引导", func(t *testing.T) {
		query := "NewEngine"
		res := reader.runSearchSymbols(context.Background(), resolved, "user-1", "cursor", searchSymbolsArgs{
			Query: &query,
		})
		assert.False(t, res.IsError)
		assert.Contains(t, res.Text, `Symbol Search: "NewEngine" in test-owner/test-repo`)
		assert.Contains(t, res.Text, "NewEngine` (function)")
		assert.Contains(t, res.Text, "internal/engine/engine.go")
		assert.Contains(t, res.Text, "main, server")
		assert.Contains(t, res.Text, `read_symbol(symbol="NewEngine", aspect="contract")`)
	})

	t.Run("空query返回全量黄金符号作架构备忘清单", func(t *testing.T) {
		res := reader.runSearchSymbols(context.Background(), resolved, "user-1", "cursor", searchSymbolsArgs{})
		assert.False(t, res.IsError)
		assert.Contains(t, res.Text, "Top Architectural Symbols in test-owner/test-repo")
		assert.Contains(t, res.Text, "NewEngine")
		assert.Contains(t, res.Text, "Engine")
	})

	t.Run("未命中时返回友好提示", func(t *testing.T) {
		query := "NonExistent"
		res := reader.runSearchSymbols(context.Background(), resolved, "user-1", "cursor", searchSymbolsArgs{
			Query: &query,
		})
		assert.False(t, res.IsError)
		assert.Contains(t, res.Text, `No symbols found matching query "NonExistent"`)
	})

	t.Run("文件过滤生效", func(t *testing.T) {
		query := "Engine"
		file := "types.go"
		res := reader.runSearchSymbols(context.Background(), resolved, "user-1", "cursor", searchSymbolsArgs{
			Query: &query,
			File:  &file,
		})
		assert.False(t, res.IsError)
		assert.Contains(t, res.Text, "Engine` (type)")
		assert.NotContains(t, res.Text, "NewEngine` (function)")
	})
}

// 🧪 [7.14.2.6] TestRunHubSearchSymbols 验证 Hub 模式跨仓参数校验与分发
func TestRunHubSearchSymbols(t *testing.T) {
	fakeStore := newReadFakeStore()
	reader := &readService{store: fakeStore}

	t.Run("缺少 repository 时提示指引", func(t *testing.T) {
		q := "Init"
		res := reader.runHubSearchSymbols(context.Background(), "user-1", "cursor", "", searchSymbolsArgs{
			Query: &q,
		})
		assert.True(t, res.IsError)
		assert.Contains(t, res.Text, `pass "repository"`)
	})

	t.Run("未在书架或不存在的 repository 返回错误", func(t *testing.T) {
		q := "Init"
		res := reader.runHubSearchSymbols(context.Background(), "user-1", "cursor", "invalid-repo-format", searchSymbolsArgs{
			Query: &q,
		})
		assert.True(t, res.IsError)
		assert.Contains(t, res.Text, "not found in your OpenGits Hub")
	})

	t.Run("私有仓无权限返回 Forbidden", func(t *testing.T) {
		fakeStore.bookshelfResolved["user-1|private/repo"] = &ResolvedRepo{
			Repository: RepoRow{ID: "priv-1", Owner: "private", Repo: "repo", IsPublic: false},
		}
		q := "Init"
		res := reader.runHubSearchSymbols(context.Background(), "user-1", "cursor", "private/repo", searchSymbolsArgs{
			Query: &q,
		})
		assert.True(t, res.IsError)
		assert.Contains(t, res.Text, "Forbidden: Repository")
	})

	t.Run("私有仓拥有 SavedRepoAccess 允许访问", func(t *testing.T) {
		fakeStore.bookshelfResolved["user-1|private/allowed"] = &ResolvedRepo{
			Repository: RepoRow{ID: "priv-2", Owner: "private", Repo: "allowed", IsPublic: false},
		}
		fakeStore.savedRepos["priv-2|user-1"] = true
		q := "Init"
		res := reader.runHubSearchSymbols(context.Background(), "user-1", "cursor", "private/allowed", searchSymbolsArgs{
			Query: &q,
		})
		// 鉴权通过后进入 runSearchSymbols（无匹配结果返回 empty，非 Forbidden）
		assert.False(t, res.IsError)
		assert.NotContains(t, res.Text, "Forbidden")
	})
}

func TestReadSymbolSourceCode(t *testing.T) {
	root := t.TempDir()
	owner, repo, ref := "test-owner", "test-repo", "sha-sym"
	base := filepath.Join(root, owner, repo, ref)
	require.NoError(t, os.MkdirAll(filepath.Join(base, "pkg"), 0755))

	goCode := `package pkg

func Helper() int {
	return 42
}

type Engine struct {
	ID string
}
`
	filePath := filepath.Join(base, "pkg", "engine.go")
	require.NoError(t, os.WriteFile(filePath, []byte(goCode), 0644))

	tests := []struct {
		name      string
		relPath   string
		symName   string
		startLine int
		endLine   int
		wantSub   string
		wantEmpty bool
	}{
		{
			name:      "exact line slice",
			relPath:   "pkg/engine.go",
			startLine: 3,
			endLine:   5,
			wantSub:   "func Helper() int {\n\treturn 42\n}",
		},
		{
			name:      "scan by symbol name fallback",
			relPath:   "pkg/engine.go",
			symName:   "Engine",
			startLine: 0,
			endLine:   0,
			wantSub:   "type Engine struct {",
		},
		{
			name:      "path traversal rejected",
			relPath:   "../../secret.go",
			wantEmpty: true,
		},
		{
			name:      "nonexistent file returns empty",
			relPath:   "pkg/missing.go",
			wantEmpty: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := readSymbolSourceCode(root, owner, repo, ref, tt.relPath, tt.symName, tt.startLine, tt.endLine)
			if tt.wantEmpty {
				assert.Empty(t, got)
			} else {
				assert.Contains(t, got, tt.wantSub)
			}
		})
	}

	t.Run("oversized file (>2MB) is rejected", func(t *testing.T) {
		largePath := filepath.Join(base, "pkg", "huge.go")
		require.NoError(t, os.WriteFile(largePath, make([]byte, maxSourceFileReadBytes+10*1024), 0644))
		assert.Empty(t, readSymbolSourceCode(root, owner, repo, ref, "pkg/huge.go", "Huge", 1, 10))
	})

	t.Run("read from compact archive .tar.gz when expanded dir missing", func(t *testing.T) {
		cOwner, cRepo, cSha := "acme", "tools", "c54a111222333444555666777888999000aaabbb"
		cDir := filepath.Join(root, cOwner, cRepo, cSha, "pkg")
		require.NoError(t, os.MkdirAll(cDir, 0o755))
		code := "package pkg\n\n// Add adds numbers\nfunc Add(a, b int) int {\n\treturn a + b\n}\n"
		require.NoError(t, os.WriteFile(filepath.Join(cDir, "math.go"), []byte(code), 0o644))
		_, err := archive.CompactArchive(context.Background(), root, cOwner, cRepo, cSha)
		require.NoError(t, err)

		got := readSymbolSourceCode(root, cOwner, cRepo, cSha, "pkg/math.go", "Add", 4, 6)
		assert.Contains(t, got, "func Add(a, b int) int {")
		assert.Contains(t, got, "return a + b")

		gotScan := readSymbolSourceCode(root, cOwner, cRepo, cSha, "pkg/math.go", "Add", 0, 0)
		assert.Contains(t, gotScan, "func Add(a, b int) int {")
	})

	t.Run("read from compact archive rejects oversized file", func(t *testing.T) {
		cOwner, cRepo, cSha := "acme", "tools", "c54a999888777666555444333222111000eeefff"
		cDir := filepath.Join(root, cOwner, cRepo, cSha, "pkg")
		require.NoError(t, os.MkdirAll(cDir, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(cDir, "huge.go"), make([]byte, maxSourceFileReadBytes+10*1024), 0o644))
		_, err := archive.CompactArchive(context.Background(), root, cOwner, cRepo, cSha)
		require.NoError(t, err)

		got := readSymbolSourceCode(root, cOwner, cRepo, cSha, "pkg/huge.go", "Huge", 1, 10)
		assert.Empty(t, got, "oversized file in compact archive must return empty")
	})
}

