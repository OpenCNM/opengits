package ingest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type expectedClassification struct {
	IsDoc                   bool `json:"isDoc"`
	IsCode                  bool `json:"isCode"`
	IsNonContentDir         bool `json:"isNonContentDir"`
	IsNonContentFile        bool `json:"isNonContentFile"`
	IsTest                  bool `json:"isTest"`
	IsEntryPoint            bool `json:"isEntryPoint"`
	IsReadme                bool `json:"isReadme"`
	IsConfigFile            bool `json:"isConfigFile"`
	IsDataModelFile         bool `json:"isDataModelFile"`
	IsTypeHubFile           bool `json:"isTypeHubFile"`
	IsUtilityFile           bool `json:"isUtilityFile"`
	IsBuildSystemFile       bool `json:"isBuildSystemFile"`
	IsMetaOrProtocolDoc     bool `json:"isMetaOrProtocolDoc"`
	IsCoreDocEntryKeyword   bool `json:"isCoreDocEntryKeyword"`
	IsTopLevelDocDir        bool `json:"isTopLevelDocDir"`
	IsBinaryOrArchive       bool `json:"isBinaryOrArchive"`
	IsNoisyPath             bool `json:"isNoisyPath"`
	IsIgnoredFilename       bool `json:"isIgnoredFilename"`
	MatchesAllowedExtension bool `json:"matchesAllowedExtension"`
	IsHighPriorityMigration bool `json:"isHighPriorityMigration"`
}

type patternGoldenCase struct {
	Path     string                 `json:"path"`
	Expected expectedClassification `json:"expected"`
}

type patternGoldenFixture struct {
	GeneratedBy string              `json:"generatedBy"`
	TotalCases  int                 `json:"totalCases"`
	Cases       []patternGoldenCase `json:"cases"`
}

func findIngestPatternsGoldenPath() string {
	candidates := []string{
		"testdata/ingest-patterns.golden.json",
		"../../testdata/ingest-patterns.golden.json",
		"services/worker-sidecar/testdata/ingest-patterns.golden.json",
		"/app/testdata/ingest-patterns.golden.json",
		"/src/services/worker-sidecar/testdata/ingest-patterns.golden.json",
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "testdata/ingest-patterns.golden.json"
}

// 🧪 [1.16.1.5 · CRITICAL] TestIngestPatternsGoldenParity 验证原生 Patterns 与 TS 契约对拍逐字段一致
func TestIngestPatternsGoldenParity(t *testing.T) {
	goldenPath := findIngestPatternsGoldenPath()
	raw, err := os.ReadFile(goldenPath)
	require.NoError(t, err, "ingest-patterns.golden.json missing (frozen contract fixture)")

	var fixture patternGoldenFixture
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)
	require.Equal(t, fixture.TotalCases, len(fixture.Cases), "fixture Cases count must equal TotalCases")

	p := DefaultPatterns()
	require.NotNil(t, p)

	for _, tc := range fixture.Cases {
		exp := tc.Expected
		fp := tc.Path
		base := filepath.Base(fp)

		assert.Equal(t, exp.IsDoc, p.IsDocFile(fp), "%s: IsDocFile mismatch", fp)
		assert.Equal(t, exp.IsCode, p.IsCodeFile(fp), "%s: IsCodeFile mismatch", fp)
		assert.Equal(t, exp.IsNonContentDir, p.IsNonContentDir(fp), "%s: IsNonContentDir mismatch", fp)
		assert.Equal(t, exp.IsNonContentFile, p.IsNonContentFile(fp), "%s: IsNonContentFile mismatch", fp)
		assert.Equal(t, exp.IsTest, p.IsTestFile(fp), "%s: IsTestFile mismatch", fp)
		assert.Equal(t, exp.IsEntryPoint, p.IsEntryPoint(fp), "%s: IsEntryPoint mismatch", fp)
		assert.Equal(t, exp.IsReadme, p.IsReadme(fp), "%s: IsReadme mismatch", fp)
		assert.Equal(t, exp.IsConfigFile, p.IsConfigFile(fp), "%s: IsConfigFile mismatch", fp)
		assert.Equal(t, exp.IsDataModelFile, p.IsDataModelFile(fp), "%s: IsDataModelFile mismatch", fp)
		assert.Equal(t, exp.IsTypeHubFile, p.IsTypeHubFile(fp), "%s: IsTypeHubFile mismatch", fp)
		assert.Equal(t, exp.IsUtilityFile, p.IsUtilityFile(fp), "%s: IsUtilityFile mismatch", fp)
		assert.Equal(t, exp.IsBuildSystemFile, p.IsBuildSystemFile(base), "%s: IsBuildSystemFile mismatch", fp)
		assert.Equal(t, exp.IsMetaOrProtocolDoc, p.IsMetaOrProtocolDoc(base), "%s: IsMetaOrProtocolDoc mismatch", fp)
		assert.Equal(t, exp.IsCoreDocEntryKeyword, p.IsCoreDocEntryKeyword(base), "%s: IsCoreDocEntryKeyword mismatch", fp)
		assert.Equal(t, exp.IsTopLevelDocDir, p.IsTopLevelDocDir(fp), "%s: IsTopLevelDocDir mismatch", fp)
		assert.Equal(t, exp.IsBinaryOrArchive, p.IsBinaryOrArchiveFile(fp), "%s: IsBinaryOrArchiveFile mismatch", fp)
		assert.Equal(t, exp.IsNoisyPath, p.IsNoisyPath(fp), "%s: IsNoisyPath mismatch", fp)
		assert.Equal(t, exp.IsIgnoredFilename, p.IsIgnoredFilename(base), "%s: IsIgnoredFilename mismatch", fp)
		assert.Equal(t, exp.MatchesAllowedExtension, p.MatchesAllowedFileExtension(fp), "%s: MatchesAllowedFileExtension mismatch", fp)
		assert.Equal(t, exp.IsHighPriorityMigration, p.IsHighPriorityMigrationFile(fp), "%s: IsHighPriorityMigrationFile mismatch", fp)
	}
}
