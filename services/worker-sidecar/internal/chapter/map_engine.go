package chapter

// ─────────────────────────────────────────────────────────────
// 章节映射确定性引擎（M01 教材分流）：
//
// 架构地位：Go worker-sidecar 为系统唯一的确定性章节结构计算单一事实源（SSOT）。
// 契约冻结：行为由 testdata/chapter-map.golden.json 黄金夹具锁定。
// TS 侧（apps/client/src/engine/chapter-map.ts）仅持有跨端数据模型与 LLM 提示词 Schema。
//
// 领域正交拆解：
// 1. types.go:        数据模型（ChapterMapNode, ChapterMapEntry, OrderSignal 等）与常数
// 2. patterns.go:     正则与模式注册表（ingestPatterns, loadIngestPatterns, 文件扩展名分类）
// 3. compare.go:      纯算法字典排序（NaturalCompare 自然序, JsLocaleCompare 字典序）
// 4. tree_index.go:   树多重索引与 TOC 侧车扫描（chapterTreeIndex, parseMarkdownLinkSequence, FindTocSidecarPath）
// 5. order_signal.go: 顺序信号探测策略族（orderSignalStrategy 接口, TOC / README / 数字前缀策略）
// 6. candidates.go:   候选集扫描与教材判定（BuildChapterCandidates, ChapterMapFromSidecar, IsTextbookRepoSignal）
// 7. validator.go:    防幻觉校验管道（chapterMapValidationPipeline, decodeRawChapters, ValidateChapterMap）
// ─────────────────────────────────────────────────────────────
