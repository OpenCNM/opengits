package filecache

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func writeObj(t *testing.T, path, content string) {
	t.Helper()
	require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
}

func TestFileObjectCache(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T)
	}{
		{
			name: "命中与未命中",
			run: func(t *testing.T) {
				dir := t.TempDir()
				f := filepath.Join(dir, "a.json")
				writeObj(t, f, "v1")
				c := New[*string](4)
				v := "hello"
				c.Put(f, &v)

				got, ok := c.Get(f)
				require.True(t, ok)
				assert.Equal(t, "hello", *got)

				_, ok = c.Get(filepath.Join(dir, "missing.json"))
				assert.False(t, ok, "不存在的文件不得命中")
			},
		},
		{
			name: "覆写失效（mtime/size 校验自愈）",
			run: func(t *testing.T) {
				dir := t.TempDir()
				f := filepath.Join(dir, "head.json")
				writeObj(t, f, "old")
				c := New[*string](4)
				v := "old-obj"
				c.Put(f, &v)

				time.Sleep(10 * time.Millisecond)
				writeObj(t, f, "new")

				_, ok := c.Get(f)
				assert.False(t, ok, "文件被覆写后条目必须失效")
			},
		},
		{
			name: "LRU 容量淘汰",
			run: func(t *testing.T) {
				dir := t.TempDir()
				c := New[*int](2)
				files := make([]string, 3)
				for i := range files {
					files[i] = filepath.Join(dir, string(rune('a'+i))+".json")
					writeObj(t, files[i], "x")
					v := i
					c.Put(files[i], &v)
				}
				require.Equal(t, 2, c.Len(), "超容后只保留 2 条")
				_, ok := c.Get(files[0])
				assert.False(t, ok, "最久未用的 a 应被淘汰")
				_, ok = c.Get(files[2])
				assert.True(t, ok, "最新写入的 c 应保留")
			},
		},
		{
			name: "Put 前无法 stat 的文件不入缓存",
			run: func(t *testing.T) {
				c := New[*int](2)
				v := 1
				c.Put(filepath.Join(t.TempDir(), "ghost.json"), &v)
				assert.Equal(t, 0, c.Len())
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, tt.run)
	}
}
