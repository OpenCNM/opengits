package rsg

import (
	"fmt"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAstCache_BasicOperations(t *testing.T) {
	cache := NewAstCache(3)
	require.Equal(t, 0, cache.Len())

	extraction1 := &FileAstExtraction{
		Symbols: []SymbolEntry{
			{Name: "Foo", Kind: "function", StartLine: 1, EndLine: 5, Exported: true},
		},
		Imports: []ImportRecord{
			{Module: "bar", Bindings: []string{"Bar"}},
		},
		CallSites: []CallSite{
			{Name: "baz", Line: 3},
		},
		ReferencedConstants: []string{"CONFIG"},
		RawImports:          []string{"bar"},
	}

	cache.Put("go:sha1", extraction1)
	assert.Equal(t, 1, cache.Len())

	got, hit := cache.Get("go:sha1")
	require.True(t, hit)
	require.NotNil(t, got)
	assert.Equal(t, "Foo", got.Symbols[0].Name)
	assert.Equal(t, "bar", got.Imports[0].Module)
	assert.Equal(t, []string{"Bar"}, got.Imports[0].Bindings)
	assert.Equal(t, "baz", got.CallSites[0].Name)
	assert.Equal(t, []string{"CONFIG"}, got.ReferencedConstants)
	assert.Equal(t, []string{"bar"}, got.RawImports)

	gotMiss, hitMiss := cache.Get("go:sha-nonexistent")
	assert.False(t, hitMiss)
	assert.Nil(t, gotMiss)

	stats := cache.Stats()
	assert.Equal(t, int64(1), stats.Hits)
	assert.Equal(t, int64(1), stats.Misses)
	assert.Equal(t, int64(0), stats.Evictions)
}

func TestAstCache_LRUEviction(t *testing.T) {
	cache := NewAstCache(2)

	extA := &FileAstExtraction{Symbols: []SymbolEntry{{Name: "A"}}}
	extB := &FileAstExtraction{Symbols: []SymbolEntry{{Name: "B"}}}
	extC := &FileAstExtraction{Symbols: []SymbolEntry{{Name: "C"}}}

	cache.Put("keyA", extA)
	cache.Put("keyB", extB)
	assert.Equal(t, 2, cache.Len())

	_, hitA := cache.Get("keyA")
	require.True(t, hitA)

	cache.Put("keyC", extC)
	assert.Equal(t, 2, cache.Len())

	_, hitB := cache.Get("keyB")
	assert.False(t, hitB, "keyB should have been evicted")

	_, hitA2 := cache.Get("keyA")
	assert.True(t, hitA2, "keyA should still be present")

	_, hitC := cache.Get("keyC")
	assert.True(t, hitC, "keyC should still be present")

	stats := cache.Stats()
	assert.Equal(t, int64(1), stats.Evictions)
}

func TestAstCache_CloneIsolation(t *testing.T) {
	cache := NewAstCache(5)

	original := &FileAstExtraction{
		Symbols: []SymbolEntry{
			{Name: "OriginalFunc", Kind: "function", StartLine: 1, EndLine: 10},
		},
		Imports: []ImportRecord{
			{Module: "orig-mod", Bindings: []string{"Alpha", "Beta"}},
		},
		RawImports: []string{"orig-mod"},
	}

	cache.Put("key1", original)

	retrieved, ok := cache.Get("key1")
	require.True(t, ok)

	retrieved.Symbols[0].Name = "MutatedFunc"
	retrieved.Imports[0].Module = "mutated-mod"
	retrieved.Imports[0].Bindings[0] = "MutatedBinding"
	retrieved.RawImports[0] = "mutated-mod"

	fresh, ok := cache.Get("key1")
	require.True(t, ok)
	assert.Equal(t, "OriginalFunc", fresh.Symbols[0].Name)
	assert.Equal(t, "orig-mod", fresh.Imports[0].Module)
	assert.Equal(t, "Alpha", fresh.Imports[0].Bindings[0])
	assert.Equal(t, "orig-mod", fresh.RawImports[0])
}

func TestAstCache_ConcurrentSafety(t *testing.T) {
	cache := NewAstCache(100)
	var wg sync.WaitGroup
	workers := 20
	iterations := 50

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				key := fmt.Sprintf("worker-%d-key-%d", workerID, j%10)
				ext := &FileAstExtraction{
					Symbols:    []SymbolEntry{{Name: fmt.Sprintf("sym-%d", j)}},
					RawImports: []string{"import1"},
				}
				cache.Put(key, ext)
				got, _ := cache.Get(key)
				if got != nil {
					_ = got.Clone()
				}
			}
		}(i)
	}

	wg.Wait()
	assert.True(t, cache.Len() <= 100)
}

func TestAstCache_DeterministicKeyAndShaFallback(t *testing.T) {
	tests := []struct {
		name     string
		blobSha  string
		lang     string
		expected string
	}{
		{
			name:     "valid sha and lang",
			blobSha:  "a1b2c3d4",
			lang:     "typescript",
			expected: "typescript:a1b2c3d4",
		},
		{
			name:     "empty sha returns empty",
			blobSha:  "",
			lang:     "go",
			expected: "",
		},
		{
			name:     "empty lang defaults to unknown",
			blobSha:  "sha999",
			lang:     "",
			expected: "unknown:sha999",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			key := MakeAstCacheKey(tc.blobSha, tc.lang)
			assert.Equal(t, tc.expected, key)
		})
	}

	content1 := "package main\n\nfunc Hello() string { return \"world\" }\n"
	content2 := "package main\n\nfunc Hello() string { return \"world\" }\n"
	content3 := "package main\n\nfunc Hello() string { return \"different\" }\n"

	sha1 := ComputeContentSha(content1)
	sha2 := ComputeContentSha(content2)
	sha3 := ComputeContentSha(content3)

	assert.NotEmpty(t, sha1)
	assert.Equal(t, sha1, sha2, "identical content must produce identical sha")
	assert.NotEqual(t, sha1, sha3, "different content must produce different sha")
}

func TestExtractFileAstWithSha_Integration(t *testing.T) {
	cache := NewAstCache(50)
	SetDefaultAstCache(cache)
	defer SetDefaultAstCache(NewAstCache(DefaultMaxAstCacheEntries))

	defs := &LanguageDefinitions{
		Languages: map[string]*LanguageDefinition{
			"typescript": {
				Name:               "typescript",
				ExportConvention:   "wrapper_declaration",
				ImportBindingStyle: "named_specifiers",
			},
		},
		ExtensionToLanguage: map[string]string{
			".ts": "typescript",
		},
	}

	code := `export function greet(name: string): string {
    return "Hello " + name;
}`
	filePath := "src/greet.ts"
	blobSha := "mock-blob-sha-12345"

	ast1 := defs.ExtractFileAstWithSha(code, filePath, blobSha)
	require.NotNil(t, ast1)
	require.Len(t, ast1.Symbols, 1)
	assert.Equal(t, "greet", ast1.Symbols[0].Name)

	stats1 := cache.Stats()
	assert.Equal(t, int64(0), stats1.Hits)
	assert.Equal(t, int64(1), stats1.Misses)

	ast2 := defs.ExtractFileAstWithSha(code, filePath, blobSha)
	require.NotNil(t, ast2)
	require.Len(t, ast2.Symbols, 1)
	assert.Equal(t, "greet", ast2.Symbols[0].Name)

	stats2 := cache.Stats()
	assert.Equal(t, int64(1), stats2.Hits)
	assert.Equal(t, int64(1), stats2.Misses)

	cache.Reset()
	ast3 := defs.ExtractFileAst(code, filePath)
	require.NotNil(t, ast3)
	stats3 := cache.Stats()
	assert.Equal(t, int64(0), stats3.Hits)
	assert.Equal(t, int64(1), stats3.Misses)
	assert.Equal(t, 1, cache.Len())

	ast4 := defs.ExtractFileAst(code, filePath)
	require.NotNil(t, ast4)
	stats4 := cache.Stats()
	assert.Equal(t, int64(1), stats4.Hits)
	assert.Equal(t, int64(1), stats4.Misses)
}
