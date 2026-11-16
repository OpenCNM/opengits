/**
 * scout 管道调参常量（集中定义，禁止在管道逻辑里散落魔法数字）。
 * （2026-11 死代码清算：退役的「目录采样 + LLM 竞速裁决」探测链常量已移除，
 * 该职责收敛进 Go scout inspect 与 ingest-mode-arbiter。）
 */

/** 探测限流：SSE 自定义 handler 无法走 defineRoute 包装，路由层手动接入限流器（次/分钟） */
export const SCOUT_RATE_LIMIT_PER_MINUTE = 10;
export const SCOUT_RATE_LIMIT_WINDOW_MS = 60_000;

/** 粗粒度 token 估算系数（按字节，不代表 tokenizer 精确值） */
export const ESTIMATED_TOKENS_PER_BYTE = 0.3;

/** 候选目录进入推荐列表的最小 markdown 文件数 */
export const TOP_DIR_MIN_MARKDOWN_COUNT = 3;
