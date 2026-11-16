package transcription

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─────────────────────────────────────────────────────────────
// TranscriptionJob 死信回收与认领竞态 SQL 物理锚点（源锚点模式，无 DB 依赖）。
// 物理事实（store.go 注释与 transcription.sql 契约）：
// - 无独立心跳字段——Dead Man's Switch 以 COALESCE(updatedAt, claimedAt)
//   判死，TRANSCRIPTION_STALE_MS 必须 > MaxWallMs；
// - 迟到 DONE 拒绝：CompleteJob 的 status='RUNNING' 守卫（BUG-42 同族）；
// - reap 双分支：attempts+1 < 3 回 QUEUED 保留 checkpoint 断点续跑；
//   达上限转 FAILED 并级联 Document=ERROR（不覆盖已完工文档）。
// ─────────────────────────────────────────────────────────────

// sqlQueryBlock 提取 sqlc 查询块（`-- name: <name>` 起至下一查询或 EOF）。
func sqlQueryBlock(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "queries", "transcription.sql"))
	require.NoError(t, err, "读取 transcription.sql 失败")
	src := string(data)
	i := strings.Index(src, "-- name: "+name)
	require.GreaterOrEqualf(t, i, 0, "查询 %s 不存在", name)
	block := src[i:]
	if j := strings.Index(block, "\n-- name: "); j >= 0 {
		block = block[:j]
	}
	return block
}

// sqlSection 截取块内两个标记之间的 CTE 片段。
func sqlSection(t *testing.T, block, from, to string) string {
	t.Helper()
	i := strings.Index(block, from)
	require.GreaterOrEqualf(t, i, 0, "片段起点 %s 不存在", from)
	rest := block[i:]
	if j := strings.Index(rest, to); j >= 0 {
		return rest[:j]
	}
	return rest
}

func TestTranscriptionCompleteJobGhostAnchor(t *testing.T) {
	block := sqlQueryBlock(t, "TranscriptionCompleteJob")
	t.Run("迟到 DONE 拒绝：仅 RUNNING 可完结（被抢占/回收后的僵尸写返回 0 行）", func(t *testing.T) {
		assert.Contains(t, block, `WHERE "id" = $1 AND "status" = 'RUNNING'`)
	})
	t.Run("完结即清除断点存档", func(t *testing.T) {
		assert.Contains(t, block, `"checkpointChunks" = NULL`)
	})
}

func TestTranscriptionClaimSkipLockedAnchor(t *testing.T) {
	block := sqlQueryBlock(t, "TranscriptionClaimNextJobs")
	t.Run("SKIP LOCKED 多消费者互斥（与 Node/多实例混跑安全）", func(t *testing.T) {
		assert.Contains(t, block, `FOR UPDATE OF q SKIP LOCKED`)
	})
	t.Run("仅领取 QUEUED 且未暂停的仓", func(t *testing.T) {
		assert.Contains(t, block, `q."status" = 'QUEUED'`)
		assert.Contains(t, block, `r."transcriptionPaused" = false`)
	})
	t.Run("饥饿加成：排队每分钟 priority +1（防高优任务饿死低优长队）", func(t *testing.T) {
		assert.Contains(t, block, `EXTRACT(EPOCH FROM (NOW() - q."createdAt")) / 60`)
	})
	t.Run("同仓串行（repo_rank 分区内最旧优先）", func(t *testing.T) {
		assert.Contains(t, block, `repo_rank`)
	})
}

func TestTranscriptionReapStaleJobsAnchor(t *testing.T) {
	block := sqlQueryBlock(t, "TranscriptionReapStaleJobs")
	t.Run("Dead Man's Switch 判死谓词：无心跳字段，以 updatedAt/claimedAt 兜底", func(t *testing.T) {
		assert.Contains(t, block, `COALESCE("TranscriptionJob"."updatedAt", "TranscriptionJob"."claimedAt") < $1`)
		assert.Contains(t, block, `"TranscriptionJob"."status" = 'RUNNING'`)
	})

	requeued := sqlSection(t, block, "requeued_jobs AS (", "failed_jobs AS (")
	t.Run("未达上限回 QUEUED：attempts+1 < 3 且清 claimedAt 供重新认领", func(t *testing.T) {
		assert.Contains(t, requeued, `s.attempts + 1 < 3`)
		assert.Contains(t, requeued, `SET "status" = 'QUEUED'`)
		assert.Contains(t, requeued, `"claimedAt" = NULL`)
	})
	t.Run("回队保留 checkpoint（断点续跑，不白烧已完成的分块）", func(t *testing.T) {
		assert.NotContains(t, requeued, "checkpointChunks")
	})

	failed := sqlSection(t, block, "failed_jobs AS (", "failed_docs AS (")
	t.Run("死信分支：attempts+1 >= 3 → FAILED + 3 次重试上限文案", func(t *testing.T) {
		assert.Contains(t, failed, `s.attempts + 1 >= 3`)
		assert.Contains(t, failed, `SET "status" = 'FAILED'`)
		assert.Contains(t, failed, `'Stale execution lease expired (exceeded 3 retry attempts)'`)
	})

	docs := sqlSection(t, block, "failed_docs AS (", "SELECT ((")
	t.Run("文档级联置 ERROR 但不覆盖已完工文档", func(t *testing.T) {
		assert.Contains(t, docs, `SET status = 'ERROR'`)
		assert.Contains(t, docs, `'Transcription job timed out after 3 retry attempts'`)
		assert.Contains(t, docs, `AND "Document".status != 'PROCESSED'`)
	})
}

func TestTranscriptionFailAndDeferAnchors(t *testing.T) {
	t.Run("崩溃兜底置败同样受 attempts+1 >= 3 上限守卫", func(t *testing.T) {
		block := sqlQueryBlock(t, "TranscriptionFailJobExhausted")
		assert.Contains(t, block, `attempts + 1 >= 3`)
		assert.Contains(t, block, `AND "status" = 'RUNNING'`)
	})
	t.Run("Defer 回队不计 attempts（限流让位非失败）", func(t *testing.T) {
		block := sqlQueryBlock(t, "TranscriptionDeferJob")
		assert.Contains(t, block, `AND "status" = 'RUNNING'`)
		assert.NotContains(t, block, "attempts =")
	})
}
