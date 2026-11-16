package mcp

// ─────────────────────────────────────────────────────────────
// MCP 行为可调参数（golden 分层：本层是「行为参数」而非「数据兼容键」）。
//
// 分层规则（详见 NODE_MIGRATION_DEGRADATION_AUDIT.md §14）：
// - 数据兼容键（slug/URL/hash/内容寻址）：必须字节稳定，golden 永久锁定；
// - 行为参数（本文件）：Go 单实现后的产品所有权参数，改值是显式产品决策
//   （连带更新引用单测），不构成 golden 契约破坏。历史值多为 Node 对拍
//   迁入（BUG-62 等）——迁移已完成，值的所有权在 Go。
// ─────────────────────────────────────────────────────────────

// DefaultSearchTokenBudget search/read 工具缺省 token 预算。
// 历史：Node check_breaking_changes/search 曾为 1M，对拍修正为 4000（BUG-62）。
const DefaultSearchTokenBudget = 4000.0

// SearchFetchLimit 检索工具单次取回条数（含并列弱命中比较位）。
// 历史：Node 全档 limit=6，Go 曾为 5 丢第 6 位命中（BUG-62）。
const SearchFetchLimit = 6
