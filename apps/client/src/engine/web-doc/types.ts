/**
 * WebDoc 类型契约定义
 *
 * 抓取执行已下沉 Go worker-sidecar（internal/webdoc）；TS 侧仅保留
 * 差分探测（WebDocDiffResult）与 NavTree 结构化（NavNodeItem/DocumentItem）契约。
 * 零业务侵入：不耦合任何具体数据库模型，纯数据传递。
 */

export interface NavNodeItem {
  name: string;
  title: string;
  shortTitle?: string;
  type: 'file' | 'directory';
  path: string;
  url?: string;
  sourceUrl?: string;
  /** 当目录节点同时对应同名索引文档（如 chat-sdk.md 与 chat-sdk/reference.md 共存）时保留自身文档路径 */
  indexPath?: string;
  indexTitle?: string;
  indexUrl?: string;
  children?: NavNodeItem[];
}

export interface HeadingItem {
  level: number;
  text: string;
  id: string;
}

export interface DocumentItem {
  /** 相对路径，例如 "getting-started/installation.md" */
  path: string;
  /** 页面真实标题 */
  title: string;
  /** 提纯后的 MDX/Markdown 源码 */
  markdown: string;
  /** 页面来源原始绝对 URL */
  url: string;
  /** sha256 签名 (供上游增量去重对比与 CAS 内容寻址) */
  contentHash: string;
  /** 页面内提取的 H1~H6 大纲 */
  headings: HeadingItem[];
  /** 元数据 (如描述、作者、语言等) */
  metadata?: Record<string, unknown>;
}

export interface WebDocDiffResult {
  hasChanges: boolean;
  etag?: string;
  /** 本次解析到的最新 url→lastmod 映射（调用方持久化后作为下次差分基线；
   *  不回写会导致每次同步重复判定同一批页面为 update） */
  sitemapLastModMap?: Record<string, string>;
  /** sitemap 解析出的站点总页数（预期管理：maxPages 截断时提示用户） */
  totalPages?: number;
  pagesToAdd: string[];
  pagesToUpdate: string[];
  pagesToRemove: string[];
  totalChanged: number;
}
