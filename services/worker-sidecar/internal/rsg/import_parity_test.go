package rsg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type importGoldenCase struct {
	Language        string   `json:"language"`
	FilePath        string   `json:"filePath"`
	Content         string   `json:"content"`
	ExpectedImports []string `json:"expectedImports"`
}

type importGoldenFixture struct {
	GeneratedBy    string             `json:"generatedBy"`
	TotalLanguages int                `json:"totalLanguages"`
	Cases          []importGoldenCase `json:"cases"`
}

func findImportExtractorGoldenPath() string {
	candidates := []string{
		"testdata/import-extractor.golden.json",
		"../../testdata/import-extractor.golden.json",
		"services/worker-sidecar/testdata/import-extractor.golden.json",
		"/app/testdata/import-extractor.golden.json",
		"/src/services/worker-sidecar/testdata/import-extractor.golden.json",
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "testdata/import-extractor.golden.json"
}

func TestImportExtractorGoldenParity(t *testing.T) {
	goldenPath := findImportExtractorGoldenPath()
	raw, err := os.ReadFile(goldenPath)
	require.NoError(t, err, "import-extractor.golden.json missing (frozen contract fixture)")

	var fixture importGoldenFixture
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.Equal(t, 35, len(fixture.Cases), "must cover exactly 35 languages")

	defs := DefaultLanguageDefinitions()
	require.NotNil(t, defs)

	for _, tc := range fixture.Cases {
		t.Run(tc.Language, func(t *testing.T) {
			got := defs.ExtractImportPaths(tc.Content, tc.FilePath)
			sort.Strings(got)
			expected := append([]string(nil), tc.ExpectedImports...)
			sort.Strings(expected)
			assert.Equal(t, expected, got, "import extraction mismatch for %s (%s)", tc.Language, tc.FilePath)
		})
	}
}

func TestLoadLanguageDefinitionsFailClosed(t *testing.T) {
	t.Run("空路径返回原生预置", func(t *testing.T) {
		defs, err := LoadLanguageDefinitions("")
		require.NoError(t, err)
		require.NotNil(t, defs)
		assert.Equal(t, 35, len(defs.Languages))
		assert.Equal(t, "typescript", defs.ExtensionToLanguage[".ts"])
	})

	t.Run("显式缺失路径坚决报错", func(t *testing.T) {
		badPath := filepath.Join(t.TempDir(), "nonexistent-language-definitions.json")
		defs, err := LoadLanguageDefinitions(badPath)
		require.Error(t, err)
		assert.Nil(t, defs)
		assert.Contains(t, err.Error(), "[rsg] explicit language-definitions path")
	})

	t.Run("显式损坏JSON坚决报错", func(t *testing.T) {
		corruptFile := filepath.Join(t.TempDir(), "corrupt-lang.json")
		require.NoError(t, os.WriteFile(corruptFile, []byte("{invalid-json"), 0o644))
		defs, err := LoadLanguageDefinitions(corruptFile)
		require.Error(t, err)
		assert.Nil(t, defs)
		assert.Contains(t, err.Error(), "unmarshal language-definitions.json")
	})

	t.Run("loadIngestPatterns在RSG包内的失效封闭", func(t *testing.T) {
		p := loadIngestPatterns("")
		require.NotNil(t, p)

		badPath := filepath.Join(t.TempDir(), "nonexistent.json")
		assert.Panics(t, func() {
			loadIngestPatterns(badPath)
		})
	})
}

func TestDefaultLanguageDefinitionsIsolationAndConcurrency(t *testing.T) {
	d1 := DefaultLanguageDefinitions()
	d2 := DefaultLanguageDefinitions()

	d1.Config.ExcludeTestsFromEdges = false
	d2.Config.ExcludeTestsFromEdges = true
	assert.False(t, d1.Config.ExcludeTestsFromEdges)
	assert.True(t, d2.Config.ExcludeTestsFromEdges)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			d := DefaultLanguageDefinitions()
			require.NotNil(t, d)
			d.Config.PagerankIterations = 10 + idx
			assert.Equal(t, 10+idx, d.Config.PagerankIterations)

			imports := d.ExtractImportPaths("import os\nimport sys", "main.py")
			assert.Contains(t, imports, "os")
			assert.Contains(t, imports, "sys")
		}(i)
	}
	wg.Wait()
}
