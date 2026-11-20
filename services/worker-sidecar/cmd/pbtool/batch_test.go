package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─────────────────────────────────────────────────────────────
// checkpoint 加载容错回归（Table-Driven）。
//
// 起因：checkpoint 内容为合法 JSON null 时 Unmarshal 成功但 map 为 nil，
// 后续写入曾直接 panic（round-2 交叉验收实锤）。本测试锁死四类边界：
// 缺失 / null / 损坏 / 合法——前三类一律视为空全量重跑，绝不带病使用。
// ─────────────────────────────────────────────────────────────
func TestLoadBatchCheckpoint_TableDriven(t *testing.T) {
	tests := []struct {
		name    string
		content string // 空 = 不创建文件
		wantLen int    // 期望加载到的已完成仓数
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
			// 返回值必须可写（nil map 防御的核心断言：绝不下发 nil map）
			if got != nil {
				got["probe"] = map[string]any{"k": "v"}
			} else if tt.wantLen == 0 {
				t.Fatal("loadBatchCheckpoint 返回 nil map——后续写入将 panic")
			}
		})
	}
}

// TestBatchCkptKey_KeyDimensions checkpoint 复合键维度契约：mode/depth2/lang
// 任一变更必须产生不同键（换语言重跑绝不静默复用错语结果）。
func TestBatchCkptKey_KeyDimensions(t *testing.T) {
	base := batchRepo{Dir: "/tmp/r", Name: "demo", Mode: "fake", Depth2: false}
	zh := batchCkptKey(base, "zh-CN")
	assert.Equal(t, zh, batchCkptKey(base, "zh-CN"), "同参数键必须稳定")
	assert.NotEqual(t, zh, batchCkptKey(base, "en"), "换语言必须换键")
	assert.NotEqual(t, zh, batchCkptKey(batchRepo{Dir: "/tmp/r", Name: "demo", Mode: "real", Depth2: false}, "zh-CN"), "换 mode 必须换键")
	assert.NotEqual(t, zh, batchCkptKey(batchRepo{Dir: "/tmp/r", Name: "demo", Mode: "fake", Depth2: true}, "zh-CN"), "换 depth2 必须换键")
}
