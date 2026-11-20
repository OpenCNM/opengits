/**
 * 统一遥测事件契约与生命周期事件注册表 (Telemetry Event Registry & Contracts)
 *
 * 遵循非侵入式架构与强类型规范：
 * - 覆盖用户从进入、导入、等待、流失、激活到长线留存的完整旅程
 * - 包含等待时长、分阶段耗时、异常归因与 TTV 价值里程碑
 */

export const TELEMETRY_EVENTS = {
  // 1. 基础交互与阅读事件
  PAGE_VIEW: 'PAGE_VIEW',
  SECTION_FOCUS: 'SECTION_FOCUS',
  TEXT_HIGHLIGHT: 'TEXT_HIGHLIGHT',
  CODE_COPY: 'CODE_COPY',
  RAGE_CLICK: 'RAGE_CLICK',
  IDLE_ZONEOUT: 'IDLE_ZONEOUT',
  CONTENT_SKIP: 'CONTENT_SKIP',
  QUIZ_INTERACTION: 'QUIZ_INTERACTION',
  SCROLL_PROGRESS: 'SCROLL_PROGRESS',

  // 2. 导入与建库旅程事件 (Import Journey Lifecycle)
  IMPORT_INITIATED: 'IMPORT_INITIATED',         // 用户输入 URL 发起解析
  IMPORT_SCOUT_COMPLETED: 'IMPORT_SCOUT_COMPLETED', // 大纲/目录勘测成功
  IMPORT_INGEST_STARTED: 'IMPORT_INGEST_STARTED',   // 确认大纲，进入转录生成等待
  IMPORT_INGEST_COMPLETED: 'IMPORT_INGEST_COMPLETED', // 转录生成全部完成
  IMPORT_ABANDONED: 'IMPORT_ABANDONED',         // 用户在等待中途中止/关闭/跳出
  OUTLINE_TREE_GENERATED: 'OUTLINE_TREE_GENERATED', // P4 灰度:统一树大纲生成成功(depth/章/课/幻觉/耗时)
  OUTLINE_DEEPENING_CLICKED: 'OUTLINE_DEEPENING_CLICKED', // 探查档位点击(深入/变浅)：Phase 3 用户揭示需求证据(level/direction/capped)

  // 3. 激活与留存事件 (Activation & Retention)
  FIRST_CHAPTER_READ: 'FIRST_CHAPTER_READ',     // 首次打开章节并有效阅读（达成 TTV）
  AI_CHAT_ENGAGED: 'AI_CHAT_ENGAGED',           // 在文档伴读中与太极智引 AI 交互
  REPO_SAVED: 'REPO_SAVED',                     // 收藏仓库到个人书架
  MCP_TOOL_CALL: 'MCP_TOOL_CALL',               // MCP 工具调用
  CLIENT_ERROR: 'CLIENT_ERROR',                 // 前端渲染边界捕获的异常（error.tsx / global-error.tsx）

  // 4. 上游更新漏斗事件 (Upstream Update Funnel)
  UPSTREAM_TOAST_IMPRESSION: 'UPSTREAM_TOAST_IMPRESSION', // 更新浮动 Toast 曝光展示
  UPSTREAM_TOAST_DISMISSED: 'UPSTREAM_TOAST_DISMISSED',   // 用户主动关闭 Toast
  UPSTREAM_TOAST_VIEW_PLAN: 'UPSTREAM_TOAST_VIEW_PLAN',   // 用户点击「查看」打开更新计划
  UPSTREAM_UPDATE_APPLIED: 'UPSTREAM_UPDATE_APPLIED',     // 用户确认并实际触发了全仓更新同步
} as const;

export type TelemetryEventType = (typeof TELEMETRY_EVENTS)[keyof typeof TELEMETRY_EVENTS] | (string & {});

/**
 * 导入放弃/流失阶段枚举
 */
export type ImportAbandonStage = 'input' | 'scout_loading' | 'directory_confirm' | 'outline_draft' | 'ingesting';

/**
 * 导入放弃原因分类
 */
export type ImportAbandonReason =
  | 'USER_CANCELLED'   // 主动点击关闭/取消按钮
  | 'NAVIGATE_AWAY'    // 页面跳转/返回
  | 'TAB_CLOSED'       // 标签页关闭/刷新 (beforeunload)
  | 'ERROR_DROPOFF'    // 遇到报错后离开
  | 'TIMEOUT_DROPOFF'; // 超时无响应离开

// （2026-11 死代码清算：7 个纯文档型 Metadata 接口已移除——各事件的 payload
//  以字面量对象直传 trackEvent，接口从未被引用；事件枚举面本身保持双端白名单对齐。）
