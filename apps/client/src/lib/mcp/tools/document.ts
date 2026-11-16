/**
 * repo-tools document 域：向下兼容门面（read_document 兼容委托）。
 * 职责：平滑桥接历史 read_document 调用至第一性原理的 outline 与 read 原语，
 * 保持历史导出符号零破坏，零代码漂移。
 */
import { RepoRuntime } from './shared';
import { runOutline, formatNavTree, findDocInContext } from './outline';
import { runRead, capFullDocText, fetchDocumentContent } from './read';

// ── 向下兼容导出符号（供 server.ts 及 repo-tools.ts 消费） ──
export {
  runOutline,
  formatNavTree,
  findDocInContext,
  runRead,
  capFullDocText,
  fetchDocumentContent,
};

/**
 * 兼容历史的 read_document 调用：
 * - 当无 path 且无 section：自动路由到 runOutline（轻量导航树，消除 2000 个 Chunk 撑爆隐患）
 * - 当有 path 或 section：自动路由到 runRead（单一精准抓取）
 */
export async function runReadDocument(
  args: { repository?: string; path?: string; section?: string },
  runtime: RepoRuntime,
  telemetryId?: string
) {
  if (args.section) {
    const target = args.section.includes('#')
      ? args.section
      : args.path
      ? `${args.path}#${args.section}`
      : args.section;
    return runRead({ repository: args.repository, target }, runtime, telemetryId);
  }
  if (args.path) {
    return runRead({ repository: args.repository, target: args.path }, runtime, telemetryId);
  }
  return runOutline({ repository: args.repository }, runtime, telemetryId);
}
