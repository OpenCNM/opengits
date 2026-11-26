package transcription

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBodyStoreSQLSemantics(t *testing.T) {
	srcBytes, err := os.ReadFile("body_store.go")
	require.NoError(t, err)
	code := string(srcBytes)

	t.Run("checkpoint content must be JSON string scalar, never raw cast", func(t *testing.T) {
		block := sqlQueryBlock(t, "TranscriptionCheckpointSave")
		assert.Contains(t, block, "to_jsonb(@content::text)",
			"Markdown 正文必须经 to_jsonb(@content::text) 转为 JSON String 标量")
		assert.NotContains(t, block, "@content::jsonb",
			"禁止把纯文本直接强转为 ::jsonb")
		assert.NotContains(t, code, "$5::jsonb",
			"$5::jsonb 强转会把纯文本当 JSON 结构解析，断点存档全灭")
	})

	t.Run("CasProcessing accepts enqueue-preset PROCESSING and conditional PROCESSED", func(t *testing.T) {
		assert.Contains(t, code, "DocStatusUnprocessed, DocStatusError, DocStatusProcessing")
		assert.Contains(t, code, "sources = append(sources, DocStatusProcessed)")
		block := sqlQueryBlock(t, "TranscriptionCasProcessing")
		assert.Contains(t, block, "WHERE id = @document_id::text AND status::text = ANY(@sources::text[])")
		assert.NotContains(t, block, "status != 'PROCESSING'")
		assert.NotContains(t, block, "IN ('PROCESSED'")
	})

	t.Run("HeartbeatDocument refreshes both Document and TranscriptionJob updatedAt", func(t *testing.T) {
		block := sqlQueryBlock(t, "TranscriptionHeartbeatDocument")
		assert.Contains(t, block, `UPDATE "Document" SET "updatedAt" = now() WHERE id = $1`,
			"HeartbeatDocument 必须更新 Document 的 updatedAt")
		assert.Contains(t, strings.ToLower(block), `update "transcriptionjob" set "updatedat" = now()`,
			"HeartbeatDocument 必须原子同步刷新 TranscriptionJob 的 updatedAt")
		assert.Contains(t, block, `WHERE "documentId" = $1 AND "status" = 'RUNNING'`,
			"HeartbeatDocument 刷新租约时必须限定 RUNNING 状态与 documentId")
	})
}

func TestReapStaleTranscriptionJobsSQLSemantics(t *testing.T) {
	srcBytes, err := os.ReadFile("store.go")
	require.NoError(t, err)
	assert.Contains(t, string(srcBytes), "s.queries.TranscriptionReapStaleJobs(")

	block := sqlQueryBlock(t, "TranscriptionReapStaleJobs")

	t.Run("ReapStaleTranscriptionJobs must increment attempts and isolate poison pills", func(t *testing.T) {
		assert.Contains(t, block, `attempts = "TranscriptionJob".attempts + 1`,
			"孤儿任务收割必须严格递增 attempts，杜绝毒丸崩溃无限重试")
		assert.Contains(t, block, "s.attempts + 1 < 3",
			"重试次数未达上限必须回队列重试")
		assert.Contains(t, block, "s.attempts + 1 >= 3",
			"重试次数超限必须触发熔断")
		assert.Contains(t, block, `SET "status" = 'FAILED'`,
			"重试耗尽任务必须置为 FAILED")
		assert.Contains(t, block, `UPDATE "Document"`,
			"任务 FAILED 必须级联更新关联 Document，解除前端假死")
		assert.Contains(t, block, `SET status = 'ERROR'`,
			"级联更新必须将 Document status 置为 ERROR")
		assert.Contains(t, block, `"Document".status != 'PROCESSED'`,
			"级联更新不得覆盖已完成 (PROCESSED) 的文档")
		assert.Contains(t, block, `"claimedAt" = NULL`,
			"重入队列的任务必须清空 claimedAt 租约")
	})
}
