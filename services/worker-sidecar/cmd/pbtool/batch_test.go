package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadBatchCheckpoint_TableDriven(t *testing.T) {
	tests := []struct {
		name    string
		content string
		wantLen int
	}{
		{name: "文件缺失 → 空", content: "", wantLen: 0},
		{name: "合法 JSON null → 空（nil map 防御）", content: "null", wantLen: 0},
		{name: "损坏 JSON → 空", content: "{broken", wantLen: 0},
		{name: "空对象 → 空", content: "{}", wantLen: 0},
		{
			name:    "合法 map → 原样加载",
			content: `{"repo-a|fake|false|zh-CN": {"repo": "repo-a", "pipelineBStatus": "ok"}}`,
			wantLen: 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "m.ckpt.json")
			if tt.content != "" {
				require.NoError(t, os.WriteFile(path, []byte(tt.content), 0o644))
			}
			got := loadBatchCheckpoint(path)
			assert.Len(t, got, tt.wantLen)
			if got != nil {
				got["probe"] = map[string]any{"k": "v"}
			} else if tt.wantLen == 0 {
				t.Fatal("loadBatchCheckpoint 返回 nil map——后续写入将 panic")
			}
		})
	}
}

func TestBatchCkptKey_KeyDimensions(t *testing.T) {
	base := batchRepo{Dir: "/tmp/r", Name: "demo", Mode: "fake", Depth2: false}
	zh := batchCkptKey(base, "zh-CN")
	assert.Equal(t, zh, batchCkptKey(base, "zh-CN"), "同参数键必须稳定")
	assert.NotEqual(t, zh, batchCkptKey(base, "en"), "换语言必须换键")
	assert.NotEqual(t, zh, batchCkptKey(batchRepo{Dir: "/tmp/r", Name: "demo", Mode: "real", Depth2: false}, "zh-CN"), "换 mode 必须换键")
	assert.NotEqual(t, zh, batchCkptKey(batchRepo{Dir: "/tmp/r", Name: "demo", Mode: "fake", Depth2: true}, "zh-CN"), "换 depth2 必须换键")
}
