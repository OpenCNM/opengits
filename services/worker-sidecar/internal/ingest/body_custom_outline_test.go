package ingest

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestBuildSnapshotsFromCustomOutline_RenumberOnSkippedEmpty 验证自定义大纲跳过空分类时章节号与标题自动连续递增重编号。
func TestBuildSnapshotsFromCustomOutline_RenumberOnSkippedEmpty(t *testing.T) {
	categories := []CustomOutlineCategory{
		{
			Name: "第 1 章：环境与准备",
			Files: []CustomOutlineFile{
				{Path: "README.md"},
			},
		},
		{
			Name:  "第 2 章：空章节",
			Files: []CustomOutlineFile{}, // 空文件列表，将被跳过
		},
		{
			Name: "第 3 章：核心架构实现",
			Files: []CustomOutlineFile{
				{Path: "core/engine.go"},
			},
		},
		{
			Name: "第 5 章：网络层设计", // 原本跳过第 4 章
			Files: []CustomOutlineFile{
				{Path: "net/client.go"},
			},
		},
	}

	scopeBlobSet := map[string]bool{
		"README.md":      true,
		"core/engine.go": true,
		"net/client.go":  true,
	}

	snapshots := buildSnapshotsFromCustomOutline(categories, nil, scopeBlobSet)
	require.Len(t, snapshots, 3, "空章节被跳过，应生成 3 个快照")

	assert.Equal(t, 1, snapshots[0].ChapterNo)
	assert.Equal(t, 1, snapshots[0].TeachingOrder)
	assert.Equal(t, "第 1 章：环境与准备", snapshots[0].Title)

	assert.Equal(t, 2, snapshots[1].ChapterNo)
	assert.Equal(t, 2, snapshots[1].TeachingOrder)
	assert.Equal(t, "第 2 章：核心架构实现", snapshots[1].Title, "原第 3 章因前序有空章，应重编号为第 2 章")

	assert.Equal(t, 3, snapshots[2].ChapterNo)
	assert.Equal(t, 3, snapshots[2].TeachingOrder)
	assert.Equal(t, "第 3 章：网络层设计", snapshots[2].Title, "原第 5 章应连续重编号为第 3 章")
}
