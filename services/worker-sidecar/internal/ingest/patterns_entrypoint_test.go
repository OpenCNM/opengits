package ingest

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// IsEntryPoint 前缀只对 basename 生效：全路径 Contains 的旧实现
// 会让 homepage.md（含 "page."）/myapp.ts（含 "app."）误判为入口文件，
// 打乱模块文件排序（入口置顶语义）。
func TestIsEntryPointBasenamePrefix(t *testing.T) {
	p := DefaultPatterns()

	tests := []struct {
		name string
		path string
		want bool
	}{
		{name: "exact entry file", path: "src/app.js", want: true},
		{name: "basename prefix app.", path: "src/app.module.ts", want: true},
		{name: "basename prefix index.", path: "packages/lib/index.ts", want: true},
		{name: "homepage.md is NOT an entry", path: "docs/homepage.md", want: false},
		{name: "myapp.ts is NOT an entry", path: "web/myapp.ts", want: false},
		{name: "remain.txt is NOT an entry", path: "notes/remain.txt", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, p.IsEntryPoint(tt.path))
		})
	}
}
