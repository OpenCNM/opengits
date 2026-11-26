package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidateFixtureDraft_TableDriven(t *testing.T) {
	tests := []struct {
		name    string
		draft   fixtureDraft
		wantErr string
	}{
		{
			name: "合法拓扑通过（含无扩展名脚本与配置）",
			draft: fixtureDraft{Name: "ok-repo", Files: []fixtureFile{
				{Path: "buf.yaml", Loc: 20, IsConfig: true},
				{Path: "proto/api/user.proto", Loc: 120, Lang: "proto"},
				{Path: "tools/gen.sh", Loc: 40},
			}},
		},
		{
			name:    "空文件列表拒绝",
			draft:   fixtureDraft{Name: "empty", Files: []fixtureFile{}},
			wantErr: "files 为空",
		},
		{
			name: "绝对路径拒绝",
			draft: fixtureDraft{Name: "abs", Files: []fixtureFile{
				{Path: "/etc/passwd", Loc: 10},
			}},
			wantErr: "首/尾/连续斜杠",
		},
		{
			name: "相对段拒绝",
			draft: fixtureDraft{Name: "escape", Files: []fixtureFile{
				{Path: "src/a.ts", Loc: 10},
				{Path: "../escape.ts", Loc: 10},
			}},
			wantErr: "相对段",
		},
		{
			name: "重复路径拒绝",
			draft: fixtureDraft{Name: "dup", Files: []fixtureFile{
				{Path: "src/a.ts", Loc: 10},
				{Path: "src/a.ts", Loc: 5},
			}},
			wantErr: "重复路径",
		},
		{
			name: "同名冲突拒绝（相邻形态）",
			draft: fixtureDraft{Name: "conflict", Files: []fixtureFile{
				{Path: "src", Loc: 10},
				{Path: "src/index.ts", Loc: 10},
			}},
			wantErr: "同名冲突",
		},
		{
			name: "同名冲突拒绝（排序盲区形态：a!b 隔开冲突对）",
			draft: fixtureDraft{Name: "gap", Files: []fixtureFile{
				{Path: "a", Loc: 10},
				{Path: "a!b", Loc: 10},
				{Path: "a/b", Loc: 10},
			}},
			wantErr: "同名冲突",
		},
		{
			name: "深层祖先冲突拒绝（a/b vs a/b/c/d）",
			draft: fixtureDraft{Name: "deep", Files: []fixtureFile{
				{Path: "a/b", Loc: 10},
				{Path: "a/b/c/d", Loc: 10},
			}},
			wantErr: "同名冲突",
		},
		{
			name: "反斜杠拒绝",
			draft: fixtureDraft{Name: "win", Files: []fixtureFile{
				{Path: `src\evil.ts`, Loc: 10},
			}},
			wantErr: "反斜杠",
		},
		{
			name: "非法 name（含斜杠）拒绝",
			draft: fixtureDraft{Name: "a/b", Files: []fixtureFile{
				{Path: "a.ts", Loc: 10},
			}},
			wantErr: "name 非法",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files, err := validateFixtureDraft(&tt.draft)
			if tt.wantErr == "" {
				require.NoError(t, err)
				assert.Len(t, files, len(tt.draft.Files))
				for i := 1; i < len(files); i++ {
					assert.Less(t, files[i-1].Path, files[i].Path, "输出必须字典序")
				}
			} else {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
			}
		})
	}
}
