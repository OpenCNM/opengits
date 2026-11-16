package transcription

// ─────────────────────────────────────────────────────────────
// Document 物理状态常量（与 Prisma enum DocumentStatus 逐字同步）。
// transcription 包内所有文档状态回写/比较的单一取值点，
// 杜绝散落字面量（此前 body_store/strategy 共 5 处裸 "ERROR"/"UNPROCESSED"）。
// ─────────────────────────────────────────────────────────────

const (
	// DocStatusUnprocessed 未处理（可认领）
	DocStatusUnprocessed = "UNPROCESSED"
	// DocStatusProcessing 转录中（占位防闪烁/在途）
	DocStatusProcessing = "PROCESSING"
	// DocStatusProcessed 转录完成（物理终态，不可逆）
	DocStatusProcessed = "PROCESSED"
	// DocStatusError 失败（可 reset 回 Unprocessed 重试）
	DocStatusError = "ERROR"
)
