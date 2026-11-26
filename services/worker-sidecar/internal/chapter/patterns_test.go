package chapter

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChapterLoadIngestPatternsFailClosed(t *testing.T) {
	t.Run("空路径返回内置默认模式", func(t *testing.T) {
		p, err := loadIngestPatterns("")
		require.NoError(t, err)
		require.NotNil(t, p)
		assert.True(t, p.isDocFilePath("readme.md"))
		assert.True(t, p.isCodeFilePath("main.go"))
	})

	t.Run("显式缺失路径坚决报错", func(t *testing.T) {
		badPath := filepath.Join(t.TempDir(), "nonexistent-patterns.json")
		p, err := loadIngestPatterns(badPath)
		require.Error(t, err)
		assert.Nil(t, p)
		assert.Contains(t, err.Error(), "[chapter] explicit ingest patterns path")
	})
}
