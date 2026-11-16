/**
 * apps/client/src/engine/ingest/symbol-extractor.ts
 *
 * Tier 2 AST 符号与依赖契约定义。
 *
 * 符号与依赖提取计算已全量下沉至 Go worker-sidecar（rsg_symbol_extractor.go，POST /v1/symbols/extract）。
 * 本文件仅保留纯 TypeScript 契约接口，供 graph-store 与语义图谱模块使用。
 * （2026-11 死代码清算：ImportRecord/CallSite/AstExtraction 契约随 parser.ts
 * 物理删除后已悬空，Go rsg.FileAstExtraction 接管，一并移除。）
 */

export interface SymbolEntry {
  name: string;
  kind: 'function' | 'type';
  startLine: number;
  endLine: number;
  exported: boolean;
  /** Set by the graph builder when the symbol ranks in the golden-symbol tier. */
  golden?: boolean;
  /** Distinct files importing this symbol (golden-tier metadata). */
  importers?: number;
}
