package transcription

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 🧪 D3-2/D3-4 SQL 语义防退化锚点（源码级断言，模式同 update.TestImportRecordTristateSemantics）：
// CheckpointSave 与 CasProcessing 的两处历史缺陷曾在 UTC 容器测试下全绿。
func TestBodyStoreSQLSemantics(t *testing.T) {
	srcBytes, err := os.ReadFile("body_store.go")
	require.NoError(t, err)
	src := string(srcBytes)
	// 否定断言仅作用于剥离注释后的源码（注释中引用旧模式作历史说明是合法的）
	var codeOnly strings.Builder
	for _, line := range strings.Split(src, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") {
			continue
		}
		if idx := strings.Index(line, " // "); idx >= 0 {
			line = line[:idx]
		}
		codeOnly.WriteString(line + "\n")
	}
	code := codeOnly.String()

	t.Run("checkpoint content must be JSON string scalar, never raw cast", func(t *testing.T) {
		assert.Contains(t, src, "to_jsonb($5::text)",
			"Markdown 正文必须经 to_jsonb($5::text) 转为 JSON String 标量")
		assert.NotContains(t, code, "$5::jsonb",
			"$5::jsonb 强转会把纯文本当 JSON 结构解析——任何非 JSON 正文必报 invalid input syntax，断点存档全灭")
	})

	t.Run("CasProcessing accepts enqueue-preset PROCESSING but never PROCESSED", func(t *testing.T) {
		// 入队端(transcription-queue)预置 PROCESSING(防前端轮询回退),
		// CAS 必须放行之,否则正常入队恒静默空转(2026-09-20 转录 E2E 锁定);
		// 真不变量 = 永不 PROCESSED→PROCESSING 逆向退化(迟到重试抹成品)
		assert.Contains(t, src, "'UNPROCESSED', 'ERROR', 'PROCESSING'",
			"CAS 源状态必须含入队预置的 PROCESSING")
		assert.Contains(t, src, "sources += `, 'PROCESSED'`",
			"enhance(ForceEnhance)必须能放行 PROCESSED——否则读者端强制重生成被 CAS 永拦")
		assert.NotContains(t, code, "status != 'PROCESSING'",
			"!= 'PROCESSING' 允许 PROCESSED→PROCESSING 逆向退化，迟到重试会抹掉已完成正文")
		assert.NotContains(t, code, "IN ('PROCESSED'",
			"PROCESSED 永不作 CAS 源状态——成品不可被迟到执行者覆盖")
	})

	t.Run("HeartbeatDocument refreshes both Document and TranscriptionJob updatedAt", func(t *testing.T) {
		assert.Contains(t, src, `UPDATE "Document" SET "updatedAt" = now() WHERE id = $1`,
			"HeartbeatDocument 必须更新 Document 的 updatedAt")
		assert.Contains(t, src, `UPDATE "TranscriptionJob" SET "updatedAt" = now()`,
			"HeartbeatDocument 必须原子同步刷新 TranscriptionJob 的 updatedAt，消除长推理租约误杀孤岛")
		assert.Contains(t, src, `WHERE "documentId" = $1 AND "status" = 'RUNNING'`,
			"HeartbeatDocument 刷新租约时必须限定 RUNNING 状态与 documentId")
	})
}

// 🧪 死人开关毒丸防御（Poison Pill Defense）SQL 语义防退化测试
func TestReapStaleTranscriptionJobsSQLSemantics(t *testing.T) {
	srcBytes, err := os.ReadFile("store.go")
	require.NoError(t, err)
	src := string(srcBytes)

	t.Run("ReapStaleTranscriptionJobs must increment attempts and isolate poison pills", func(t *testing.T) {
		assert.Contains(t, src, "attempts = j.attempts + 1",
			"孤儿任务收割必须严格递增 attempts，杜绝毒丸崩溃无限重试")
		assert.Contains(t, src, "s.attempts + 1 < 3",
			"重试次数未达上限必须回队列重试")
		assert.Contains(t, src, "s.attempts + 1 >= 3",
			"重试次数超限必须触发熔断")
		assert.Contains(t, src, `SET "status" = 'FAILED'`,
			"重试耗尽任务必须置为 FAILED")
		assert.Contains(t, src, `UPDATE "Document" d`,
			"任务 FAILED 必须级联更新关联 Document，解除前端假死")
		assert.Contains(t, src, `SET status = 'ERROR'`,
			"级联更新必须将 Document status 置为 ERROR")
		assert.Contains(t, src, `d.status != 'PROCESSED'`,
			"级联更新不得覆盖已完成 (PROCESSED) 的文档")
		assert.Contains(t, src, `"claimedAt" = NULL`,
			"重入队列的任务必须清空 claimedAt 租约")
	})
}
